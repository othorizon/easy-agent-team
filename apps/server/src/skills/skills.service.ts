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
  SkillVersionInfo,
  SyncSkill,
  UpdateSkillRequest,
} from '@eat/shared';
import { SKILL_FILE_MAX_BYTES, SKILL_TOTAL_MAX_BYTES } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { skills, skillSubscriptions, skillVersions, users } from '../db/schema';

type SkillRow = typeof skills.$inferSelect;

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

  private canSee(skill: SkillRow, user: AuthUser): boolean {
    return skill.visibility === 'team' || skill.ownerId === user.id || user.role === 'admin';
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
      .where(eq(skillSubscriptions.userId, userId));
    return new Set(rows.map((r) => r.skillId));
  }

  private toInfo(row: SkillRow, ownerName: string, subscribed: boolean): SkillInfo {
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
      subscribed,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(user: AuthUser): Promise<SkillInfo[]> {
    const rows = await this.db
      .select({ skill: skills, ownerName: users.name })
      .from(skills)
      .innerJoin(users, eq(skills.ownerId, users.id))
      .orderBy(desc(skills.updatedAt));
    const subs = await this.subscribedSkillIds(user.id);
    return rows
      .filter((r) => this.canSee(r.skill, user))
      .map((r) => this.toInfo(r.skill, r.ownerName, subs.has(r.skill.id)));
  }

  async detail(user: AuthUser, slug: string): Promise<SkillDetail> {
    const skill = await this.getBySlug(slug);
    if (!this.canSee(skill, user)) {
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
    const subs = await this.subscribedSkillIds(user.id);
    return {
      ...this.toInfo(skill, owner?.name ?? '(已删除)', subs.has(skill.id)),
      content: version?.content ?? '',
      files: version?.files ?? [],
    };
  }

  async versions(user: AuthUser, slug: string): Promise<SkillVersionInfo[]> {
    const skill = await this.getBySlug(slug);
    if (!this.canSee(skill, user)) {
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

  /** 创建或推送新版本（eat skill push / 网页创建共用） */
  async push(user: AuthUser, dto: PushSkillRequest): Promise<SkillDetail> {
    const problem = this.validatePayload(dto);
    if (problem) throw new BadRequestException({ error: 'VALIDATION_FAILED', message: problem });

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
          name: dto.name,
          description: dto.description,
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
        name: dto.name,
        description: dto.description,
        ...(dto.visibility ? { visibility: dto.visibility } : {}),
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skill.id));

    // 作者自动订阅自己的 skill（保证出现在 sync 范围）
    await this.db
      .insert(skillSubscriptions)
      .values({ userId: user.id, skillId: skill.id })
      .onConflictDoNothing();

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
    const [row] = await this.db
      .update(skills)
      .set({
        name: dto.name ?? skill.name,
        description: dto.description ?? skill.description,
        visibility: dto.visibility ?? skill.visibility,
        allowHelp: dto.allowHelp ?? skill.allowHelp,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, skill.id))
      .returning();
    await this.audit.record({ actorId: user.id, action: 'skill.updated', targetType: 'skill', targetId: skill.id, meta: { slug } });
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId));
    const subs = await this.subscribedSkillIds(user.id);
    return this.toInfo(row, owner?.name ?? '', subs.has(row.id));
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

  async subscribe(user: AuthUser, slug: string) {
    const skill = await this.getBySlug(slug);
    if (!this.canSee(skill, user)) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `Skill ${slug} 不存在` });
    }
    await this.db
      .insert(skillSubscriptions)
      .values({ userId: user.id, skillId: skill.id })
      .onConflictDoNothing();
    await this.audit.record({ actorId: user.id, action: 'skill.subscribed', targetType: 'skill', targetId: skill.id, meta: { slug } });
    return { ok: true };
  }

  async unsubscribe(user: AuthUser, slug: string) {
    const skill = await this.getBySlug(slug);
    await this.db
      .delete(skillSubscriptions)
      .where(and(eq(skillSubscriptions.userId, user.id), eq(skillSubscriptions.skillId, skill.id)));
    await this.audit.record({ actorId: user.id, action: 'skill.unsubscribed', targetType: 'skill', targetId: skill.id, meta: { slug } });
    return { ok: true };
  }

  /** eat sync 的落地内容：订阅的（含自己的）且仍可见的 skill 当前版本 */
  async syncBundle(user: AuthUser): Promise<SyncSkill[]> {
    const subs = await this.subscribedSkillIds(user.id);
    if (subs.size === 0) return [];
    const rows = await this.db
      .select()
      .from(skills)
      .where(inArray(skills.id, [...subs]));
    const visible = rows.filter((s) => this.canSee(s, user) && s.currentVersion > 0);
    if (visible.length === 0) return [];
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
    return visible.map((s) => {
      const v = bySkill.get(s.id);
      return {
        slug: s.slug,
        name: s.name,
        description: s.description,
        source: s.source,
        relation: (s.ownerId === user.id ? 'own' : 'subscribed') as 'own' | 'subscribed',
        version: s.currentVersion,
        content: v?.content ?? '',
        files: v?.files ?? [],
      };
    });
  }
}
