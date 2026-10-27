import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type {
  CreateEnvironmentRequest,
  CreateGrantRequest,
  EnvironmentAccess,
  EnvironmentInfo,
  EnvListQuery,
  EnvListResult,
  ImportVariablesRequest,
  ImportVariablesResult,
  PullValuesResponse,
  UpdateEnvironmentRequest,
  UpsertVariableRequest,
  UpsertVariableResult,
  VariableMeta,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { accessRequests, environments, envVariables, users, variableGrants } from '../db/schema';

type EnvRow = typeof environments.$inferSelect;
type VarRow = typeof envVariables.$inferSelect;
type EnvTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type EnvAccessInfo = Pick<EnvironmentInfo, 'access' | 'readableCount' | 'pendingRequest'>;

const HOW_TO_REQUEST =
  '无读取权限。请通过 MCP 工具 request_access（或 CLI：eat env request）附理由发起权限申请，资源 Owner 批准后重试。';

@Injectable()
export class EnvsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- 基础 ----------

  async getEnvBySlug(slug: string, user: AuthUser): Promise<EnvRow> {
    const row = (
      await this.db.select().from(environments).where(eq(environments.slug, slug)).limit(1)
    )[0];
    if (!row || (row.visibility === 'private' && row.ownerId !== user.id)) throw new NotFoundException({ error: 'NOT_FOUND', message: `环境 ${slug} 不存在` });
    return row;
  }

  /** 私有环境仅 Owner；团队环境允许平台管理员管理。 */
  canManage(env: EnvRow, user: AuthUser): boolean {
    return env.ownerId === user.id || (env.visibility !== 'private' && user.role === 'admin');
  }

  private assertManage(env: EnvRow, user: AuthUser) {
    if (!this.canManage(env, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅环境 Owner 或管理员可执行此操作' });
    }
  }

  /** 与切换 private 共用环境行锁，避免旧表单或并发授权在收回权限后重新写入。 */
  private async withManagedEnvironment<T>(user: AuthUser, slug: string, write: (tx: EnvTransaction, env: EnvRow) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const [env] = await tx.select().from(environments).where(eq(environments.slug, slug)).for('update');
      if (!env || (env.visibility === 'private' && env.ownerId !== user.id)) {
        throw new NotFoundException({ error: 'NOT_FOUND', message: `环境 ${slug} 不存在` });
      }
      this.assertManage(env, user);
      return write(tx, env);
    });
  }

  /** 用户在某环境下可读值的变量 id 集合（含环境级授权 → 返回 'ALL'） */
  private async accessibleSet(user: AuthUser, env: EnvRow): Promise<'ALL' | Set<string>> {
    if (this.canManage(env, user)) return 'ALL';
    const now = new Date();
    const grants = await this.db
      .select({ variableId: variableGrants.variableId, environmentId: variableGrants.environmentId })
      .from(variableGrants)
      .where(
        and(
          eq(variableGrants.userId, user.id),
          or(isNull(variableGrants.expiresAt), gt(variableGrants.expiresAt, now)),
        ),
      );
    if (grants.some((g) => g.environmentId === env.id)) return 'ALL';
    return new Set(grants.filter((g) => g.variableId).map((g) => g.variableId!));
  }

  /**
   * 一次查出当前用户在所有环境上的读值能力，供清单逐行标注（口径与 accessibleSet 一致：
   * 能管理 → 全部；环境级授权 → 全部；否则数变量级授权），外加自己待审批的申请落在哪些环境上
   */
  private async accessResolver(user: AuthUser): Promise<(env: EnvRow, variableCount: number) => EnvAccessInfo> {
    const now = new Date();
    const grants = await this.db
      .select({
        environmentId: variableGrants.environmentId,
        variableId: variableGrants.variableId,
        variableEnvId: envVariables.environmentId,
      })
      .from(variableGrants)
      .leftJoin(envVariables, eq(envVariables.id, variableGrants.variableId))
      .where(
        and(
          eq(variableGrants.userId, user.id),
          or(isNull(variableGrants.expiresAt), gt(variableGrants.expiresAt, now)),
        ),
      );
    const envGrants = new Set<string>();
    const varGrants = new Map<string, Set<string>>();
    for (const g of grants) {
      if (g.environmentId) envGrants.add(g.environmentId);
      else if (g.variableId && g.variableEnvId) {
        const set = varGrants.get(g.variableEnvId) ?? new Set<string>();
        set.add(g.variableId);
        varGrants.set(g.variableEnvId, set);
      }
    }
    const pending = await this.db
      .select({ environmentId: accessRequests.environmentId })
      .from(accessRequests)
      .where(and(eq(accessRequests.requesterId, user.id), eq(accessRequests.status, 'pending')));
    const pendingEnvs = new Set(pending.map((r) => r.environmentId));

    return (env, variableCount) => {
      const pendingRequest = pendingEnvs.has(env.id);
      if (this.canManage(env, user)) return { access: 'manage', readableCount: variableCount, pendingRequest };
      if (envGrants.has(env.id)) return { access: 'all', readableCount: variableCount, pendingRequest };
      const readableCount = varGrants.get(env.id)?.size ?? 0;
      // 每个变量都单独授权过，对用户来说和环境级授权没有区别
      const access: EnvironmentAccess =
        readableCount === 0 ? 'none' : readableCount >= variableCount ? 'all' : 'partial';
      return { access, readableCount, pendingRequest };
    };
  }

  // ---------- 环境 CRUD ----------

  /** 当前用户可见的环境（按 slug 排序）：先过滤权限，再搜索、计数和分页。 */
  private async loadEnvironments(user: AuthUser): Promise<EnvironmentInfo[]> {
    const rows = await this.db
      .select({
        env: environments,
        ownerName: users.name,
        ownerEmail: users.email,
        variableCount: count(envVariables.id),
      })
      .from(environments)
      .innerJoin(users, eq(environments.ownerId, users.id))
      .leftJoin(envVariables, eq(envVariables.environmentId, environments.id))
      .where(or(eq(environments.visibility, 'team'), eq(environments.ownerId, user.id)))
      .groupBy(environments.id, users.name, users.email)
      .orderBy(asc(environments.slug));
    const accessOf = await this.accessResolver(user);
    return rows.map((r) => ({
      id: r.env.id,
      slug: r.env.slug,
      name: r.env.name,
      description: r.env.description,
      visibility: r.env.visibility,
      ownerId: r.env.ownerId,
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
      variableCount: Number(r.variableCount),
      ...accessOf(r.env, Number(r.variableCount)),
      createdAt: r.env.createdAt.toISOString(),
    }));
  }

  /**
   * 清单：关键词 → 计数 → 范围筛选 → 分页（决策 39 / 88）。
   * 范围（全部 / 我的 / 可读取）的数字回答「在当前搜索下切过去会有几条」，scope 自己不参与计数
   * （与 Skill 清单的 scope 计数同一思路）。数据库凭证不在环境里（决策 91），没有来源这个维度了
   */
  async listEnvironments(user: AuthUser, query: EnvListQuery): Promise<EnvListResult> {
    const all = await this.loadEnvironments(user);
    const keyword = query.q?.toLowerCase() ?? '';
    const narrowed = keyword
      ? all.filter((e) =>
          `${e.slug}\n${e.name}\n${e.description}`.toLowerCase().includes(keyword),
        )
      : all;
    const inScope = (e: EnvironmentInfo, scope: EnvListQuery['scope']) =>
      scope === 'all' || (scope === 'mine' ? e.ownerId === user.id : e.access !== 'none');
    const scopeCounts = { all: 0, mine: 0, readable: 0 };
    for (const e of narrowed) {
      for (const scope of ['all', 'mine', 'readable'] as const) if (inScope(e, scope)) scopeCounts[scope] += 1;
    }

    const filtered = narrowed.filter((e) => inScope(e, query.scope));
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      scopeCounts,
    };
  }

  /** 单个环境的信息（详情页用；清单已分页，靠翻清单找一条不可靠） */
  async getEnvironment(user: AuthUser, slug: string): Promise<EnvironmentInfo> {
    const env = await this.getEnvBySlug(slug, user);
    const [owner] = await this.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, env.ownerId));
    const [{ variableCount }] = await this.db
      .select({ variableCount: count(envVariables.id) })
      .from(envVariables)
      .where(eq(envVariables.environmentId, env.id));
    const accessOf = await this.accessResolver(user);
    return {
      id: env.id,
      slug: env.slug,
      name: env.name,
      description: env.description,
      visibility: env.visibility,
      ownerId: env.ownerId,
      ownerName: owner?.name ?? '(已删除)',
      ownerEmail: owner?.email ?? '',
      variableCount: Number(variableCount),
      ...accessOf(env, Number(variableCount)),
      createdAt: env.createdAt.toISOString(),
    };
  }

  async createEnvironment(user: AuthUser, dto: CreateEnvironmentRequest) {
    const exists = await this.db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.slug, dto.slug))
      .limit(1);
    if (exists.length > 0) throw new ConflictException({ error: 'CONFLICT', message: `环境 ${dto.slug} 已存在` });
    const [row] = await this.db
      .insert(environments)
      .values({ slug: dto.slug, name: dto.name, description: dto.description, visibility: dto.visibility, ownerId: user.id })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'env.created', targetType: 'environment', targetId: row.id });
    return row;
  }

  async updateEnvironment(user: AuthUser, slug: string, dto: UpdateEnvironmentRequest) {
    const env = await this.getEnvBySlug(slug, user);
    this.assertManage(env, user);
    if (dto.visibility !== undefined && dto.visibility !== env.visibility && env.ownerId !== user.id) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅环境 Owner 可修改环境可见性' });
    }
    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(environments).where(eq(environments.id, env.id)).for('update');
      if (!current) throw new NotFoundException('环境不存在');
      this.assertManage(current, user);
      const [updated] = await tx.update(environments)
        .set({ name: dto.name ?? current.name, description: dto.description ?? current.description, visibility: dto.visibility ?? current.visibility })
        .where(eq(environments.id, env.id)).returning();
      if (updated.visibility === 'private') {
        await tx.update(envVariables).set({ visibleWithoutPermission: false }).where(eq(envVariables.environmentId, env.id));
        const vars = tx.select({ id: envVariables.id }).from(envVariables).where(eq(envVariables.environmentId, env.id));
        await tx.delete(variableGrants).where(or(eq(variableGrants.environmentId, env.id), inArray(variableGrants.variableId, vars)));
        await tx.update(accessRequests).set({ status: 'invalid', decidedAt: new Date() })
          .where(and(eq(accessRequests.environmentId, env.id), eq(accessRequests.status, 'pending')));
      }
      return updated;
    });
    await this.audit.record({ actorId: user.id, action: 'env.updated', targetType: 'environment', targetId: env.id });
    return row;
  }

  async deleteEnvironment(user: AuthUser, slug: string) {
    const env = await this.getEnvBySlug(slug, user);
    this.assertManage(env, user);
    await this.db.delete(environments).where(eq(environments.id, env.id));
    await this.audit.record({ actorId: user.id, action: 'env.deleted', targetType: 'environment', targetId: env.id });
    return { ok: true };
  }

  // ---------- 变量 ----------

  /** 变量取值：敏感值解密，非敏感值直接取明文列 */
  private readValue(v: VarRow): string {
    return v.secret ? decryptSecret(v.valueEncrypted ?? '') : (v.valuePlain ?? '');
  }

  private toMeta(v: VarRow, envSlug: string, hasAccess: boolean): VariableMeta {
    return {
      id: v.id,
      environmentSlug: envSlug,
      key: v.key,
      description: v.description,
      visibleWithoutPermission: v.visibleWithoutPermission,
      secret: v.secret,
      // 非敏感只是「明文存储、有权限者平台上直接明文可见」；无权限者拿不到值
      value: !v.secret && hasAccess ? (v.valuePlain ?? '') : null,
      hasAccess,
      version: v.version,
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  /**
   * 变量清单。核心可见性规则：
   * 有权限 → 可见且 hasAccess=true（非敏感变量直接附带明文值）；
   * 无权限但变量配置为"无权限可见"（默认）→ 可见、hasAccess=false、不含值；
   * 无权限且配置为不可见 → 不出现在清单。
   */
  async listVariables(user: AuthUser, slug: string): Promise<VariableMeta[]> {
    const env = await this.getEnvBySlug(slug, user);
    const vars = await this.db
      .select()
      .from(envVariables)
      .where(eq(envVariables.environmentId, env.id))
      .orderBy(asc(envVariables.key));
    const access = await this.accessibleSet(user, env);
    return vars
      .map((v) => this.toMeta(v, env.slug, access === 'ALL' || access.has(v.id)))
      .filter((m) => m.hasAccess || m.visibleWithoutPermission);
  }

  /** 全量清单（跨环境），供 CLI / MCP 认路 */
  async catalog(user: AuthUser) {
    const envs = await this.loadEnvironments(user);
    const result = [];
    for (const env of envs) {
      const variables = await this.listVariables(user, env.slug);
      result.push({ environment: env, variables });
    }
    return result;
  }

  /** 敏感 → 只存加密列；非敏感 → 只存明文列（切换敏感性时清掉另一列） */
  private valueColumns(secret: boolean, value: string) {
    return secret ? { valueEncrypted: encryptSecret(value), valuePlain: null } : { valueEncrypted: null, valuePlain: value };
  }

  async upsertVariable(user: AuthUser, slug: string, dto: UpsertVariableRequest): Promise<UpsertVariableResult> {
    return this.withManagedEnvironment(user, slug, async (tx, env) => {
      const existing = (
        await tx
          .select()
          .from(envVariables)
          .where(and(eq(envVariables.environmentId, env.id), eq(envVariables.key, dto.key)))
          .limit(1)
      )[0];
      let row: VarRow;
      let valueChanged: boolean;
      if (existing) {
        // 没传的元信息保持原值（CLI `eat env set` 只改值时不带它们）。
        // 值缺省或与现值相同 = 保持当前值，版本不动（版本只跟着值走）；
        // 敏感标记翻转时得把现值搬到另一列，所以要先解出来再按新标记落盘
        const secret = dto.secret ?? existing.secret;
        valueChanged = dto.value !== undefined && dto.value !== this.readValue(existing);
        const columns =
          !valueChanged && secret === existing.secret
            ? {}
            : this.valueColumns(secret, valueChanged ? dto.value! : this.readValue(existing));
        [row] = await tx
          .update(envVariables)
          .set({
            ...columns,
            secret,
            description: dto.description ?? existing.description,
            visibleWithoutPermission:
              env.visibility === 'private' ? false : (dto.visibleWithoutPermission ?? existing.visibleWithoutPermission),
            version: valueChanged ? existing.version + 1 : existing.version,
            updatedAt: new Date(),
          })
          .where(eq(envVariables.id, existing.id))
          .returning();
      } else {
        if (dto.value === undefined) {
          throw new BadRequestException({ error: 'VALIDATION_FAILED', message: `变量 ${dto.key} 不存在，新增变量必须提供值` });
        }
        const secret = dto.secret ?? true;
        valueChanged = true;
        [row] = await tx
          .insert(envVariables)
          .values({
            environmentId: env.id,
            key: dto.key,
            ...this.valueColumns(secret, dto.value),
            secret,
            description: dto.description ?? '',
            visibleWithoutPermission: env.visibility === 'private' ? false : (dto.visibleWithoutPermission ?? true),
          })
          .returning();
      }
      await this.audit.record({
        actorId: user.id,
        action: 'variable.upserted',
        targetType: 'env_variable',
        targetId: row.id,
        meta: { environment: env.slug, key: dto.key, version: row.version, valueChanged },
      }, tx);
      return { ...this.toMeta(row, env.slug, true), created: !existing, valueChanged };
    });
  }

  /**
   * 批量导入（`eat env push`）。差异在服务端比：值不回传给调用方、也不算一次读取（不落 secret.read）。
   * 只改值，已存在变量的元信息不动；整批一个事务，预演只比较、不写入。
   */
  async importVariables(user: AuthUser, slug: string, dto: ImportVariablesRequest): Promise<ImportVariablesResult> {
    const incoming = Object.entries(dto.values);
    if (incoming.length === 0 && dto.prune) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '没有提供任何变量，prune 会清空整个环境，已拒绝',
      });
    }
    return this.withManagedEnvironment(user, slug, async (tx, env) => {
      const current = await tx.select().from(envVariables).where(eq(envVariables.environmentId, env.id));
      const byKey = new Map(current.map((v) => [v.key, v]));
      const added: string[] = [];
      const changed: string[] = [];
      let unchanged = 0;
      for (const [key, value] of incoming) {
        const existing = byKey.get(key);
        if (!existing) added.push(key);
        else if (this.readValue(existing) !== value) changed.push(key);
        else unchanged++;
      }
      const missing = current.map((v) => v.key).filter((k) => !(k in dto.values));
      const result: ImportVariablesResult = {
        environment: env.slug,
        dryRun: dto.dryRun,
        prune: dto.prune,
        added: added.sort(),
        changed: changed.sort(),
        unchanged,
        removed: dto.prune ? missing.sort() : [],
        kept: dto.prune ? [] : missing.sort(),
      };
      if (dto.dryRun) return result;

      if (added.length > 0) {
        await tx.insert(envVariables).values(
          added.map((key) => ({
            environmentId: env.id,
            key,
            ...this.valueColumns(dto.secret, dto.values[key]),
            secret: dto.secret,
            description: '',
            visibleWithoutPermission: env.visibility !== 'private',
          })),
        );
      }
      for (const key of changed) {
        const existing = byKey.get(key)!;
        await tx
          .update(envVariables)
          .set({ ...this.valueColumns(existing.secret, dto.values[key]), version: existing.version + 1, updatedAt: new Date() })
          .where(eq(envVariables.id, existing.id));
      }
      if (result.removed.length > 0) {
        // 变量级授权随外键级联删除，与单个删除（deleteVariable）一致
        await tx
          .delete(envVariables)
          .where(and(eq(envVariables.environmentId, env.id), inArray(envVariables.key, result.removed)));
      }
      if (added.length + changed.length + result.removed.length > 0) {
        await this.audit.record({
          actorId: user.id,
          action: 'variable.imported',
          targetType: 'environment',
          targetId: env.id,
          meta: { environment: env.slug, added: result.added, changed: result.changed, removed: result.removed, prune: dto.prune },
        }, tx);
      }
      return result;
    });
  }

  async deleteVariable(user: AuthUser, slug: string, key: string) {
    const env = await this.getEnvBySlug(slug, user);
    this.assertManage(env, user);
    const [row] = await this.db
      .delete(envVariables)
      .where(and(eq(envVariables.environmentId, env.id), eq(envVariables.key, key)))
      .returning({ id: envVariables.id });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `变量 ${key} 不存在` });
    await this.audit.record({
      actorId: user.id,
      action: 'variable.deleted',
      targetType: 'env_variable',
      targetId: row.id,
      meta: { environment: env.slug, key },
    });
    return { ok: true };
  }

  /**
   * 拉取值。有权限的返回解密值；请求了但无权限的进入 denied（结构化引导申请）。
   * 每次成功读取都落审计（secret.read）。
   */
  async pullValues(user: AuthUser, slug: string, keys: string[] | undefined, ip?: string): Promise<PullValuesResponse> {
    const env = await this.getEnvBySlug(slug, user);
    const allVars = await this.db
      .select()
      .from(envVariables)
      .where(eq(envVariables.environmentId, env.id))
      .orderBy(asc(envVariables.key));
    const access = await this.accessibleSet(user, env);
    const byKey = new Map(allVars.map((v) => [v.key, v]));

    const requested = keys && keys.length > 0 ? keys : allVars.filter((v) => access === 'ALL' || access.has(v.id)).map((v) => v.key);

    const values: Record<string, string> = {};
    const denied: PullValuesResponse['denied'] = [];
    const secretReadKeys: string[] = [];
    for (const key of requested) {
      const v = byKey.get(key);
      if (!v) {
        denied.push({ key, error: 'PERMISSION_REQUIRED', message: `变量 ${key} 不存在或不可见`, howToRequest: HOW_TO_REQUEST });
        continue;
      }
      if (access === 'ALL' || access.has(v.id)) {
        values[key] = this.readValue(v);
        if (v.secret) secretReadKeys.push(key);
      } else {
        denied.push({
          key,
          error: 'PERMISSION_REQUIRED',
          message: `你没有读取 ${env.slug}/${key} 值的权限`,
          howToRequest: HOW_TO_REQUEST,
        });
      }
    }

    // 仅敏感值的读取落审计
    if (secretReadKeys.length > 0) {
      await this.audit.record({
        actorId: user.id,
        actorTokenId: user.tokenId,
        action: 'secret.read',
        targetType: 'environment',
        targetId: env.id,
        meta: { environment: env.slug, keys: secretReadKeys },
        ip,
      });
    }
    return { environment: env.slug, values, denied };
  }

  /**
   * **特权读取：仅供 MCP 网关解析上游凭证（决策 51）。**
   *
   * 不做按用户的授权检查，也不落 `secret.read` 审计——两者都是刻意的：
   * 网关模式下解析凭证的授权来自「配置 Owner 建了这条配置 + 订阅已被批准」，
   * 调用的成员既看不到值、也不该被要求拥有该变量的读取权限；
   * 而每次工具调用都写一条 secret.read 会把审计表冲掉，网关侧改为按配置粒度
   * 记一条 `mcp_gateway.credentials_resolved`。
   *
   * 私有环境不能供共享网关使用；查不到的环境 / 变量静默跳过，由调用方决定怎么报（网关是拒掉整次请求）。
   * **除网关外不要调用它**：任何面向用户的取值都必须走 pullValues。
   */
  async readValuesForGateway(refs: Map<string, Set<string>>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [envSlug, keys] of refs) {
      const env = (
        await this.db.select().from(environments).where(eq(environments.slug, envSlug)).limit(1)
      )[0];
      if (!env || env.visibility === 'private') continue;
      const vars = await this.db
        .select()
        .from(envVariables)
        .where(and(eq(envVariables.environmentId, env.id), inArray(envVariables.key, [...keys])));
      for (const v of vars) {
        try {
          out.set(`${envSlug}/${v.key}`, this.readValue(v));
        } catch {
          // 解密失败（KEK 轮换等）时跳过，网关会当作未解析处理
        }
      }
    }
    return out;
  }

  // ---------- 授权 ----------

  async listGrants(user: AuthUser, slug: string) {
    const env = await this.getEnvBySlug(slug, user);
    this.assertManage(env, user);
    const varIds = this.db
      .select({ id: envVariables.id })
      .from(envVariables)
      .where(eq(envVariables.environmentId, env.id));
    const rows = await this.db
      .select({
        grant: variableGrants,
        userName: users.name,
        variableKey: envVariables.key,
      })
      .from(variableGrants)
      .innerJoin(users, eq(variableGrants.userId, users.id))
      .leftJoin(envVariables, eq(variableGrants.variableId, envVariables.id))
      .where(or(eq(variableGrants.environmentId, env.id), inArray(variableGrants.variableId, varIds)));
    return rows.map((r) => ({
      id: r.grant.id,
      userId: r.grant.userId,
      userName: r.userName,
      variableId: r.grant.variableId,
      variableKey: r.variableKey,
      environmentId: r.grant.environmentId,
      grantedBy: r.grant.grantedBy,
      expiresAt: r.grant.expiresAt?.toISOString() ?? null,
      createdAt: r.grant.createdAt.toISOString(),
    }));
  }

  async createGrant(user: AuthUser, slug: string, dto: CreateGrantRequest) {
    return this.withManagedEnvironment(user, slug, async (tx, env) => {
      if (env.visibility === 'private') {
        throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '私有环境仅 Owner 可访问，不能向其他成员授权' });
      }
      if (dto.variableId) {
        const v = (
          await tx
            .select({ id: envVariables.id })
            .from(envVariables)
            .where(and(eq(envVariables.id, dto.variableId), eq(envVariables.environmentId, env.id)))
            .limit(1)
        )[0];
        if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: '变量不属于该环境' });
      } else if (dto.environmentId !== env.id) {
        throw new NotFoundException({ error: 'NOT_FOUND', message: 'environmentId 与路径环境不一致' });
      }
      const [row] = await tx
        .insert(variableGrants)
        .values({
          userId: dto.userId,
          variableId: dto.variableId ?? null,
          environmentId: dto.variableId ? null : env.id,
          grantedBy: user.id,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        })
        .returning();
      await this.audit.record({
        actorId: user.id,
        action: 'grant.created',
        targetType: 'variable_grant',
        targetId: row.id,
        meta: { environment: env.slug, userId: dto.userId, variableId: dto.variableId ?? null },
      }, tx);
      return row;
    });
  }

  async revokeGrant(user: AuthUser, grantId: string) {
    const grant = (
      await this.db.select().from(variableGrants).where(eq(variableGrants.id, grantId)).limit(1)
    )[0];
    if (!grant) throw new NotFoundException({ error: 'NOT_FOUND', message: '授权不存在' });
    // 找到授权归属的环境校验管理权
    let envId = grant.environmentId;
    if (!envId && grant.variableId) {
      const v = (
        await this.db
          .select({ environmentId: envVariables.environmentId })
          .from(envVariables)
          .where(eq(envVariables.id, grant.variableId))
          .limit(1)
      )[0];
      envId = v?.environmentId ?? null;
    }
    if (envId) {
      const env = (
        await this.db.select().from(environments).where(eq(environments.id, envId)).limit(1)
      )[0];
      if (env) this.assertManage(env, user);
    } else if (user.role !== 'admin') {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅管理员可撤销该授权' });
    }
    await this.db.delete(variableGrants).where(eq(variableGrants.id, grantId));
    await this.audit.record({ actorId: user.id, action: 'grant.revoked', targetType: 'variable_grant', targetId: grantId });
    return { ok: true };
  }
}
