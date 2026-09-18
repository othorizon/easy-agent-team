import { ForbiddenException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { McpGatewayCall, McpGatewayCallList, McpGatewayCallQuery } from '@eat/shared';
import { ENV_REF_PATTERN } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { loadConfig } from '../config';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { mcpConfigs, mcpGatewayCalls, mcpGatewayTokens, users } from '../db/schema';
import { EnvsService } from '../envs/envs.service';
import { assertSafeUpstream, UpstreamRejected } from './upstream';

type ConfigRow = typeof mcpConfigs.$inferSelect;

/** 解析好的上游目标：地址与要注入的 header（都可能含凭证，**不要写进任何日志**） */
export interface UpstreamTarget {
  url: URL;
  headers: Record<string, string>;
}

/** 网关解析出的调用者身份 */
export interface GatewayIdentity {
  tokenId: string;
  user: AuthUser;
  config: ConfigRow;
}

interface CachedUpstream {
  target: UpstreamTarget;
  /** 配置的 updatedAt，配置一改缓存立即失效 */
  stamp: number;
  expiresAt: number;
}

/** 上游凭证缓存时长：够挡住一次对话里的连续工具调用，又不至于让改凭证迟迟不生效 */
const UPSTREAM_CACHE_MS = 60_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class McpGatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly upstreamCache = new Map<string, CachedUpstream>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    // 调用记录保留期清扫。server 里没有任何调度器（pg-boss 在选型里但从未引入），
    // 为一张表的过期清理引一个队列不成比例，模块内自带一个每日定时足够。
    this.sweepTimer = setInterval(() => void this.sweepCalls(), SWEEP_INTERVAL_MS);
    // 必须 unref：否则 e2e 跑完进程挂着不退
    this.sweepTimer.unref();
    void this.sweepCalls();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async sweepCalls() {
    const days = loadConfig().mcpGatewayCallRetentionDays;
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      await this.db.delete(mcpGatewayCalls).where(lt(mcpGatewayCalls.createdAt, cutoff));
    } catch {
      // 清扫失败不影响业务，下一次再来
    }
  }

  // ---------- token 签发与吊销 ----------

  /**
   * 签发专属接入 token：**新建一条 + 吊销这一对 (user, config) 上所有旧的**。
   *
   * 「吊销旧的」放在签发里而不是散落在每个改权限的地方，是这套设计的关键：
   * 授权会从至少六条路径消失（退订、驳回、移除订阅者、管理员改模板内容、
   * 用户改选模板、配置删除/用户禁用），逐个去加吊销代码早晚漏一条，
   * 漏的那条就是一个永久有效的后门 URL。这里只保证「重新授权必换新地址、旧地址永久作废」，
   * 至于「授权已经没了的旧 token 还能不能用」由 resolve() 每次实时复算兜住。
   */
  async mint(userId: string, configId: string): Promise<string> {
    const token = randomToken('eatg');
    await this.db
      .update(mcpGatewayTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpGatewayTokens.userId, userId),
          eq(mcpGatewayTokens.configId, configId),
          isNull(mcpGatewayTokens.revokedAt),
        ),
      );
    await this.db.insert(mcpGatewayTokens).values({
      userId,
      configId,
      tokenHash: sha256Hex(token),
      tokenEncrypted: encryptSecret(token),
      prefix: token.slice(0, 11),
    });
    return token;
  }

  /** 吊销某人在某配置上的接入地址（授权消失时调用；漏调用不会造成漏洞，只是旧行没标记） */
  async revoke(userId: string, configId: string): Promise<void> {
    await this.db
      .update(mcpGatewayTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(mcpGatewayTokens.userId, userId),
          eq(mcpGatewayTokens.configId, configId),
          isNull(mcpGatewayTokens.revokedAt),
        ),
      );
  }

  /** 吊销某个配置上所有人的接入地址（关掉网关开关、或配置本身不该再被代理时） */
  async revokeAll(configId: string): Promise<void> {
    await this.db
      .update(mcpGatewayTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mcpGatewayTokens.configId, configId), isNull(mcpGatewayTokens.revokedAt)));
    this.upstreamCache.delete(configId);
  }

  /** 当前有效 token 的明文；没有则返回 null（不自动签发，调用方决定） */
  private async activeToken(userId: string, configId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ tokenEncrypted: mcpGatewayTokens.tokenEncrypted })
        .from(mcpGatewayTokens)
        .where(
          and(
            eq(mcpGatewayTokens.userId, userId),
            eq(mcpGatewayTokens.configId, configId),
            isNull(mcpGatewayTokens.revokedAt),
          ),
        )
        .orderBy(desc(mcpGatewayTokens.createdAt))
        .limit(1)
    )[0];
    if (!row) return null;
    try {
      return decryptSecret(row.tokenEncrypted);
    } catch {
      return null; // KEK 换过导致解不开：当作没有，下面会重新签发
    }
  }

  /** 拼完整接入地址 */
  private toUrl(slug: string, token: string): string {
    return `${loadConfig().publicUrl}/mcp/${slug}/${token}`;
  }

  /**
   * 拿当前接入地址，没有就懒签发一条。
   * 懒签发让 token 只对真正取过配置的人存在，也省掉「给所有历史订阅补签」的迁移。
   */
  async ensureUrl(userId: string, config: Pick<ConfigRow, 'id' | 'slug'>): Promise<string> {
    const existing = await this.activeToken(userId, config.id);
    if (existing) return this.toUrl(config.slug, existing);
    return this.toUrl(config.slug, await this.mint(userId, config.id));
  }

  /** 重新生成（用户主动换地址，例如怀疑 URL 泄漏过）；旧地址立即作废 */
  async regenerate(user: AuthUser, slug: string, isEffective: (configId: string) => Promise<boolean>): Promise<string> {
    const config = (await this.db.select().from(mcpConfigs).where(eq(mcpConfigs.slug, slug)).limit(1))[0];
    if (!config) throw new NotFoundException({ error: 'NOT_FOUND', message: `MCP 配置 ${slug} 不存在` });
    if (!config.gatewayEnabled) {
      throw new ForbiddenException({ error: 'VALIDATION_FAILED', message: '该配置不经网关分发，没有专属接入地址' });
    }
    if (!(await isEffective(config.id))) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '你还没有这个配置的订阅' });
    }
    const token = await this.mint(user.id, config.id);
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'mcp_gateway.url_regenerated',
      targetType: 'mcp_config',
      targetId: config.id,
      meta: { slug },
    });
    return this.toUrl(config.slug, token);
  }

  // ---------- 请求鉴权 ----------

  /**
   * 解析路径里的 token → 调用者身份。
   *
   * 命中一行之后**必须实时复算授权**（订阅仍生效、用户仍启用、配置仍在且仍走网关），
   * 这是漏掉某条吊销路径时唯一的防线。不通过就就地标记吊销，省得下次再算。
   */
  async resolve(
    slug: string,
    token: string,
    stillEffective: (userId: string, configId: string) => Promise<boolean>,
  ): Promise<GatewayIdentity | null> {
    const row = (
      await this.db
        .select({
          tokenId: mcpGatewayTokens.id,
          config: mcpConfigs,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          status: users.status,
        })
        .from(mcpGatewayTokens)
        .innerJoin(mcpConfigs, eq(mcpGatewayTokens.configId, mcpConfigs.id))
        .innerJoin(users, eq(mcpGatewayTokens.userId, users.id))
        .where(and(eq(mcpGatewayTokens.tokenHash, sha256Hex(token)), isNull(mcpGatewayTokens.revokedAt)))
        .limit(1)
    )[0];
    if (!row) return null;
    // slug 对不上：同一个 token 只服务它被签发的那个配置
    if (row.config.slug !== slug) return null;
    if (row.status !== 'active' || !row.config.gatewayEnabled) {
      await this.db.update(mcpGatewayTokens).set({ revokedAt: new Date() }).where(eq(mcpGatewayTokens.id, row.tokenId));
      return null;
    }
    if (!(await stillEffective(row.userId, row.config.id))) {
      await this.db.update(mcpGatewayTokens).set({ revokedAt: new Date() }).where(eq(mcpGatewayTokens.id, row.tokenId));
      return null;
    }
    void this.db
      .update(mcpGatewayTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(mcpGatewayTokens.id, row.tokenId))
      .catch(() => undefined);
    return {
      tokenId: row.tokenId,
      user: { id: row.userId, name: row.name, email: row.email, role: row.role, tokenId: row.tokenId },
      config: row.config,
    };
  }

  // ---------- 上游解析 ----------

  /**
   * 解析上游地址与 header，并做地址安全校验。
   *
   * 凭证按**配置 Owner 的授权**解析（readValuesForGateway），不按调用者——
   * 网关模式下「订阅已被批准」就是授权，成员不需要也不该拥有对应变量的读取权限，
   * 否则他自己 `eat env pull` 就能把凭证拿走，网关等于什么都没藏。
   * 按配置粒度缓存，顺带把「每次工具调用写一条 secret.read」这个审计洪水挡掉。
   */
  async resolveUpstream(config: ConfigRow): Promise<UpstreamTarget> {
    const stamp = config.updatedAt.getTime();
    const cached = this.upstreamCache.get(config.id);
    if (cached && cached.stamp === stamp && cached.expiresAt > Date.now()) return cached.target;

    const refs = new Map<string, Set<string>>();
    const collect = (value: string) => {
      for (const m of value.matchAll(ENV_REF_PATTERN)) {
        if (!refs.has(m[1])) refs.set(m[1], new Set());
        refs.get(m[1])!.add(m[2]);
      }
    };
    collect(config.url ?? '');
    Object.values(config.headers).forEach(collect);

    const resolved = refs.size > 0 ? await this.envs.readValuesForGateway(refs) : new Map<string, string>();
    const missing: string[] = [];
    const render = (value: string) =>
      value.replace(ENV_REF_PATTERN, (whole, envSlug: string, key: string) => {
        const hit = resolved.get(`${envSlug}/${key}`);
        if (hit === undefined) {
          missing.push(`${envSlug}/${key}`);
          return whole;
        }
        return hit;
      });

    const rawUrl = render(config.url ?? '');
    const headers = Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, render(v)]));
    if (missing.length > 0) {
      // 引用的变量被删了/环境没了：拒掉整次请求，而不是拿着占位符去打上游
      throw new UpstreamRejected('这个服务的凭证配置不完整，请联系配置负责人');
    }
    const url = await assertSafeUpstream(rawUrl);
    const target: UpstreamTarget = { url, headers };

    if (refs.size > 0) {
      // 按配置粒度记一条，不是按调用记；actorId 留空表示这是平台为网关代解，不是某个人读了值
      await this.audit.record({
        actorId: null,
        action: 'mcp_gateway.credentials_resolved',
        targetType: 'mcp_config',
        targetId: config.id,
        meta: { slug: config.slug, refs: [...resolved.keys()] },
      });
    }
    this.upstreamCache.set(config.id, { target, stamp, expiresAt: Date.now() + UPSTREAM_CACHE_MS });
    return target;
  }

  /** 配置被改动时立刻丢掉缓存（改了凭证不该还要等一分钟） */
  invalidateUpstream(configId: string) {
    this.upstreamCache.delete(configId);
  }

  // ---------- 调用记录 ----------

  async recordCall(entry: {
    tokenId: string | null;
    userId: string | null;
    configId: string | null;
    method: string | null;
    toolName: string | null;
    status: number;
    durationMs: number;
    error?: string | null;
  }): Promise<void> {
    try {
      await this.db.insert(mcpGatewayCalls).values({
        tokenId: entry.tokenId,
        userId: entry.userId,
        configId: entry.configId,
        method: entry.method,
        toolName: entry.toolName,
        status: entry.status,
        durationMs: entry.durationMs,
        error: entry.error ?? null,
      });
    } catch {
      // 记流量不能影响转发本身
    }
  }

  /** 我能看的调用记录：管理员全部，其他人自己 Own 的配置（与订阅者管理同一条规则） */
  async calls(user: AuthUser, query: McpGatewayCallQuery): Promise<McpGatewayCallList> {
    const scoped = await this.db
      .select({ id: mcpConfigs.id, slug: mcpConfigs.slug, name: mcpConfigs.name })
      .from(mcpConfigs)
      .where(user.role === 'admin' ? undefined : eq(mcpConfigs.ownerId, user.id));
    const allowed = query.slug ? scoped.filter((c) => c.slug === query.slug) : scoped;
    if (allowed.length === 0) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };

    const filters: SQL[] = [inArray(mcpGatewayCalls.configId, allowed.map((c) => c.id))];
    if (query.userId) filters.push(eq(mcpGatewayCalls.userId, query.userId));
    const where = and(...filters);

    const [{ total }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(mcpGatewayCalls)
      .where(where);
    const rows = await this.db
      .select({ call: mcpGatewayCalls, userName: users.name })
      .from(mcpGatewayCalls)
      .leftJoin(users, eq(mcpGatewayCalls.userId, users.id))
      .where(where)
      .orderBy(desc(mcpGatewayCalls.createdAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const byId = new Map(allowed.map((c) => [c.id, c]));
    const items: McpGatewayCall[] = rows.map((r) => {
      const config = r.call.configId ? byId.get(r.call.configId) : undefined;
      return {
        id: r.call.id,
        configSlug: config?.slug ?? '(已删除)',
        configName: config?.name ?? '(已删除)',
        userId: r.call.userId,
        userName: r.userName ?? '(已删除)',
        method: r.call.method,
        toolName: r.call.toolName,
        status: r.call.status,
        durationMs: r.call.durationMs,
        error: r.call.error,
        createdAt: r.call.createdAt.toISOString(),
      };
    });
    return { items, total: Number(total), page: query.page, pageSize: query.pageSize };
  }
}
