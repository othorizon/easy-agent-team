import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  AddMcpSubscriberRequest,
  DecideMcpSubscriptionRequest,
  McpConfigInfo,
  McpSubscriber,
  McpSubscriptionRequest,
  McpSubscriptionRequestQuery,
  McpSubscriptionStatus,
  RenderedMcpConfig,
  SubscribeMcpConfigRequest,
  SubscribeMcpConfigResult,
  UpsertMcpConfigRequest,
} from '@eat/shared';
import { ENV_REF_PATTERN } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { mcpConfigs, mcpSubscriptions, templateItems, users, userTemplateSelections } from '../db/schema';
import { EnvsService } from '../envs/envs.service';
import { McpGatewayService } from '../mcp-gateway/mcp-gateway.service';
import { McpSubscriptionsService, type SubscriptionSets } from './mcp-subscriptions.service';

type ConfigRow = typeof mcpConfigs.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** 申请人与审批人都是 user 表，一条查询里 join 两次，各起别名 */
const requester = alias(users, 'mcp_requester');
const decider = alias(users, 'mcp_decider');

@Injectable()
export class McpConfigsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvsService,
    private readonly audit: AuditService,
    private readonly subs: McpSubscriptionsService,
    private readonly gateway: McpGatewayService,
  ) {}

  /**
   * 可见性（决策 50）：
   * - `team` 全员可见（看得到说明、可申请订阅）；
   * - `private` 不公开，只有 Owner / 管理员看得到——**但已经拿到订阅的人要看得到自己手上有什么**，
   *   否则管理员分配下去的配置会「同步得到却在清单里查无此物」。
   */
  private canSee(row: ConfigRow, user: AuthUser, sets: SubscriptionSets): boolean {
    if (row.visibility === 'team' || row.ownerId === user.id || user.role === 'admin') return true;
    return sets.effective.has(row.id) || sets.pending.has(row.id);
  }

  /** 审批人：配置 Owner 或管理员（与环境变量的「环境 Owner 或管理员」同一条规则） */
  private canApprove(row: ConfigRow, user: AuthUser): boolean {
    return row.ownerId === user.id || user.role === 'admin';
  }

  private async getBySlug(slug: string): Promise<ConfigRow> {
    const row = (await this.db.select().from(mcpConfigs).where(eq(mcpConfigs.slug, slug)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `MCP 配置 ${slug} 不存在` });
    return row;
  }

  private subscriptionSets(userId: string): Promise<SubscriptionSets> {
    return this.subs.sets(userId);
  }

  private statusOf(configId: string, sets: SubscriptionSets): McpSubscriptionStatus {
    if (sets.effective.has(configId)) return 'approved';
    if (sets.pending.has(configId)) return 'pending';
    if (sets.rejected.has(configId)) return 'rejected';
    return 'none';
  }

  /**
   * 上游地址与 header 只对 Owner / 管理员下发（决策 51）。
   * 经网关分发的配置里，普通订阅者看到的必须是自己的 gatewayUrl 而不是上游——
   * 否则接口把要藏的东西又交回去了，网关只是个摆设。
   */
  private canSeeUpstream(row: ConfigRow, user: AuthUser): boolean {
    return !row.gatewayEnabled || row.ownerId === user.id || user.role === 'admin';
  }

  private toInfo(
    row: ConfigRow,
    ownerName: string,
    sets: SubscriptionSets,
    user: AuthUser,
    gatewayUrl: string | null,
  ): McpConfigInfo {
    const upstream = this.canSeeUpstream(row, user);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: upstream ? row.url : null,
      headers: upstream ? row.headers : {},
      env: upstream ? row.env : {},
      visibility: row.visibility,
      gatewayEnabled: row.gatewayEnabled,
      gatewayAvailable: row.transport === 'http' && this.canApprove(row, user),
      gatewayUrl,
      ownerId: row.ownerId,
      ownerName,
      subscribed: sets.effective.has(row.id),
      subscriptionStatus: this.statusOf(row.id, sets),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 授权发生变化后同步专属接入地址（决策 51）。
   *
   * 判的是**是否跨过了「有效」这条线**，不是「有没有点过订阅」：
   * - 刚拿到授权 → 签发新地址（mint 内部会把这一对上的旧地址一并作废，
   *   所以「取消后重新获取就是新 URL」自动成立）；
   * - 刚失去授权 → 吊销。
   *
   * 用 wasEffective 做前后对比而不是无脑 mint，是因为已经有效的人重复点一次订阅
   * 不该把他正在用的地址换掉（模板派生的订阅尤其容易触发这条）。
   */
  private async syncGatewayAccess(userId: string, config: ConfigRow, wasEffective: boolean): Promise<void> {
    const nowEffective = await this.subs.isEffective(userId, config.id);
    if (nowEffective === wasEffective) return;
    if (nowEffective) {
      if (config.gatewayEnabled) await this.gateway.mint(userId, config.id);
    } else {
      await this.gateway.revoke(userId, config.id);
    }
  }

  /** 已生效订阅 + 走网关的配置才有专属地址；没有就懒签发一条 */
  private async gatewayUrlFor(row: ConfigRow, user: AuthUser, sets: SubscriptionSets): Promise<string | null> {
    if (!row.gatewayEnabled || !sets.effective.has(row.id)) return null;
    return this.gateway.ensureUrl(user.id, row);
  }

  async list(user: AuthUser): Promise<McpConfigInfo[]> {
    const rows = await this.db
      .select({ config: mcpConfigs, ownerName: users.name })
      .from(mcpConfigs)
      .innerJoin(users, eq(mcpConfigs.ownerId, users.id))
      .orderBy(asc(mcpConfigs.slug));
    const sets = await this.subscriptionSets(user.id);
    const visible = rows.filter((r) => this.canSee(r.config, user, sets));
    return Promise.all(
      visible.map(async (r) =>
        this.toInfo(r.config, r.ownerName, sets, user, await this.gatewayUrlFor(r.config, user, sets)),
      ),
    );
  }

  /** 创建或更新（同 slug 存在时仅 Owner/管理员可改） */
  async upsert(user: AuthUser, dto: UpsertMcpConfigRequest): Promise<McpConfigInfo> {
    const existing = (await this.db.select().from(mcpConfigs).where(eq(mcpConfigs.slug, dto.slug)).limit(1))[0];
    let row: ConfigRow;
    const values = {
      name: dto.name,
      description: dto.description,
      transport: dto.transport,
      command: dto.command ?? null,
      args: dto.args,
      url: dto.url ?? null,
      headers: dto.headers,
      env: dto.env,
      visibility: dto.visibility,
      // stdio 没有可代理的端点，无论前端传什么都按不走网关处理
      gatewayEnabled: dto.transport === 'http' ? dto.gatewayEnabled : false,
    };
    if (existing) {
      if (existing.ownerId !== user.id && user.role !== 'admin') {
        throw new ForbiddenException({ error: 'FORBIDDEN', message: `MCP 配置 ${dto.slug} 已存在且属于他人` });
      }
      [row] = await this.db.update(mcpConfigs).set({ ...values, updatedAt: new Date() }).where(eq(mcpConfigs.id, existing.id)).returning();
      // 改了上游地址/凭证就别再让请求走旧缓存
      this.gateway.invalidateUpstream(row.id);
      // 关掉网关后原来的专属地址必须立刻作废，否则它会继续替所有人代理
      if (existing.gatewayEnabled && !row.gatewayEnabled) await this.gateway.revokeAll(row.id);
    } else {
      [row] = await this.db.insert(mcpConfigs).values({ ...values, slug: dto.slug, ownerId: user.id }).returning();
      // 作者自己的配置直接生效，不用等自己批自己
      await this.db
        .insert(mcpSubscriptions)
        .values({ userId: user.id, configId: row.id, status: 'approved', decidedBy: user.id, decidedAt: new Date() })
        .onConflictDoNothing();
    }
    await this.audit.record({
      actorId: user.id,
      action: existing ? 'mcp_config.updated' : 'mcp_config.created',
      targetType: 'mcp_config',
      targetId: row.id,
      meta: { slug: dto.slug },
    });
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId));
    const sets = await this.subscriptionSets(user.id);
    return this.toInfo(row, owner?.name ?? '', sets, user, await this.gatewayUrlFor(row, user, sets));
  }

  async remove(user: AuthUser, slug: string) {
    const row = await this.getBySlug(slug);
    if (row.ownerId !== user.id && user.role !== 'admin') {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅 Owner 或管理员可删除' });
    }
    await this.db.delete(mcpConfigs).where(eq(mcpConfigs.id, row.id));
    await this.audit.record({ actorId: user.id, action: 'mcp_config.deleted', targetType: 'mcp_config', targetId: row.id, meta: { slug } });
    return { ok: true };
  }

  /**
   * 订阅 = 提一条申请（决策 50）。Owner / 管理员订自己能审批的配置即时生效；
   * 已在角色模板里的配置也即时生效——那本就是管理员分配的范围，被排除后再加回来不该重走审批。
   */
  async subscribe(user: AuthUser, slug: string, dto: SubscribeMcpConfigRequest): Promise<SubscribeMcpConfigResult> {
    const row = await this.getBySlug(slug);
    const sets = await this.subscriptionSets(user.id);
    if (!this.canSee(row, user, sets)) throw new NotFoundException({ error: 'NOT_FOUND', message: `MCP 配置 ${slug} 不存在` });
    // 已经批过的别再动它：成员手上有一条 approved 时重复点订阅不能把自己打回 pending
    if (sets.approved.has(row.id)) return { status: 'approved' };

    const autoApprove = this.canApprove(row, user) || sets.template.has(row.id);
    const now = new Date();
    const values = {
      source: 'manual' as const,
      excluded: false,
      status: autoApprove ? ('approved' as const) : ('pending' as const),
      reason: dto.reason,
      decidedBy: autoApprove ? user.id : null,
      decidedAt: autoApprove ? now : null,
    };
    await this.db
      .insert(mcpSubscriptions)
      .values({ userId: user.id, configId: row.id, ...values })
      .onConflictDoUpdate({ target: [mcpSubscriptions.userId, mcpSubscriptions.configId], set: values });
    await this.syncGatewayAccess(user.id, row, sets.effective.has(row.id));
    await this.audit.record({
      actorId: user.id,
      action: autoApprove ? 'mcp_config.subscribed' : 'mcp_config.subscribe_requested',
      targetType: 'mcp_config',
      targetId: row.id,
      meta: { slug },
    });
    return { status: values.status };
  }

  /** 退订；申请还在 pending 时等于撤回申请 */
  async unsubscribe(user: AuthUser, slug: string) {
    const row = await this.getBySlug(slug);
    const sets = await this.subscriptionSets(user.id);
    const { template } = sets;
    if (template.has(row.id)) {
      const values = { source: 'template' as const, excluded: true, status: 'approved' as const };
      await this.db
        .insert(mcpSubscriptions)
        .values({ userId: user.id, configId: row.id, ...values })
        .onConflictDoUpdate({ target: [mcpSubscriptions.userId, mcpSubscriptions.configId], set: { excluded: true } });
    } else {
      await this.db
        .delete(mcpSubscriptions)
        .where(and(eq(mcpSubscriptions.userId, user.id), eq(mcpSubscriptions.configId, row.id)));
    }
    await this.syncGatewayAccess(user.id, row, sets.effective.has(row.id));
    await this.audit.record({
      actorId: user.id,
      action: 'mcp_config.unsubscribed',
      targetType: 'mcp_config',
      targetId: row.id,
      meta: { slug },
    });
    return { ok: true };
  }

  /** 审批范围：管理员见全部，其他人见自己 Own 的配置上的申请 */
  private approverScope(user: AuthUser): SQL | undefined {
    return user.role === 'admin' ? undefined : eq(mcpConfigs.ownerId, user.id);
  }

  /**
   * 我能审批的订阅申请。只认**自助申请**（source=manual）：管理员分配出去的订阅不是申请，
   * Owner / 管理员订阅自己配置时那条自批的记录（decided_by = user_id）也不该混进审批清单。
   */
  async requests(user: AuthUser, query: McpSubscriptionRequestQuery): Promise<McpSubscriptionRequest[]> {
    const isRequest = and(
      eq(mcpSubscriptions.source, 'manual'),
      or(
        eq(mcpSubscriptions.status, 'pending'),
        and(isNotNull(mcpSubscriptions.decidedBy), ne(mcpSubscriptions.decidedBy, mcpSubscriptions.userId)),
      ),
    );
    const where =
      query.status === 'pending'
        ? and(eq(mcpSubscriptions.status, 'pending'), isRequest, this.approverScope(user))
        : and(isRequest, this.approverScope(user));
    const rows = await this.db
      .select({
        sub: mcpSubscriptions,
        config: mcpConfigs,
        requesterName: requester.name,
        requesterEmail: requester.email,
        deciderName: decider.name,
      })
      .from(mcpSubscriptions)
      .innerJoin(mcpConfigs, eq(mcpSubscriptions.configId, mcpConfigs.id))
      .innerJoin(requester, eq(mcpSubscriptions.userId, requester.id))
      .leftJoin(decider, eq(mcpSubscriptions.decidedBy, decider.id))
      .where(where)
      // 待审批的排前面，其余按处理时间倒序
      .orderBy(desc(sql`case when ${mcpSubscriptions.status} = 'pending' then 1 else 0 end`), desc(mcpSubscriptions.createdAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.sub.id,
      configId: r.config.id,
      configSlug: r.config.slug,
      configName: r.config.name,
      configVisibility: r.config.visibility,
      userId: r.sub.userId,
      userName: r.requesterName,
      userEmail: r.requesterEmail,
      reason: r.sub.reason,
      status: r.sub.status,
      decidedBy: r.sub.decidedBy,
      decidedByName: r.sub.decidedBy ? (r.deciderName ?? '(已删除)') : null,
      decidedAt: r.sub.decidedAt?.toISOString() ?? null,
      createdAt: r.sub.createdAt.toISOString(),
    }));
  }

  async decide(user: AuthUser, id: string, dto: DecideMcpSubscriptionRequest) {
    const row = (await this.db.select().from(mcpSubscriptions).where(eq(mcpSubscriptions.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '订阅申请不存在' });
    const config = (await this.db.select().from(mcpConfigs).where(eq(mcpConfigs.id, row.configId)).limit(1))[0];
    if (!config) throw new NotFoundException({ error: 'NOT_FOUND', message: 'MCP 配置已删除' });
    if (!this.canApprove(config, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅配置 Owner 或管理员可审批' });
    }
    if (row.status !== 'pending') throw new ConflictException({ error: 'CONFLICT', message: '该申请已被处理' });
    const wasEffective = await this.subs.isEffective(row.userId, config.id);
    await this.db
      .update(mcpSubscriptions)
      .set({ status: dto.decision, decidedBy: user.id, decidedAt: new Date() })
      .where(eq(mcpSubscriptions.id, id));
    await this.syncGatewayAccess(row.userId, config, wasEffective);
    await this.audit.record({
      actorId: user.id,
      action: 'mcp_config.subscription_decided',
      targetType: 'mcp_config',
      targetId: config.id,
      meta: { slug: config.slug, decision: dto.decision, targetUserId: row.userId },
    });
    return { ok: true };
  }

  /** 订阅者明细与分配都归 Owner / 管理员——与审批同一条规则 */
  private async assertCanManageSubscribers(user: AuthUser, slug: string): Promise<ConfigRow> {
    const config = await this.getBySlug(slug);
    if (!this.canApprove(config, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅配置 Owner 或管理员可管理订阅者' });
    }
    return config;
  }

  /** 生效中的订阅者（审批通过的 + 模板派生的，去掉被排除的与已禁用的用户） */
  async subscribers(user: AuthUser, slug: string): Promise<McpSubscriber[]> {
    const config = await this.assertCanManageSubscribers(user, slug);
    const [subRows, tplRows, activeUsers] = await Promise.all([
      this.db
        .select({
          userId: mcpSubscriptions.userId,
          source: mcpSubscriptions.source,
          status: mcpSubscriptions.status,
          excluded: mcpSubscriptions.excluded,
          createdAt: mcpSubscriptions.createdAt,
          decidedAt: mcpSubscriptions.decidedAt,
        })
        .from(mcpSubscriptions)
        .where(eq(mcpSubscriptions.configId, config.id)),
      this.db
        .select({ userId: userTemplateSelections.userId })
        .from(userTemplateSelections)
        .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
        .where(and(eq(templateItems.itemType, 'mcp_config'), eq(templateItems.itemId, config.id))),
      this.db
        .select({ id: users.id, name: users.name, email: users.email, role: users.role })
        .from(users)
        .where(eq(users.status, 'active')),
    ]);
    const userById = new Map(activeUsers.map((u) => [u.id, u]));
    const out = new Map<string, McpSubscriber>();
    const excluded = new Set<string>();
    for (const r of subRows) {
      if (r.excluded) {
        excluded.add(r.userId);
        continue;
      }
      if (r.status !== 'approved') continue;
      const u = userById.get(r.userId);
      if (!u) continue;
      out.set(u.id, {
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        source: r.source,
        removable: true,
        subscribedAt: (r.decidedAt ?? r.createdAt).toISOString(),
      });
    }
    for (const r of tplRows) {
      if (excluded.has(r.userId) || out.has(r.userId)) continue;
      const u = userById.get(r.userId);
      if (!u) continue;
      out.set(u.id, {
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        source: 'template',
        removable: false,
        subscribedAt: null,
      });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  private async getTargetUser(userId: string): Promise<UserRow> {
    const row = (await this.db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    return row;
  }

  /** 主动分配：不公开的配置只有这一条路能到成员手里，所以这里不看可见性 */
  async addSubscriber(user: AuthUser, slug: string, dto: AddMcpSubscriberRequest) {
    const config = await this.assertCanManageSubscribers(user, slug);
    const target = await this.getTargetUser(dto.userId);
    if (target.status !== 'active') {
      throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '该用户已禁用，无法为其订阅' });
    }
    const decided = { status: 'approved' as const, excluded: false, decidedBy: user.id, decidedAt: new Date() };
    const wasEffective = await this.subs.isEffective(target.id, config.id);
    await this.db
      .insert(mcpSubscriptions)
      .values({ userId: target.id, configId: config.id, source: 'admin', ...decided })
      // 对方本来挂着一条待审批申请时，这一步就是批准它：source 保持 manual，不抹掉申请痕迹
      .onConflictDoUpdate({ target: [mcpSubscriptions.userId, mcpSubscriptions.configId], set: decided });
    await this.syncGatewayAccess(target.id, config, wasEffective);
    await this.audit.record({
      actorId: user.id,
      action: 'mcp_config.subscriber_added',
      targetType: 'mcp_config',
      targetId: config.id,
      meta: { slug, targetUserId: target.id, targetUserEmail: target.email },
    });
    return { ok: true };
  }

  async removeSubscriber(user: AuthUser, slug: string, targetUserId: string) {
    const config = await this.assertCanManageSubscribers(user, slug);
    const target = await this.getTargetUser(targetUserId);
    const fromTemplate = (
      await this.db
        .select({ userId: userTemplateSelections.userId })
        .from(userTemplateSelections)
        .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
        .where(
          and(
            eq(userTemplateSelections.userId, target.id),
            eq(templateItems.itemType, 'mcp_config'),
            eq(templateItems.itemId, config.id),
          ),
        )
        .limit(1)
    ).length > 0;
    if (fromTemplate) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '该订阅来自角色模板，请在模板里移除这个配置，或让对方改选模板',
      });
    }
    const wasEffective = await this.subs.isEffective(target.id, config.id);
    await this.db
      .delete(mcpSubscriptions)
      .where(and(eq(mcpSubscriptions.userId, target.id), eq(mcpSubscriptions.configId, config.id)));
    await this.syncGatewayAccess(target.id, config, wasEffective);
    await this.audit.record({
      actorId: user.id,
      action: 'mcp_config.subscriber_removed',
      targetType: 'mcp_config',
      targetId: config.id,
      meta: { slug, targetUserId: target.id, targetUserEmail: target.email },
    });
    return { ok: true };
  }

  /**
   * sync 渲染：只含审批通过（或模板派生）的订阅。两种形态（决策 51）：
   *
   * - **经网关分发**：产出一条专属 URL，不含任何上游信息；凭证在服务端解析，
   *   不落用户磁盘，`unresolved` 恒空——成员不需要对应变量的读取权限。
   * - **直连**：仍按用户权限解析 `${env:slug/KEY}`。有权限 → 实际值（经 pullValues，
   *   落 secret.read 审计）；无权限/不存在 → 保留占位符并在 unresolved 中给出申请指引。
   */
  async syncBundle(user: AuthUser): Promise<RenderedMcpConfig[]> {
    const sets = await this.subscriptionSets(user.id);
    if (sets.effective.size === 0) return [];
    const rows = await this.db.select().from(mcpConfigs).where(inArray(mcpConfigs.id, [...sets.effective]));
    const all = rows.filter((r) => this.canSee(r, user, sets));
    const gatewayRows = all.filter((r) => r.gatewayEnabled);
    const visible = all.filter((r) => !r.gatewayEnabled);

    const gatewayEntries: RenderedMcpConfig[] = await Promise.all(
      gatewayRows.map(async (c) => ({
        slug: c.slug,
        name: c.name,
        viaGateway: true,
        server: { type: 'http', url: await this.gateway.ensureUrl(user.id, c) },
        unresolved: [],
      })),
    );

    // 汇总所有引用，按环境批量解值（一次审计一条）
    const refsByEnv = new Map<string, Set<string>>();
    const collect = (value: string) => {
      for (const m of value.matchAll(ENV_REF_PATTERN)) {
        if (!refsByEnv.has(m[1])) refsByEnv.set(m[1], new Set());
        refsByEnv.get(m[1])!.add(m[2]);
      }
    };
    for (const c of visible) {
      Object.values(c.env).forEach(collect);
      Object.values(c.headers).forEach(collect);
    }
    const resolved = new Map<string, string>();
    const denied = new Map<string, string>();
    for (const [envSlug, keys] of refsByEnv) {
      try {
        const res = await this.envs.pullValues(user, envSlug, [...keys], undefined);
        for (const [k, v] of Object.entries(res.values)) resolved.set(`${envSlug}/${k}`, v);
        for (const d of res.denied) denied.set(`${envSlug}/${d.key}`, d.howToRequest);
      } catch {
        for (const k of keys) denied.set(`${envSlug}/${k}`, `环境 ${envSlug} 不存在或不可见`);
      }
    }

    const directEntries = visible.map((c) => {
      const unresolved: RenderedMcpConfig['unresolved'] = [];
      const render = (value: string) =>
        value.replace(ENV_REF_PATTERN, (whole, envSlug: string, key: string) => {
          const hit = resolved.get(`${envSlug}/${key}`);
          if (hit !== undefined) return hit;
          unresolved.push({
            ref: whole,
            environment: envSlug,
            key,
            howToRequest: denied.get(`${envSlug}/${key}`) ?? '无读取权限，请通过 request_access 申请',
          });
          return whole;
        });
      const renderKv = (kv: Record<string, string>) =>
        Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, render(v)]));

      const server: Record<string, unknown> =
        c.transport === 'stdio'
          ? { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: renderKv(c.env) } : {}) }
          : {
              type: 'http',
              url: c.url,
              ...(Object.keys(c.headers).length ? { headers: renderKv(c.headers) } : {}),
              ...(Object.keys(c.env).length ? { env: renderKv(c.env) } : {}),
            };
      return { slug: c.slug, name: c.name, viaGateway: false, server, unresolved };
    });

    return [...gatewayEntries, ...directEntries].sort((a, b) => a.slug.localeCompare(b.slug));
  }
}
