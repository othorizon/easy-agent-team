import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { DistillRequest, ExperienceInfo, ExperienceSearchResult } from '@eat/shared';
import { AiService } from '../ai/ai.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { experiences, helpMessages, helpRequests, skills, skillSubscriptions, skillVersions, users } from '../db/schema';
import { SkillsService } from '../skills/skills.service';

const DISTILL_SYSTEM_PROMPT = `你是团队知识沉淀助手。把一次"求助问答"整理成一份可复用的 SKILL.md。
要求：
1. 第一行开始就是正文（不要 frontmatter），用 Markdown；
2. 结构：# 标题、## 适用场景（何时该用这份经验）、## 结论（直接给答案与操作步骤）、## 注意事项（如有）；
3. 只保留可复用的知识，去掉寒暄与个案细节；
4. 不要包含任何密钥、token、密码等敏感值；
5. 使用中文，简洁准确。`;

@Injectable()
export class ExperiencesService {
  private readonly logger = new Logger(ExperiencesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly skillsService: SkillsService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
  ) {}

  /** 沉淀：仅被求助者可操作（求助者无权），求助需已解决 */
  async distill(user: AuthUser, requestId: string, dto: DistillRequest): Promise<ExperienceInfo & { aiUsed: boolean }> {
    const req = (await this.db.select().from(helpRequests).where(eq(helpRequests.id, requestId)).limit(1))[0];
    if (!req) throw new NotFoundException({ error: 'NOT_FOUND', message: '求助不存在' });
    if (req.helperId !== user.id) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅被求助者可沉淀经验' });
    }
    if (req.status !== 'resolved') {
      throw new ConflictException({ error: 'CONFLICT', message: '仅已解决（resolved）的求助可沉淀' });
    }
    const existed = (
      await this.db.select().from(experiences).where(eq(experiences.helpRequestId, requestId)).limit(1)
    )[0];
    if (existed) throw new ConflictException({ error: 'CONFLICT', message: '该求助已沉淀过经验' });

    const messages = await this.db
      .select({ senderId: helpMessages.senderId, content: helpMessages.content })
      .from(helpMessages)
      .where(eq(helpMessages.requestId, requestId))
      .orderBy(helpMessages.createdAt);

    const slug = dto.slug ?? `exp-${requestId.slice(0, 8)}`;
    const name = dto.name ?? req.title;

    // 内容来源优先级：手工提供 > AI 整理（失败回退模板）> 模板
    let content = dto.content ?? '';
    let aiUsed = false;
    if (!content && dto.useAi && (await this.ai.isAvailable())) {
      try {
        content = await this.ai.chatComplete('experience_distill', [
          { role: 'system', content: DISTILL_SYSTEM_PROMPT },
          { role: 'user', content: this.buildThreadText(req, messages, user.id) },
        ]);
        aiUsed = true;
      } catch (err) {
        this.logger.warn(`AI 整理失败，回退模板: ${(err as Error).message}`);
      }
    }
    if (!content) content = this.templateDraft(req, messages);

    // 经验即 Skill：复用推送通道（大小限制/密钥扫描同样生效），Owner=被求助者
    await this.skillsService.push(user, {
      slug,
      name,
      description: `经验沉淀：${req.title}`,
      content,
      files: [],
      changelog: `沉淀自求助 ${requestId.slice(0, 8)}`,
      visibility: dto.public ? 'team' : 'private',
    });
    const skill = (await this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1))[0];
    // 非公开经验用 granted 可见性：仅作者/管理员/被授予订阅者可见
    await this.db
      .update(skills)
      .set({ source: 'experience', visibility: dto.public ? 'team' : 'granted' })
      .where(eq(skills.id, skill.id));

    // 沉淀给谁 → 订阅（订阅在 granted 可见性下同时充当授权）
    if (dto.grantedToRequester) {
      await this.db
        .insert(skillSubscriptions)
        .values({ userId: req.requesterId, skillId: skill.id, source: 'experience' })
        .onConflictDoNothing();
    }
    if (!dto.grantedToHelper) {
      // 不沉淀给自己：移除 push 时自动创建的作者订阅（保留 Owner 编辑权，但不进本地 sync）
      await this.db
        .delete(skillSubscriptions)
        .where(and(eq(skillSubscriptions.skillId, skill.id), eq(skillSubscriptions.userId, user.id)));
    }

    const [row] = await this.db
      .insert(experiences)
      .values({
        helpRequestId: requestId,
        skillId: skill.id,
        public: dto.public,
        grantedToRequester: dto.grantedToRequester,
        grantedToHelper: dto.grantedToHelper,
        createdBy: user.id,
      })
      .returning();
    await this.audit.record({
      actorId: user.id,
      action: 'experience.distilled',
      targetType: 'experience',
      targetId: row.id,
      meta: { requestId, skillSlug: slug, public: dto.public, aiUsed },
    });
    return {
      id: row.id,
      helpRequestId: requestId,
      skillSlug: slug,
      public: row.public,
      grantedToRequester: row.grantedToRequester,
      grantedToHelper: row.grantedToHelper,
      createdAt: row.createdAt.toISOString(),
      aiUsed,
    };
  }

  private buildThreadText(
    req: typeof helpRequests.$inferSelect,
    messages: Array<{ senderId: string; content: string }>,
    helperId: string,
  ): string {
    const lines = [
      `求助标题: ${req.title}`,
      `问题描述: ${req.description}`,
      `求助者已尝试: ${req.tried}`,
      '',
      '问答过程:',
      ...messages.map((m) => `${m.senderId === helperId ? '回答者' : '求助者'}: ${m.content}`),
    ];
    return lines.join('\n');
  }

  private templateDraft(
    req: typeof helpRequests.$inferSelect,
    messages: Array<{ senderId: string; content: string }>,
  ): string {
    const helperAnswers = messages.filter((m) => m.senderId === req.helperId).map((m) => m.content);
    return [
      `# ${req.title}`,
      '',
      '## 适用场景',
      req.description,
      '',
      '## 结论',
      helperAnswers.length > 0 ? helperAnswers.join('\n\n') : '（待补充）',
      '',
      `> 由求助 ${req.id.slice(0, 8)} 沉淀，内容可由沉淀者继续修改。`,
    ].join('\n');
  }

  /** 搜索经验库：公开经验全员可搜；非公开的仅求助双方与管理员可见 */
  async search(user: AuthUser, q?: string): Promise<ExperienceSearchResult[]> {
    const rows = await this.db
      .select({ exp: experiences, skill: skills, req: helpRequests })
      .from(experiences)
      .innerJoin(skills, eq(experiences.skillId, skills.id))
      .innerJoin(helpRequests, eq(experiences.helpRequestId, helpRequests.id))
      .orderBy(desc(experiences.createdAt))
      .limit(200);
    const visible = rows.filter(
      (r) =>
        r.exp.public ||
        user.role === 'admin' ||
        r.req.requesterId === user.id ||
        r.req.helperId === user.id,
    );
    const results: ExperienceSearchResult[] = [];
    for (const r of visible) {
      const version = (
        await this.db
          .select({ content: skillVersions.content })
          .from(skillVersions)
          .where(eq(skillVersions.skillId, r.skill.id))
          .orderBy(desc(skillVersions.version))
          .limit(1)
      )[0];
      const haystack = `${r.skill.name}\n${r.skill.description}\n${version?.content ?? ''}`;
      if (q) {
        const idx = haystack.toLowerCase().indexOf(q.toLowerCase());
        if (idx < 0) continue;
        results.push({
          skillSlug: r.skill.slug,
          name: r.skill.name,
          description: r.skill.description,
          public: r.exp.public,
          snippet: haystack.slice(Math.max(0, idx - 40), idx + 80).replace(/\n/g, ' '),
        });
      } else {
        results.push({
          skillSlug: r.skill.slug,
          name: r.skill.name,
          description: r.skill.description,
          public: r.exp.public,
          snippet: '',
        });
      }
    }
    return results.slice(0, 50);
  }
}
