import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { buildHelpFeishuCard, type HelpFeishuCardInput } from '@eat/shared';
import type { CreateHelpRequest, HelpRequestDetail, HelpRequestInfo, HelpStatus } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { loadConfig } from '../config';
import { DB, type Db } from '../db/db.module';
import { experiences, helpMessages, helperProfiles, helpRequests, skills, users } from '../db/schema';
import { WebhookService } from '../notify/webhook.service';
import { HelpersService } from './helpers.service';

type HelpRow = typeof helpRequests.$inferSelect;

/** 每用户每小时可发起的求助数（防骚扰） */
const RATE_LIMIT = Number(process.env.EAT_HELP_RATE_LIMIT ?? 10);

@Injectable()
export class HelpService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly helpers: HelpersService,
    private readonly webhook: WebhookService,
    private readonly audit: AuditService,
  ) {}

  private async getRow(id: string): Promise<HelpRow> {
    const row = (await this.db.select().from(helpRequests).where(eq(helpRequests.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '求助不存在' });
    return row;
  }

  /** 可见性：求助双方 + 管理员（已拍板决策 #1） */
  private assertVisible(row: HelpRow, user: AuthUser) {
    if (row.requesterId !== user.id && row.helperId !== user.id && user.role !== 'admin') {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '求助不存在' });
    }
  }

  private async toInfo(row: HelpRow): Promise<HelpRequestInfo> {
    const nameOf = async (id: string) =>
      (await this.db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1))[0]?.name ?? '(已删除)';
    const skillSlug = row.skillId
      ? ((await this.db.select({ slug: skills.slug }).from(skills).where(eq(skills.id, row.skillId)).limit(1))[0]?.slug ?? null)
      : null;
    const exp = (
      await this.db
        .select({ slug: skills.slug })
        .from(experiences)
        .innerJoin(skills, eq(experiences.skillId, skills.id))
        .where(eq(experiences.helpRequestId, row.id))
        .limit(1)
    )[0];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      tried: row.tried,
      status: row.status,
      requesterId: row.requesterId,
      requesterName: await nameOf(row.requesterId),
      helperId: row.helperId,
      helperName: await nameOf(row.helperId),
      skillSlug,
      experienceSkillSlug: exp?.slug ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 飞书卡片通知（决策 17）。按接收方的「接收求助/接收回复」开关过滤 */
  private notifyUser(userId: string, event: 'help.created' | 'help.replied', card: HelpFeishuCardInput, summary: string): void {
    void this.helpers.webhookOf(userId, event === 'help.created' ? 'help' : 'reply').then((wh) => {
      if (wh) this.webhook.notify(event, wh.url, wh.secret, buildHelpFeishuCard(card), summary);
    });
  }

  async create(user: AuthUser, dto: CreateHelpRequest): Promise<HelpRequestInfo> {
    // 频率限制
    const oneHourAgo = new Date(Date.now() - 3600_000);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(helpRequests)
      .where(and(eq(helpRequests.requesterId, user.id), gt(helpRequests.createdAt, oneHourAgo)));
    if (count >= RATE_LIMIT) {
      throw new BadRequestException({
        error: 'RATE_LIMITED',
        message: `一小时内最多发起 ${RATE_LIMIT} 个求助。先看看已有回复，或整理问题后再试`,
      });
    }

    // 解析求助对象：skill 作者 或 登记的 helper
    let helperId: string;
    let skillId: string | null = null;
    if (dto.skillSlug) {
      const skill = (await this.db.select().from(skills).where(eq(skills.slug, dto.skillSlug)).limit(1))[0];
      if (!skill || !skill.allowHelp) {
        throw new BadRequestException({ error: 'NOT_FOUND', message: `Skill ${dto.skillSlug} 不存在或未开启求助` });
      }
      helperId = skill.ownerId;
      skillId = skill.id;
    } else {
      const profile = (
        await this.db.select().from(helperProfiles).where(eq(helperProfiles.userId, dto.helperUserId!)).limit(1)
      )[0];
      if (!profile || !profile.available) {
        throw new BadRequestException({ error: 'NOT_FOUND', message: '对方未登记为可求助者或当前勿扰' });
      }
      helperId = profile.userId;
    }
    if (helperId === user.id) {
      throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '不能向自己求助' });
    }

    const [row] = await this.db
      .insert(helpRequests)
      .values({ requesterId: user.id, helperId, skillId, title: dto.title, description: dto.description, tried: dto.tried })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'help.created', targetType: 'help_request', targetId: row.id });

    const info = await this.toInfo(row);
    this.notifyUser(
      helperId,
      'help.created',
      {
        kind: 'request',
        requestId: row.id,
        title: dto.title,
        excerpt: dto.description,
        from: info.requesterName,
        url: `${loadConfig().publicUrl}/help/${row.id}`,
      },
      `求助: ${dto.title}`,
    );
    return info;
  }

  async listMine(user: AuthUser): Promise<HelpRequestInfo[]> {
    const rows = await this.db
      .select()
      .from(helpRequests)
      .where(eq(helpRequests.requesterId, user.id))
      .orderBy(desc(helpRequests.updatedAt))
      .limit(100);
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  async listInbox(user: AuthUser): Promise<HelpRequestInfo[]> {
    const rows = await this.db
      .select()
      .from(helpRequests)
      .where(eq(helpRequests.helperId, user.id))
      .orderBy(desc(helpRequests.updatedAt))
      .limit(100);
    return Promise.all(rows.map((r) => this.toInfo(r)));
  }

  async detail(user: AuthUser, id: string): Promise<HelpRequestDetail> {
    const row = await this.getRow(id);
    this.assertVisible(row, user);
    const msgs = await this.db
      .select({ id: helpMessages.id, senderId: helpMessages.senderId, senderName: users.name, content: helpMessages.content, createdAt: helpMessages.createdAt })
      .from(helpMessages)
      .innerJoin(users, eq(helpMessages.senderId, users.id))
      .where(eq(helpMessages.requestId, id))
      .orderBy(helpMessages.createdAt);
    return {
      ...(await this.toInfo(row)),
      messages: msgs.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  }

  async reply(user: AuthUser, id: string, content: string): Promise<HelpRequestDetail> {
    const row = await this.getRow(id);
    this.assertVisible(row, user);
    if (row.status === 'closed') {
      throw new ConflictException({ error: 'CONFLICT', message: '求助已关闭，无法回复' });
    }
    await this.db.insert(helpMessages).values({ requestId: id, senderId: user.id, content });
    // 状态机：helper 回复 → answered；requester 追问 → open（resolved 后追加消息不再改状态）
    let nextStatus: HelpStatus | null = null;
    if (row.status !== 'resolved') {
      nextStatus = user.id === row.helperId ? 'answered' : 'open';
    }
    await this.db
      .update(helpRequests)
      .set({ ...(nextStatus ? { status: nextStatus } : {}), updatedAt: sql`now()` })
      .where(eq(helpRequests.id, id));
    await this.audit.record({ actorId: user.id, action: 'help.replied', targetType: 'help_request', targetId: id });

    const other = user.id === row.requesterId ? row.helperId : row.requesterId;
    this.notifyUser(
      other,
      'help.replied',
      { kind: 'reply', requestId: id, title: row.title, excerpt: content, from: user.name, url: `${loadConfig().publicUrl}/help/${id}` },
      `求助回复: ${row.title}`,
    );
    return this.detail(user, id);
  }

  /** 求助者确认解决，或被求助者标记已解决 */
  async resolve(user: AuthUser, id: string): Promise<HelpRequestInfo> {
    const row = await this.getRow(id);
    this.assertVisible(row, user);
    if (row.requesterId !== user.id && row.helperId !== user.id) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅求助双方可标记解决' });
    }
    if (row.status === 'closed') {
      throw new ConflictException({ error: 'CONFLICT', message: '求助已关闭' });
    }
    await this.db.update(helpRequests).set({ status: 'resolved', updatedAt: sql`now()` }).where(eq(helpRequests.id, id));
    await this.audit.record({ actorId: user.id, action: 'help.resolved', targetType: 'help_request', targetId: id });
    return this.toInfo(await this.getRow(id));
  }

  /** 求助者撤销（仅 open 状态） */
  async close(user: AuthUser, id: string): Promise<HelpRequestInfo> {
    const row = await this.getRow(id);
    this.assertVisible(row, user);
    if (row.requesterId !== user.id) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅求助者可撤销' });
    }
    if (row.status !== 'open') {
      throw new ConflictException({ error: 'CONFLICT', message: '仅未回复的求助可撤销' });
    }
    await this.db.update(helpRequests).set({ status: 'closed', updatedAt: sql`now()` }).where(eq(helpRequests.id, id));
    await this.audit.record({ actorId: user.id, action: 'help.closed', targetType: 'help_request', targetId: id });
    return this.toInfo(await this.getRow(id));
  }
}
