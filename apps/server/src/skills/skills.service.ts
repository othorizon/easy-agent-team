import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  PushSkillRequest,
  SkillDetail,
  SkillInfo,
  SkillListQuery,
  SkillListResult,
  SkillSubscriber,
  SkillVersionInfo,
  SyncSkill,
  UpdateSkillRequest,
} from '@eat/shared';
import {
  isBlockScalarIndicator,
  parseSkillFrontmatter,
  PLATFORM_GUIDE_SLUG,
  PLATFORM_GUIDE_VERSION,
  platformGuideSyncSkill,
  SKILL_FILE_MAX_BYTES,
  SKILL_TOTAL_MAX_BYTES,
  skillBundleVersion,
  type SkillBundleItem,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { skills, skillSubscriptions, skillVersions, templateItems, users, userTemplateSelections } from '../db/schema';

type SkillRow = typeof skills.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** 一个 skill 的一个有效订阅者（内部结构，count 与明细共用同一份计算） */
interface SubscriberEntry {
  user: Pick<UserRow, 'id' | 'name' | 'email' | 'role'>;
  source: SkillSubscriber['source'];
  subscribedAt: Date | null;
}

/** 简易密钥泄漏扫描：平台 Token 形态与经典私钥头。宁缺毋滥，只拦高置信度的 */
const SECRET_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /eat_[0-9a-f]{48}/, label: '疑似平台访问 Token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: '私钥文件内容' },
  { re: /AKIA[0-9A-Z]{16}/, label: '疑似 AWS Access Key' },
];

function byteLen(s: string, encoding: 'utf8' | 'base64'): number {
  return encoding === 'base64' ? Math.floor((s.length * 3) / 4) : Buffer.byteLength(s, 'utf8');
}

@Injectable()
export class SkillsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /**
   * 可见性：team 全员；private 仅作者/管理员；
   * granted（经验沉淀用）= 作者/管理员/已被系统授予订阅的用户。
   */
  private canSee(skill: SkillRow, user: AuthUser, subs: Set<string>): boolean {
    if (skill.ownerId === user.id || user.role === 'admin') return true;
    // 捆绑的 skill 人人都要同步，自然人人可见（updateMeta 已保证捆绑必为 team，这里是兜底）
    if (skill.bundled) return true;
    if (skill.visibility === 'team') return true;
    if (skill.visibility === 'granted') return subs.has(skill.id);
    return false;
  }

  private canManage(skill: SkillRow, user: AuthUser): boolean {
    return skill.ownerId === user.id || user.role === 'admin';
  }

  private async getBySlug(slug: string): Promise<SkillRow> {
    const row = (await this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `Skill ${slug} 不存在` });
    return row;
  }

  private async subscribedSkillIds(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ skillId: skillSubscriptions.skillId })
      .from(skillSubscriptions)
      .where(and(eq(skillSubscriptions.userId, userId), eq(skillSubscriptions.excluded, false)));
    return new Set(rows.map((r) => r.skillId));
  }

  /** 用户主动排除的（模板派生）skill */
  private async excludedSkillIds(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ skillId: skillSubscriptions.skillId })
      .from(skillSubscriptions)
      .where(and(eq(skillSubscriptions.userId, userId), eq(skillSubscriptions.excluded, true)));
    return new Set(rows.map((r) => r.skillId));
  }

  /** 用户所选角色模板包含的 skill */
  private async templateSkillIds(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ itemId: templateItems.itemId })
      .from(userTemplateSelections)
      .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
      .where(and(eq(userTemplateSelections.userId, userId), eq(templateItems.itemType, 'skill')));
    return new Set(rows.map((r) => r.itemId));
  }

  /** 全部捆绑 skill 的 id（决策 37：对非管理员恒为订阅） */
  private async bundledSkillIds(): Promise<Set<string>> {
    const rows = await this.db.select({ id: skills.id }).from(skills).where(eq(skills.bundled, true));
    return new Set(rows.map((r) => r.id));
  }

  /**
   * 有效同步集合 = 订阅（含经验沉淀）∪（模板 − 排除）∪ 捆绑。
   * 捆绑对**非管理员**无条件生效，连「排除」标记也压过去；管理员不受捆绑影响，
   * 仍按自己的订阅记录算（决策 37）。
   */
  private async effectiveSkillIds(user: AuthUser): Promise<{ subs: Set<string>; effective: Set<string> }> {
    const [subs, template, excluded, bundled] = await Promise.all([
      this.subscribedSkillIds(user.id),
      this.templateSkillIds(user.id),
      this.excludedSkillIds(user.id),
      user.role === 'admin' ? Promise.resolve(new Set<string>()) : this.bundledSkillIds(),
    ]);
    const effective = new Set(subs);
    for (const id of template) if (!excluded.has(id)) effective.add(id);
    for (const id of bundled) effective.add(id);
    return { subs, effective };
  }

  /**
   * 一批 skill 各自的有效订阅者。人数与明细走同一份计算，避免两边口径不一致。
   *
   * 口径：手动/经验订阅（未排除）∪（模板选择 − 排除）∪ 捆绑覆盖的成员，且**只算启用中的用户**
   * ——禁用的用户登录不了、也不会 sync，算进人数会让「多少人在用」失真。
   */
  private async effectiveSubscribers(skillRows: SkillRow[]): Promise<Map<string, SubscriberEntry[]>> {
    const out = new Map<string, SubscriberEntry[]>();
    if (skillRows.length === 0) return out;
    const ids = skillRows.map((s) => s.id);
    const anyBundled = skillRows.some((s) => s.bundled);

    const [subRows, tplRows, activeUsers] = await Promise.all([
      this.db
        .select({
          skillId: skillSubscriptions.skillId,
          userId: skillSubscriptions.userId,
          source: skillSubscriptions.source,
          excluded: skillSubscriptions.excluded,
          createdAt: skillSubscriptions.createdAt,
        })
        .from(skillSubscriptions)
        .where(inArray(skillSubscriptions.skillId, ids)),
      this.db
        .select({ skillId: templateItems.itemId, userId: userTemplateSelections.userId })
        .from(userTemplateSelections)
        .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
        .where(and(eq(templateItems.itemType, 'skill'), inArray(templateItems.itemId, ids))),
      this.db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.status, 'active')),
    ]);

    const userById = new Map(activeUsers.map((u) => [u.id, u]));
    const members = anyBundled ? activeUsers.filter((u) => u.role !== 'admin') : [];

    for (const skill of skillRows) {
      const entries = new Map<string, SubscriberEntry>();
      const excluded = new Set<string>();
      for (const r of subRows) {
        if (r.skillId !== skill.id) continue;
        if (r.excluded) {
          excluded.add(r.userId);
          continue;
        }
        const u = userById.get(r.userId);
        if (u) entries.set(r.userId, { user: u, source: r.source, subscribedAt: r.createdAt });
      }
      for (const r of tplRows) {
        if (r.skillId !== skill.id || excluded.has(r.userId) || entries.has(r.userId)) continue;
        const u = userById.get(r.userId);
        if (u) entries.set(r.userId, { user: u, source: 'template', subscribedAt: null });
      }
      if (skill.bundled) {
        for (const u of members) {
          if (!entries.has(u.id)) entries.set(u.id, { user: u, source: 'bundled', subscribedAt: null });
        }
      }
      out.set(skill.id, [...entries.values()]);
    }
    return out;
  }

  private async subscriberCounts(skillRows: SkillRow[]): Promise<Map<string, number>> {
    const subs = await this.effectiveSubscribers(skillRows);
    return new Map([...subs].map(([id, list]) => [id, list.length]));
  }

  private toInfo(
    row: SkillRow,
    ownerName: string,
    user: AuthUser,
    subscribed: boolean,
    subscriberCount: number,
  ): SkillInfo {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      ownerId: row.ownerId,
      ownerName,
      visibility: row.visibility,
      allowHelp: row.allowHelp,
      source: row.source,
      currentVersion: row.currentVersion,
      bundled: row.bundled,
      subscribed,
      subscriptionLocked: row.bundled && user.role !== 'admin',
      subscriberCount,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** kind 筛选：可见性 / 捆绑 / 来源 三类状态合成的单选（控制台就是一个下拉） */
  private matchKind(row: SkillRow, kind: SkillListQuery['kind']): boolean {
    switch (kind) {
      case 'team':
        return row.visibility === 'team';
      case 'private':
        return row.visibility === 'private';
      case 'granted':
        return row.visibility === 'granted';
      case 'bundled':
        return row.bundled;
      case 'experience':
        return row.source === 'experience';
      default:
        return true;
    }
  }

  /**
   * 清单：先按可见性过滤（依赖当前用户的订阅集，故在应用层判），再按筛选条件过滤，最后分页。
   * 订阅人数只为**当前页**这几条算，不给整库算。
   */
  async list(user: AuthUser, query: SkillListQuery): Promise<SkillListResult> {
    const rows = await this.db
      .select({ skill: skills, ownerName: users.name })
      .from(skills)
      .innerJoin(users, eq(skills.ownerId, users.id))
      .orderBy(desc(skills.updatedAt));
    const { subs, effective } = await this.effectiveSkillIds(user);

    const keyword = query.q?.toLowerCase() ?? '';
    // 先按可见性 / 关键词 / kind 收窄，在这个集合上数各 scope 的条数，最后才按 scope 过滤：
    // 分段切换上的数字要回答「在当前搜索与类型下，切到那个范围会有几条」，scope 自己不能参与计数
    const narrowed = rows.filter((r) => {
      const row = r.skill;
      if (!this.canSee(row, user, subs)) return false;
      if (keyword) {
        const hay = `${row.slug}\n${row.name}\n${row.description}`.toLowerCase();
        if (!hay.includes(keyword)) return false;
      }
      return this.matchKind(row, query.kind);
    });
    const scopeCounts = { all: narrowed.length, subscribed: 0, unsubscribed: 0, mine: 0 };
    for (const r of narrowed) {
      if (effective.has(r.skill.id)) scopeCounts.subscribed += 1;
      else scopeCounts.unsubscribed += 1;
      if (r.skill.ownerId === user.id) scopeCounts.mine += 1;
    }
    const filtered = narrowed.filter((r) => {
      const row = r.skill;
      if (query.scope === 'subscribed') return effective.has(row.id);
      if (query.scope === 'unsubscribed') return !effective.has(row.id);
      if (query.scope === 'mine') return row.ownerId === user.id;
      return true;
    });

    const start = (query.page - 1) * query.pageSize;
    const pageRows = filtered.slice(start, start + query.pageSize);
    const subscriberCounts = await this.subscriberCounts(pageRows.map((r) => r.skill));
    return {
      items: pageRows.map((r) =>
        this.toInfo(r.skill, r.ownerName, user, effective.has(r.skill.id), subscriberCounts.get(r.skill.id) ?? 0),
      ),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      counts: scopeCounts,
    };
  }

  async detail(user: AuthUser, slug: string): Promise<SkillDetail> {
    const skill = await this.getBySlug(slug);
    // 订阅状态按**有效集合**判（含模板派生与捆绑），与清单页口径一致
    const { subs, effective } = await this.effectiveSkillIds(user);
    if (!this.canSee(skill, user, subs)) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `Skill ${slug} 不存在` });
    }
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, skill.ownerId));
    const version = (
      await this.db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, skill.currentVersion)))
        .limit(1)
    )[0];
    const counts = await this.subscriberCounts([skill]);
    return {
      ...this.toInfo(skill, owner?.name ?? '(已删除)', user, effective.has(skill.id), counts.get(skill.id) ?? 0),
      content: version?.content ?? '',
      files: version?.files ?? [],
    };
  }

  async versions(user: AuthUser, slug: string): Promise<SkillVersionInfo[]> {
    const skill = await this.getBySlug(slug);
    if (!this.canSee(skill, user, await this.subscribedSkillIds(user.id))) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `Skill ${slug} 不存在` });
    }
    const rows = await this.db
      .select({ version: skillVersions.version, changelog: skillVersions.changelog, createdAt: skillVersions.createdAt, createdBy: users.name })
      .from(skillVersions)
      .innerJoin(users, eq(skillVersions.createdBy, users.id))
      .where(eq(skillVersions.skillId, skill.id))
      .orderBy(desc(skillVersions.version));
    return rows.map((r) => ({
      version: r.version,
      changelog: r.changelog,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** 大小与密钥扫描；返回错误说明或 null */
  private validatePayload(dto: PushSkillRequest): string | null {
    let total = Buffer.byteLength(dto.content, 'utf8');
    const seen = new Set<string>();
    for (const f of dto.files) {
      if (seen.has(f.path)) return `文件路径重复: ${f.path}`;
      seen.add(f.path);
      const size = byteLen(f.content, f.encoding);
      if (size > SKILL_FILE_MAX_BYTES) return `文件 ${f.path} 超过 256KB 限制`;
      total += size;
    }
    if (total > SKILL_TOTAL_MAX_BYTES) return 'Skill 整体超过 1MB 限制。大文件请放外部仓库，在 skill 里写引用';
    const texts = [dto.content, ...dto.files.filter((f) => f.encoding === 'utf8').map((f) => f.content)];
    for (const t of texts) {
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(t)) return `内容疑似包含密钥（${p.label}），请移除后重新推送；密钥应通过平台环境变量分发`;
      }
    }
    return null;
  }

  /**
   * 元信息以客户端传的为准，但两种情况回退到 SKILL.md frontmatter：
   * 传空（网页创建时只贴了正文没填描述），或传上来的只是个块标量指示符
   * （旧版 CLI ≤0.5.5 解析不了 `description: >-`，把 `>-` 本身当值推了上来）。
   */
  private resolveMeta(dto: PushSkillRequest): { name: string; description: string } {
    const usable = (v: string) => v.trim() !== '' && !isBlockScalarIndicator(v);
    if (usable(dto.name) && usable(dto.description)) return { name: dto.name, description: dto.description };
    const fm = parseSkillFrontmatter(dto.content);
    return {
      name: usable(dto.name) ? dto.name : (fm.name?.slice(0, 100) ?? dto.name),
      description: usable(dto.description) ? dto.description : (fm.description?.slice(0, 2000) ?? ''),
    };
  }

  /**
   * 创建或推送新版本（eat skill push / 网页创建共用）。
   *
   * **不碰订阅关系**：是否让某个 skill 进自己的 sync 范围完全由用户自己决定（订阅 / 退订），
   * 推送只负责内容。此前这里会把推送者自动订阅上去，副作用是「退订自己的 skill → 推个新版本
   * → 又被订阅回来」，用户的退订意愿留不住。作者要本地也有一份，自行 eat skill subscribe 一次。
   */
  async push(user: AuthUser, dto: PushSkillRequest): Promise<SkillDetail> {
    const problem = this.validatePayload(dto);
    if (problem) throw new BadRequestException({ error: 'VALIDATION_FAILED', message: problem });
    if (dto.slug === PLATFORM_GUIDE_SLUG) {
      throw new BadRequestException({ error: 'VALIDATION_FAILED', message: `${PLATFORM_GUIDE_SLUG} 是平台内置 skill 的保留名` });
    }

    const meta = this.resolveMeta(dto);
    const existing = (await this.db.select().from(skills).where(eq(skills.slug, dto.slug)).limit(1))[0];
    let skill: SkillRow;
    if (existing) {
      if (!this.canManage(existing, user)) {
        throw new ForbiddenException({ error: 'FORBIDDEN', message: `Skill ${dto.slug} 已存在且属于他人，仅作者可推送新版本` });
      }
      skill = existing;
    } else {
      [skill] = await this.db
        .insert(skills)
        .values({
          slug: dto.slug,
          name: meta.name,
          description: meta.description,
          ownerId: user.id,
          visibility: dto.visibility ?? 'team',
        })
        .returning();
    }

    const nextVersion = skill.currentVersion + 1;
    await this.db.insert(skillVersions).values({
      skillId: skill.id,
      version: nextVersion,
      content: dto.content,
      files: dto.files,
      changelog: dto.changelog,
      createdBy: user.id,
    });
    await this.db
      .update(skills)
      .set({
        currentVersion: nextVersion,
        name: meta.name,
        description: meta.description,
        ...(dto.visibility ? { visibility: dto.visibility } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skill.id));

    await this.audit.record({
      actorId: user.id,
      action: existing ? 'skill.version_pushed' : 'skill.created',
      targetType: 'skill',
      targetId: skill.id,
      meta: { slug: dto.slug, version: nextVersion },
    });
    return this.detail(user, dto.slug);
  }

  async updateMeta(user: AuthUser, slug: string, dto: UpdateSkillRequest): Promise<SkillInfo> {
    const skill = await this.getBySlug(slug);
    if (!this.canManage(skill, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅作者或管理员可修改' });
    }
    // 捆绑是「替全员做决定」，只有管理员能改——作者对自己的 skill 也不行（决策 37）
    if (dto.bundled !== undefined && dto.bundled !== skill.bundled && user.role !== 'admin') {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅管理员可设置捆绑模式' });
    }
    const bundled = dto.bundled ?? skill.bundled;
    const visibility = dto.visibility ?? skill.visibility;
    // 捆绑要求团队可见：否则会出现「被强制订阅但看不到内容」的自相矛盾状态
    if (bundled && visibility !== 'team') {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '捆绑模式要求 skill 为团队可见；请先改为团队可见，或先取消捆绑',
      });
    }
    const [row] = await this.db
      .update(skills)
      .set({
        name: dto.name ?? skill.name,
        description: dto.description ?? skill.description,
        visibility,
        allowHelp: dto.allowHelp ?? skill.allowHelp,
        bundled,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skill.id))
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: bundled !== skill.bundled ? (bundled ? 'skill.bundled' : 'skill.unbundled') : 'skill.updated',
      targetType: 'skill',
      targetId: skill.id,
      meta: { slug },
    });
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId));
    const { effective } = await this.effectiveSkillIds(user);
    const counts = await this.subscriberCounts([row]);
    return this.toInfo(row, owner?.name ?? '', user, effective.has(row.id), counts.get(row.id) ?? 0);
  }

  async remove(user: AuthUser, slug: string) {
    const skill = await this.getBySlug(slug);
    if (!this.canManage(skill, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅作者或管理员可删除' });
    }
    await this.db.delete(skills).where(eq(skills.id, skill.id));
    await this.audit.record({ actorId: user.id, action: 'skill.deleted', targetType: 'skill', targetId: skill.id, meta: { slug } });
    return { ok: true };
  }

  /** 订阅写入（自助订阅与管理员代订阅共用）：之前排除过（模板派生）则解除排除 */
  private async writeSubscription(targetUserId: string, skillId: string) {
    await this.db
      .insert(skillSubscriptions)
      .values({ userId: targetUserId, skillId })
      .onConflictDoUpdate({
        target: [skillSubscriptions.userId, skillSubscriptions.skillId],
        set: { excluded: false, source: 'manual' },
      });
  }

  /** 退订写入：模板派生的条目退订 = 记录排除标记（模板本身不受影响），其余物理删除 */
  private async removeSubscription(targetUserId: string, skillId: string) {
    const fromTemplate = (await this.templateSkillIds(targetUserId)).has(skillId);
    if (fromTemplate) {
      await this.db
        .insert(skillSubscriptions)
        .values({ userId: targetUserId, skillId, source: 'template', excluded: true })
        .onConflictDoUpdate({
          target: [skillSubscriptions.userId, skillSubscriptions.skillId],
          set: { excluded: true },
        });
    } else {
      await this.db
        .delete(skillSubscriptions)
        .where(and(eq(skillSubscriptions.userId, targetUserId), eq(skillSubscriptions.skillId, skillId)));
    }
  }

  async subscribe(user: AuthUser, slug: string) {
    const skill = await this.getBySlug(slug);
    if (!this.canSee(skill, user, await this.subscribedSkillIds(user.id))) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `Skill ${slug} 不存在` });
    }
    // 捆绑的 skill 本就恒为订阅，这里照常写一条记录：万一之后取消捆绑，用户自己订过的仍然留着
    await this.writeSubscription(user.id, skill.id);
    await this.audit.record({ actorId: user.id, action: 'skill.subscribed', targetType: 'skill', targetId: skill.id, meta: { slug } });
    return { ok: true };
  }

  async unsubscribe(user: AuthUser, slug: string) {
    const skill = await this.getBySlug(slug);
    if (skill.bundled && user.role !== 'admin') {
      throw new BadRequestException({
        error: 'SKILL_BUNDLED',
        message: `${slug} 已被管理员设为捆绑，对所有成员始终同步，无法退订`,
      });
    }
    await this.removeSubscription(user.id, skill.id);
    await this.audit.record({ actorId: user.id, action: 'skill.unsubscribed', targetType: 'skill', targetId: skill.id, meta: { slug } });
    return { ok: true };
  }

  /** 订阅者明细（仅管理员；鉴权在路由的 @Roles('admin') 上，故这里不再收 AuthUser） */
  async subscribers(slug: string): Promise<SkillSubscriber[]> {
    const skill = await this.getBySlug(slug);
    const entries = (await this.effectiveSubscribers([skill])).get(skill.id) ?? [];
    return entries
      .map((e) => ({
        userId: e.user.id,
        name: e.user.name,
        email: e.user.email,
        role: e.user.role,
        source: e.source,
        // 捆绑强制的订阅移不掉（要先取消捆绑）；管理员不受捆绑影响，照常可移
        removable: !(skill.bundled && e.user.role !== 'admin'),
        subscribedAt: e.subscribedAt?.toISOString() ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  private async getTargetUser(userId: string): Promise<UserRow> {
    const row = (await this.db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    return row;
  }

  /** 管理员替他人订阅 */
  async addSubscriber(admin: AuthUser, slug: string, targetUserId: string) {
    const skill = await this.getBySlug(slug);
    const target = await this.getTargetUser(targetUserId);
    if (target.status !== 'active') {
      throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '该用户已禁用，无法为其订阅' });
    }
    // private 的 skill 别人看不到，订上去只会得到一条同步不下来的死订阅
    if (skill.visibility === 'private' && skill.ownerId !== target.id) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '该 Skill 为私有，成员看不到；请先改为团队可见（授予可见的经验 skill 可以直接订阅）',
      });
    }
    if (skill.bundled && target.role !== 'admin') {
      throw new BadRequestException({
        error: 'SKILL_BUNDLED',
        message: `${slug} 已是捆绑 Skill，全体成员本就恒为订阅，无需单独添加`,
      });
    }
    await this.writeSubscription(target.id, skill.id);
    await this.audit.record({
      actorId: admin.id,
      action: 'skill.subscriber_added',
      targetType: 'skill',
      targetId: skill.id,
      meta: { slug, targetUserId: target.id, targetUserEmail: target.email },
    });
    return { ok: true };
  }

  /** 管理员取消他人的订阅 */
  async removeSubscriber(admin: AuthUser, slug: string, targetUserId: string) {
    const skill = await this.getBySlug(slug);
    const target = await this.getTargetUser(targetUserId);
    if (skill.bundled && target.role !== 'admin') {
      throw new BadRequestException({
        error: 'SKILL_BUNDLED',
        message: `${slug} 是捆绑 Skill，成员不能单独取消；要停止分发请先取消捆绑`,
      });
    }
    await this.removeSubscription(target.id, skill.id);
    await this.audit.record({
      actorId: admin.id,
      action: 'skill.subscriber_removed',
      targetType: 'skill',
      targetId: skill.id,
      meta: { slug, targetUserId: target.id, targetUserEmail: target.email },
    });
    return { ok: true };
  }

  /** eat sync 的落地内容：（订阅 ∪ 模板−排除）且仍可见的 skill 当前版本 */
  /**
   * 该用户整套 Skill 的指纹（更新检测用，决策 26）：与 syncBundle 的可见性规则完全一致，
   * 但只查 skills 表的 slug + currentVersion——不 join skill_versions、不读内容，
   * 因此可以挂在每个 CLI 请求的响应头上。
   */
  async bundleVersion(user: AuthUser): Promise<string> {
    const items: SkillBundleItem[] = [{ slug: PLATFORM_GUIDE_SLUG, version: PLATFORM_GUIDE_VERSION }];
    const { subs, effective } = await this.effectiveSkillIds(user);
    if (effective.size > 0) {
      const rows = await this.db
        .select()
        .from(skills)
        .where(inArray(skills.id, [...effective]));
      for (const s of rows) {
        if (s.slug === PLATFORM_GUIDE_SLUG || s.currentVersion <= 0) continue;
        if (!this.canSee(s, user, subs)) continue;
        items.push({ slug: s.slug, version: s.currentVersion });
      }
    }
    return skillBundleVersion(items);
  }

  /** 这条 skill 为什么会出现在该用户的 sync 里：own > bundled > subscribed > template */
  private relationOf(skill: SkillRow, user: AuthUser, subs: Set<string>): SyncSkill['relation'] {
    if (skill.ownerId === user.id) return 'own';
    if (skill.bundled && user.role !== 'admin') return 'bundled';
    if (subs.has(skill.id)) return 'subscribed';
    return 'template';
  }

  async syncBundle(user: AuthUser): Promise<SyncSkill[]> {
    // 内置平台使用指南对所有用户始终下发（§10 决策 11）：不落库、不可退订，随平台版本更新
    const guide = platformGuideSyncSkill();
    const { subs, effective } = await this.effectiveSkillIds(user);
    if (effective.size === 0) return [guide];
    const rows = await this.db
      .select()
      .from(skills)
      .where(inArray(skills.id, [...effective]));
    const visible = rows.filter((s) => this.canSee(s, user, subs) && s.currentVersion > 0 && s.slug !== PLATFORM_GUIDE_SLUG);
    if (visible.length === 0) return [guide];
    const versions = await this.db
      .select()
      .from(skillVersions)
      .where(
        inArray(
          skillVersions.id,
          this.db
            .select({ id: skillVersions.id })
            .from(skillVersions)
            .innerJoin(skills, eq(skillVersions.skillId, skills.id))
            .where(and(inArray(skillVersions.skillId, visible.map((s) => s.id)), eq(skillVersions.version, skills.currentVersion))),
        ),
      );
    const bySkill = new Map(versions.map((v) => [v.skillId, v]));
    return [guide, ...visible.map((s) => {
      const v = bySkill.get(s.id);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        source: s.source,
        relation: this.relationOf(s, user, subs),
        version: s.currentVersion,
        content: v?.content ?? '',
        files: v?.files ?? [],
      };
    })];
  }
}
