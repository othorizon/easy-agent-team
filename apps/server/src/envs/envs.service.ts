import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type {
  CreateEnvironmentRequest,
  CreateGrantRequest,
  EnvironmentDbAssignment,
  EnvironmentInfo,
  EnvListQuery,
  EnvListResult,
  PullValuesResponse,
  UpdateEnvironmentRequest,
  UpsertVariableRequest,
  VariableMeta,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { dbAssignments, dbInstances, environments, envVariables, users, variableGrants } from '../db/schema';

type EnvRow = typeof environments.$inferSelect;
type VarRow = typeof envVariables.$inferSelect;

const HOW_TO_REQUEST =
  '无读取权限。请通过 MCP 工具 request_access（或 CLI：eat env request）附理由发起权限申请，资源 Owner 批准后重试。';

@Injectable()
export class EnvsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- 基础 ----------

  async getEnvBySlug(slug: string): Promise<EnvRow> {
    const row = (
      await this.db.select().from(environments).where(eq(environments.slug, slug)).limit(1)
    )[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `环境 ${slug} 不存在` });
    return row;
  }

  /** 环境的管理权：Owner 或平台管理员 */
  canManage(env: EnvRow, user: AuthUser): boolean {
    return user.role === 'admin' || env.ownerId === user.id;
  }

  private assertManage(env: EnvRow, user: AuthUser) {
    if (!this.canManage(env, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅环境 Owner 或管理员可执行此操作' });
    }
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

  // ---------- 环境 CRUD ----------

  /**
   * 凭证环境 → 生成它的数据库分配（决策 39）。关系存在 db_assignment.environment_id 上，
   * 这里反查一次拿整张映射，清单与详情共用；分配记录已不存在（实例被删级联）时查不到，环境侧显示为 null
   */
  private async dbAssignmentLinks(): Promise<Map<string, EnvironmentDbAssignment>> {
    const rows = await this.db
      .select({
        environmentId: dbAssignments.environmentId,
        id: dbAssignments.id,
        dbName: dbAssignments.dbName,
        status: dbAssignments.status,
        instanceName: dbInstances.name,
      })
      .from(dbAssignments)
      .leftJoin(dbInstances, eq(dbInstances.id, dbAssignments.instanceId))
      .where(isNotNull(dbAssignments.environmentId));
    const links = new Map<string, EnvironmentDbAssignment>();
    for (const r of rows) {
      if (!r.environmentId || links.has(r.environmentId)) continue;
      links.set(r.environmentId, { id: r.id, dbName: r.dbName, status: r.status, instanceName: r.instanceName ?? '(已删除)' });
    }
    return links;
  }

  /** 全部环境（不分页、不筛选，按 slug 排序）：清单在它上面筛，catalog 直接用 */
  private async loadEnvironments(): Promise<EnvironmentInfo[]> {
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
      .groupBy(environments.id, users.name, users.email)
      .orderBy(asc(environments.slug));
    const links = await this.dbAssignmentLinks();
    return rows.map((r) => ({
      id: r.env.id,
      slug: r.env.slug,
      name: r.env.name,
      description: r.env.description,
      ownerId: r.env.ownerId,
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
      source: r.env.source,
      dbAssignment: links.get(r.env.id) ?? null,
      variableCount: Number(r.variableCount),
      createdAt: r.env.createdAt.toISOString(),
    }));
  }

  /**
   * 清单：关键词 → 计数 → 来源筛选 → 分页（决策 39）。
   * 先按关键词收窄、在这个集合上数两类来源各几条、最后才按 source 过滤——页签上的数字要回答
   * 「在当前搜索下切到那个页签会有几条」，source 自己不能参与计数（与 Skill 清单的 scope 计数同一思路）
   */
  async listEnvironments(query: EnvListQuery): Promise<EnvListResult> {
    const all = await this.loadEnvironments();
    const keyword = query.q?.toLowerCase() ?? '';
    const narrowed = keyword
      ? all.filter((e) =>
          `${e.slug}\n${e.name}\n${e.description}\n${e.dbAssignment?.dbName ?? ''}`.toLowerCase().includes(keyword),
        )
      : all;
    const counts = { manual: 0, db_assignment: 0 };
    for (const e of narrowed) counts[e.source] += 1;
    const filtered = query.source === 'all' ? narrowed : narrowed.filter((e) => e.source === query.source);
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize),
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      counts,
    };
  }

  /** 单个环境的信息（详情页用；清单已分页，靠翻清单找一条不可靠） */
  async getEnvironment(slug: string): Promise<EnvironmentInfo> {
    const env = await this.getEnvBySlug(slug);
    const [owner] = await this.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, env.ownerId));
    const [{ variableCount }] = await this.db
      .select({ variableCount: count(envVariables.id) })
      .from(envVariables)
      .where(eq(envVariables.environmentId, env.id));
    const links = await this.dbAssignmentLinks();
    return {
      id: env.id,
      slug: env.slug,
      name: env.name,
      description: env.description,
      ownerId: env.ownerId,
      ownerName: owner?.name ?? '(已删除)',
      ownerEmail: owner?.email ?? '',
      source: env.source,
      dbAssignment: links.get(env.id) ?? null,
      variableCount: Number(variableCount),
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
      .values({ slug: dto.slug, name: dto.name, description: dto.description, ownerId: user.id })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'env.created', targetType: 'environment', targetId: row.id });
    return row;
  }

  async updateEnvironment(user: AuthUser, slug: string, dto: UpdateEnvironmentRequest) {
    const env = await this.getEnvBySlug(slug);
    this.assertManage(env, user);
    const [row] = await this.db
      .update(environments)
      .set({ name: dto.name ?? env.name, description: dto.description ?? env.description })
      .where(eq(environments.id, env.id))
      .returning();
    await this.audit.record({ actorId: user.id, action: 'env.updated', targetType: 'environment', targetId: env.id });
    return row;
  }

  async deleteEnvironment(user: AuthUser, slug: string) {
    const env = await this.getEnvBySlug(slug);
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
    const env = await this.getEnvBySlug(slug);
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
    const envs = await this.loadEnvironments();
    const result = [];
    for (const env of envs) {
      const variables = await this.listVariables(user, env.slug);
      result.push({ environment: env, variables });
    }
    return result;
  }

  async upsertVariable(user: AuthUser, slug: string, dto: UpsertVariableRequest) {
    const env = await this.getEnvBySlug(slug);
    this.assertManage(env, user);
    const existing = (
      await this.db
        .select()
        .from(envVariables)
        .where(and(eq(envVariables.environmentId, env.id), eq(envVariables.key, dto.key)))
        .limit(1)
    )[0];
    // 敏感 → 只存加密列；非敏感 → 只存明文列（切换敏感性时清掉另一列）
    const valueColumns = (secret: boolean, value: string) =>
      secret ? { valueEncrypted: encryptSecret(value), valuePlain: null } : { valueEncrypted: null, valuePlain: value };
    let row: VarRow;
    if (existing) {
      // 值缺省 = 保持当前值，只改备注 / 可见性 / 敏感标记，版本不动（版本只跟着值走）；
      // 敏感标记翻转时得把现值搬到另一列，所以要先解出来再按新标记落盘
      const valueChanged = dto.value !== undefined;
      const columns =
        !valueChanged && dto.secret === existing.secret
          ? {}
          : valueColumns(dto.secret, dto.value ?? this.readValue(existing));
      [row] = await this.db
        .update(envVariables)
        .set({
          ...columns,
          secret: dto.secret,
          description: dto.description,
          visibleWithoutPermission: dto.visibleWithoutPermission,
          version: valueChanged ? existing.version + 1 : existing.version,
          updatedAt: new Date(),
        })
        .where(eq(envVariables.id, existing.id))
        .returning();
      await this.audit.record({
        actorId: user.id,
        action: 'variable.upserted',
        targetType: 'env_variable',
        targetId: row.id,
        meta: { environment: env.slug, key: dto.key, version: row.version, valueChanged },
      });
    } else {
      if (dto.value === undefined) {
        throw new BadRequestException({ error: 'VALIDATION_FAILED', message: `变量 ${dto.key} 不存在，新增变量必须提供值` });
      }
      [row] = await this.db
        .insert(envVariables)
        .values({
          environmentId: env.id,
          key: dto.key,
          ...valueColumns(dto.secret, dto.value),
          secret: dto.secret,
          description: dto.description,
          visibleWithoutPermission: dto.visibleWithoutPermission,
        })
        .returning();
      await this.audit.record({
        actorId: user.id,
        action: 'variable.upserted',
        targetType: 'env_variable',
        targetId: row.id,
        meta: { environment: env.slug, key: dto.key, version: row.version, valueChanged: true },
      });
    }
    return this.toMeta(row, env.slug, true);
  }

  async deleteVariable(user: AuthUser, slug: string, key: string) {
    const env = await this.getEnvBySlug(slug);
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
    const env = await this.getEnvBySlug(slug);
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

  // ---------- 授权 ----------

  async listGrants(user: AuthUser, slug: string) {
    const env = await this.getEnvBySlug(slug);
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
    const env = await this.getEnvBySlug(slug);
    this.assertManage(env, user);
    if (dto.variableId) {
      const v = (
        await this.db
          .select({ id: envVariables.id })
          .from(envVariables)
          .where(and(eq(envVariables.id, dto.variableId), eq(envVariables.environmentId, env.id)))
          .limit(1)
      )[0];
      if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: '变量不属于该环境' });
    } else if (dto.environmentId !== env.id) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: 'environmentId 与路径环境不一致' });
    }
    const [row] = await this.db
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
    });
    return row;
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
