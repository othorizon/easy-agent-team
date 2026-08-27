import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { McpConfigInfo, RenderedMcpConfig, UpsertMcpConfigRequest } from '@eat/shared';
import { ENV_REF_PATTERN } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { mcpConfigs, mcpSubscriptions, templateItems, users, userTemplateSelections } from '../db/schema';
import { EnvsService } from '../envs/envs.service';

type ConfigRow = typeof mcpConfigs.$inferSelect;

@Injectable()
export class McpConfigsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly envs: EnvsService,
    private readonly audit: AuditService,
  ) {}

  private canSee(row: ConfigRow, user: AuthUser): boolean {
    return row.visibility === 'team' || row.ownerId === user.id || user.role === 'admin';
  }

  private async getBySlug(slug: string): Promise<ConfigRow> {
    const row = (await this.db.select().from(mcpConfigs).where(eq(mcpConfigs.slug, slug)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `MCP 配置 ${slug} 不存在` });
    return row;
  }

  private async subscriptionSets(userId: string) {
    const rows = await this.db
      .select({ configId: mcpSubscriptions.configId, excluded: mcpSubscriptions.excluded })
      .from(mcpSubscriptions)
      .where(eq(mcpSubscriptions.userId, userId));
    const subs = new Set(rows.filter((r) => !r.excluded).map((r) => r.configId));
    const excluded = new Set(rows.filter((r) => r.excluded).map((r) => r.configId));
    const template = new Set(
      (
        await this.db
          .select({ itemId: templateItems.itemId })
          .from(userTemplateSelections)
          .innerJoin(templateItems, eq(userTemplateSelections.templateId, templateItems.templateId))
          .where(and(eq(userTemplateSelections.userId, userId), eq(templateItems.itemType, 'mcp_config')))
      ).map((r) => r.itemId),
    );
    const effective = new Set(subs);
    for (const id of template) if (!excluded.has(id)) effective.add(id);
    return { subs, template, effective };
  }

  private toInfo(row: ConfigRow, ownerName: string, subscribed: boolean): McpConfigInfo {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      transport: row.transport,
      command: row.command,
      args: row.args,
      url: row.url,
      headers: row.headers,
      env: row.env,
      visibility: row.visibility,
      ownerId: row.ownerId,
      ownerName,
      subscribed,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(user: AuthUser): Promise<McpConfigInfo[]> {
    const rows = await this.db
      .select({ config: mcpConfigs, ownerName: users.name })
      .from(mcpConfigs)
      .innerJoin(users, eq(mcpConfigs.ownerId, users.id))
      .orderBy(asc(mcpConfigs.slug));
    const { effective } = await this.subscriptionSets(user.id);
    return rows.filter((r) => this.canSee(r.config, user)).map((r) => this.toInfo(r.config, r.ownerName, effective.has(r.config.id)));
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
    };
    if (existing) {
      if (existing.ownerId !== user.id && user.role !== 'admin') {
        throw new ForbiddenException({ error: 'FORBIDDEN', message: `MCP 配置 ${dto.slug} 已存在且属于他人` });
      }
      [row] = await this.db.update(mcpConfigs).set({ ...values, updatedAt: new Date() }).where(eq(mcpConfigs.id, existing.id)).returning();
    } else {
      [row] = await this.db.insert(mcpConfigs).values({ ...values, slug: dto.slug, ownerId: user.id }).returning();
      await this.db.insert(mcpSubscriptions).values({ userId: user.id, configId: row.id }).onConflictDoNothing();
    }
    await this.audit.record({
      actorId: user.id,
      action: existing ? 'mcp_config.updated' : 'mcp_config.created',
      targetType: 'mcp_config',
      targetId: row.id,
      meta: { slug: dto.slug },
    });
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId));
    return this.toInfo(row, owner?.name ?? '', true);
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

  async subscribe(user: AuthUser, slug: string) {
    const row = await this.getBySlug(slug);
    if (!this.canSee(row, user)) throw new NotFoundException({ error: 'NOT_FOUND', message: `MCP 配置 ${slug} 不存在` });
    await this.db
      .insert(mcpSubscriptions)
      .values({ userId: user.id, configId: row.id })
      .onConflictDoUpdate({ target: [mcpSubscriptions.userId, mcpSubscriptions.configId], set: { excluded: false, source: 'manual' } });
    return { ok: true };
  }

  async unsubscribe(user: AuthUser, slug: string) {
    const row = await this.getBySlug(slug);
    const { template } = await this.subscriptionSets(user.id);
    if (template.has(row.id)) {
      await this.db
        .insert(mcpSubscriptions)
        .values({ userId: user.id, configId: row.id, source: 'template', excluded: true })
        .onConflictDoUpdate({ target: [mcpSubscriptions.userId, mcpSubscriptions.configId], set: { excluded: true } });
    } else {
      await this.db
        .delete(mcpSubscriptions)
        .where(and(eq(mcpSubscriptions.userId, user.id), eq(mcpSubscriptions.configId, row.id)));
    }
    return { ok: true };
  }

  /**
   * sync 渲染：按用户权限解析 ${env:slug/KEY} 引用。
   * 有权限 → 实际值（经 pullValues，落 secret.read 审计）；
   * 无权限/不存在 → 保留占位符并在 unresolved 中给出申请指引。
   */
  async syncBundle(user: AuthUser): Promise<RenderedMcpConfig[]> {
    const { subs, effective } = await this.subscriptionSets(user.id);
    void subs;
    if (effective.size === 0) return [];
    const rows = await this.db.select().from(mcpConfigs).where(inArray(mcpConfigs.id, [...effective]));
    const visible = rows.filter((r) => this.canSee(r, user));

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

    return visible.map((c) => {
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
      return { slug: c.slug, name: c.name, server, unresolved };
    });
  }
}
