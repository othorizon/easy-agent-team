import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  BuildLogsResult,
  ConnectionTestResult,
  CreateProjectRequest,
  DeploymentInfo,
  DeploymentMeta,
  DeploymentsQuery,
  DokployApplication,
  DokployDeployment,
  LogsQuery,
  RunLogsResult,
  DokploySettingsInfo,
  PrecheckReport,
  ProjectInfo,
  SecretFingerprint,
  TestDokploySettingsRequest,
  UpdateDokploySettingsRequest,
  UpdateProjectRequest,
} from '@eat/shared';
import { FINGERPRINT_MIN_LENGTH } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { decryptSecret, encryptSecret, sha256Hex } from '../common/crypto';
import { SHORT_ID_MIN_LENGTH } from '../common/short-id';
import { DB, type Db } from '../db/db.module';
import { deployments, dokploySettings, environments, envVariables, projectMembers, projects, users } from '../db/schema';
import { DokployClient, type DokployQueueJob } from './dokploy.client';

type ProjectRow = typeof projects.$inferSelect;
/** 平台侧的部署元数据行（决策 30：只有业务信息，没有状态） */
type MetaRow = typeof deployments.$inferSelect;
/** 一条 Dokploy 构建记录被哪份元数据认领，以及是怎么认上的 */
interface Claim {
  meta: MetaRow;
  how: DeploymentMeta['claim'];
}

/** 平台写进 Dokploy 构建记录 description 的认领标记（决策 30） */
const DEPLOY_TAG_PREFIX = 'eat:';
const deployTag = (metaId: string): string => `${DEPLOY_TAG_PREFIX}${metaId}`;
const parseDeployTag = (description: string): string | undefined =>
  /(?:^|\s)eat:([0-9a-f-]{36})(?:\s|$)/i.exec(description ?? '')?.[1];

/** 认领回落到按时间推断时：给两边时钟差留的余量，以及最远往后找多久 */
const CLAIM_CLOCK_SKEW_MS = 5_000;
const CLAIM_WINDOW_MS = 30 * 60_000;
/** 队列里查不到、但刚触发不久且从未认领过构建记录的元数据，仍显示为「排队中」的宽限期 */
const QUEUED_GRACE_MS = 10 * 60_000;
/** BullMQ 里「还没开始跑」的状态；active 说明构建记录多半已建出来，再列一行就重复了 */
const QUEUE_PENDING_STATES = new Set(['waiting', 'waiting-children', 'delayed', 'paused', 'prioritized']);
/** 一次查询最多带出多少条平台元数据（--all 与默认视图各一档） */
const META_ALL_LIMIT = 200;
const META_RECENT_LIMIT = 50;
/** 部署失败时读多少行构建日志、往 error 里留几行、最多留多少字符 */
const FAILURE_LOG_TAIL = 100;
const FAILURE_LOG_LINES = 12;
const FAILURE_LOG_CHARS = 800;
/** 构建日志接口回带多少条最近构建供切换 */
const RECENT_BUILDS = 20;

@Injectable()
export class DeployService {
  private readonly logger = new Logger(DeployService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------- Dokploy 接入配置 ----------

  private async settingsRow() {
    return (await this.db.select().from(dokploySettings).limit(1))[0];
  }

  async getSettings(): Promise<DokploySettingsInfo> {
    const row = await this.settingsRow();
    if (!row) return { apiUrl: '', apiTokenMasked: '', enabled: false, configured: false };
    const token = decryptSecret(row.apiTokenEncrypted);
    return {
      apiUrl: row.apiUrl,
      apiTokenMasked: token.length > 8 ? `${token.slice(0, 4)}****${token.slice(-4)}` : '****',
      enabled: row.enabled,
      configured: true,
    };
  }

  async updateSettings(dto: UpdateDokploySettingsRequest): Promise<DokploySettingsInfo> {
    const row = await this.settingsRow();
    const apiTokenEncrypted = dto.apiToken ? encryptSecret(dto.apiToken) : (row?.apiTokenEncrypted ?? encryptSecret(''));
    if (row) {
      await this.db
        .update(dokploySettings)
        .set({ apiUrl: dto.apiUrl, apiTokenEncrypted, enabled: dto.enabled, updatedAt: sql`now()` })
        .where(eq(dokploySettings.id, row.id));
    } else {
      await this.db.insert(dokploySettings).values({ apiUrl: dto.apiUrl, apiTokenEncrypted, enabled: dto.enabled });
    }
    return this.getSettings();
  }

  /**
   * 连通性测试：用传入的表单值（token 为空回落到已保存的 token）调用 Dokploy 只读端点。
   * 不要求 enabled（管理员可先测通再启用），失败不抛错。
   */
  async testSettings(dto: TestDokploySettingsRequest): Promise<ConnectionTestResult> {
    const row = await this.settingsRow();
    const apiToken = dto.apiToken || (row ? decryptSecret(row.apiTokenEncrypted) : '');
    if (!apiToken) return { ok: false, message: '未提供 API Token，且没有已保存的 Token 可用', latencyMs: 0 };
    const startedAt = Date.now();
    try {
      await new DokployClient({ apiUrl: dto.apiUrl, apiToken }).testConnection();
      return { ok: true, message: 'Dokploy 连接成功，token 有效', latencyMs: Date.now() - startedAt };
    } catch (err) {
      // Node fetch 网络错误只报 "fetch failed"，具体原因（如 ECONNREFUSED）在 cause 里
      const e = err as Error & { cause?: { message?: string } };
      const detail = e.cause?.message ? `${e.message}（${e.cause.message}）` : e.message;
      return { ok: false, message: `连接失败: ${detail}`, latencyMs: Date.now() - startedAt };
    }
  }

  private async client(): Promise<DokployClient> {
    const row = await this.settingsRow();
    if (!row || !row.enabled) {
      throw new ServiceUnavailableException({ error: 'DOKPLOY_UNAVAILABLE', message: 'Dokploy 未配置或已停用（系统设置 → Dokploy）' });
    }
    return new DokployClient({ apiUrl: row.apiUrl, apiToken: decryptSecret(row.apiTokenEncrypted) });
  }

  /**
   * Dokploy 应用清单（决策 27）：控制台建项目时「从 Dokploy 选择」用，免去手抄 application id。
   * 与创建项目同权限（任何登录成员）——成员本就能手填任意 application id 建项目并部署，
   * 这里只是把已经开放的能力变得可发现，不放大权限。清单只含应用名与 id，不含任何凭证。
   */
  async listDokployApplications(): Promise<DokployApplication[]> {
    const client = await this.client();
    return this.callDokploy(() => client.listApplications(), '拉取 Dokploy 应用清单失败');
  }

  /**
   * 调 Dokploy 的统一错误包装：Node fetch 的网络错误只报 "fetch failed"，
   * 真正的原因（ECONNREFUSED 等）在 cause 里，不带出来排查会很痛苦。
   */
  private async callDokploy<T>(fn: () => Promise<T>, note: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & { cause?: { message?: string } };
      const detail = e.cause?.message ? `${e.message}（${e.cause.message}）` : e.message;
      throw new ServiceUnavailableException({ error: 'DOKPLOY_UNAVAILABLE', message: `${note}: ${detail}` });
    }
  }

  // ---------- 项目 ----------

  private async getProject(slug: string): Promise<ProjectRow> {
    const row = (await this.db.select().from(projects).where(eq(projects.slug, slug)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `项目 ${slug} 不存在` });
    return row;
  }

  private async memberIds(projectId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId));
    return new Set(rows.map((r) => r.userId));
  }

  private async canDeploy(project: ProjectRow, user: AuthUser): Promise<boolean> {
    if (user.role === 'admin' || project.ownerId === user.id) return true;
    return (await this.memberIds(project.id)).has(user.id);
  }

  private canManage(project: ProjectRow, user: AuthUser): boolean {
    return user.role === 'admin' || project.ownerId === user.id;
  }

  private async toProjectInfo(row: ProjectRow, user: AuthUser): Promise<ProjectInfo> {
    const [owner] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.ownerId));
    const members = await this.db
      .select({ userId: projectMembers.userId, name: users.name })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(eq(projectMembers.projectId, row.id));
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      repoUrl: row.repoUrl,
      dokployApplicationId: row.dokployApplicationId,
      description: row.description,
      ownerId: row.ownerId,
      ownerName: owner?.name ?? '(已删除)',
      members,
      canDeploy: await this.canDeploy(row, user),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listProjects(user: AuthUser): Promise<ProjectInfo[]> {
    const rows = await this.db.select().from(projects).orderBy(asc(projects.slug));
    return Promise.all(rows.map((r) => this.toProjectInfo(r, user)));
  }

  async createProject(user: AuthUser, dto: CreateProjectRequest): Promise<ProjectInfo> {
    const exists = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.slug, dto.slug)).limit(1);
    if (exists.length > 0) throw new ConflictException({ error: 'CONFLICT', message: `项目 ${dto.slug} 已存在` });
    const [row] = await this.db
      .insert(projects)
      .values({
        slug: dto.slug,
        name: dto.name,
        repoUrl: dto.repoUrl,
        dokployApplicationId: dto.dokployApplicationId,
        description: dto.description,
        ownerId: user.id,
      })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'project.created', targetType: 'project', targetId: row.id, meta: { slug: dto.slug } });
    return this.toProjectInfo(row, user);
  }

  async updateProject(user: AuthUser, slug: string, dto: UpdateProjectRequest): Promise<ProjectInfo> {
    const project = await this.getProject(slug);
    if (!this.canManage(project, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅项目 Owner 或管理员可修改' });
    }
    const [row] = await this.db
      .update(projects)
      .set({
        name: dto.name ?? project.name,
        repoUrl: dto.repoUrl ?? project.repoUrl,
        dokployApplicationId: dto.dokployApplicationId ?? project.dokployApplicationId,
        description: dto.description ?? project.description,
      })
      .where(eq(projects.id, project.id))
      .returning();
    await this.audit.record({ actorId: user.id, action: 'project.updated', targetType: 'project', targetId: project.id });
    return this.toProjectInfo(row, user);
  }

  async removeProject(user: AuthUser, slug: string) {
    const project = await this.getProject(slug);
    if (!this.canManage(project, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅项目 Owner 或管理员可删除' });
    }
    await this.db.delete(projects).where(eq(projects.id, project.id));
    await this.audit.record({ actorId: user.id, action: 'project.deleted', targetType: 'project', targetId: project.id, meta: { slug } });
    return { ok: true };
  }

  async addMember(user: AuthUser, slug: string, userId: string) {
    const project = await this.getProject(slug);
    if (!this.canManage(project, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅项目 Owner 或管理员可管理成员' });
    }
    await this.db.insert(projectMembers).values({ projectId: project.id, userId }).onConflictDoNothing();
    await this.audit.record({ actorId: user.id, action: 'project.member_added', targetType: 'project', targetId: project.id, meta: { userId } });
    return { ok: true };
  }

  async removeMember(user: AuthUser, slug: string, userId: string) {
    const project = await this.getProject(slug);
    if (!this.canManage(project, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅项目 Owner 或管理员可管理成员' });
    }
    await this.db
      .delete(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)));
    return { ok: true };
  }

  // ---------- 部署（决策 30：记录与状态以 Dokploy 为准，DB 只存业务元数据） ----------

  private toMeta(row: MetaRow, triggeredByName: string, claim: DeploymentMeta['claim']): DeploymentMeta {
    return {
      id: row.id,
      triggeredBy: row.triggeredBy,
      triggeredByName,
      report: (row.report as DeploymentMeta['report']) ?? null,
      claim,
      triggeredAt: row.createdAt.toISOString(),
    };
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * 触发部署（决策 #8：必须携带通过的 CLI 检查报告）。
   *
   * 部署记录本身归 Dokploy——这里只做两件事：往 Dokploy 的构建记录上打一个 `eat:<id>` 标记，
   * 再把 Dokploy 没有的业务元数据（谁触发的、带了什么检查报告）存进平台库，读取时靠标记认领。
   * 顺序刻意是「先触发、成功了才落库」：Dokploy 拒绝时不留下一条永远认领不到的孤儿元数据。
   */
  async deploy(user: AuthUser, slug: string, report: PrecheckReport): Promise<DeploymentInfo> {
    const project = await this.getProject(slug);
    if (!(await this.canDeploy(project, user))) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '仅项目成员可部署（找 Owner 把你加入项目）' });
    }
    if (!report.passed) {
      throw new BadRequestException({
        error: 'PRECHECK_FAILED',
        message: `前置检查未通过（${report.findings.length} 个问题），修复后重试。绝不要通过删除检查报告来绕过`,
      });
    }
    const client = await this.client();
    const id = randomUUID();
    // title 会显示在 Dokploy 控制台自己的部署列表里，写人话；机器标记放 description
    const title = `eat · ${user.name} · ${slug}`.slice(0, 200);
    await this.callDokploy(
      () => client.deploy(project.dokployApplicationId, { title, description: deployTag(id) }),
      '触发 Dokploy 部署失败',
    );
    const [row] = await this.db
      .insert(deployments)
      .values({ id, projectId: project.id, triggeredBy: user.id, report: report as unknown as Record<string, unknown> })
      .returning();
    await this.audit.record({ actorId: user.id, action: 'deploy.triggered', targetType: 'deployment', targetId: row.id, meta: { project: slug } });
    // Dokploy 的部署是排队执行的，构建记录要等队列处理到才建出来，此刻只可能是 queued
    return {
      projectSlug: slug,
      deploymentId: null,
      status: 'queued',
      origin: 'platform',
      title,
      error: null,
      createdAt: row.createdAt.toISOString(),
      platform: this.toMeta(row, user.name, 'tagged'),
    };
  }

  async listDeployments(user: AuthUser, slug: string, query: DeploymentsQuery): Promise<DeploymentInfo[]> {
    void user;
    return this.mergeDeployments(await this.getProject(slug), query.all);
  }

  /** 项目最近一次部署：CLI 的 `eat project status <slug>` 用它，不必先记住部署 ID */
  async latestDeployment(user: AuthUser, slug: string): Promise<DeploymentInfo> {
    const project = await this.getProject(slug);
    const row = (await this.mergeDeployments(project, false))[0];
    if (!row) {
      // 平台侧还有元数据、Dokploy 上却没有构建记录 = 都被「只留最近 10 条」清掉了，
      // 说成「还没部署过」会误导人去重新部署一次（决策 30）
      const archived = await this.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.projectId, project.id))
        .limit(1);
      throw new NotFoundException({
        error: 'NOT_FOUND',
        message: archived.length
          ? `Dokploy 上已没有 ${slug} 的构建记录（每个应用只保留最近 10 次）；平台侧历史: eat project deployments ${slug} --all`
          : `项目 ${slug} 还没有部署记录（eat deploy ${slug} 触发一次）`,
      });
    }
    return this.withFailureDetail(project, user, row);
  }

  /**
   * 查某一次部署。id 可以是 Dokploy 构建记录 id，也可以是平台元数据 id（两个 ID 空间都认，
   * 因为清单里两种都可能是一行的主键：构建记录被清理后就只剩元数据 id 了），都支持前 8 位短写。
   */
  async getDeployment(user: AuthUser, slug: string, rawId: string): Promise<DeploymentInfo> {
    const project = await this.getProject(slug);
    const id = rawId.trim();
    const rows = await this.mergeDeployments(project, true);
    const exact = rows.filter((r) => r.deploymentId === id || r.platform?.id === id);
    if (exact.length === 0 && id.length < SHORT_ID_MIN_LENGTH) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: `ID 至少需要 ${SHORT_ID_MIN_LENGTH} 位（列表里展示的就是前 ${SHORT_ID_MIN_LENGTH} 位）`,
      });
    }
    const hits = exact.length
      ? exact
      : rows.filter((r) => r.deploymentId?.startsWith(id) || r.platform?.id.startsWith(id));
    if (hits.length === 0) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `项目 ${slug} 下没有部署记录 ${rawId}` });
    }
    if (hits.length > 1) {
      throw new ConflictException({
        error: 'AMBIGUOUS_ID',
        message: `ID 前缀 ${rawId} 匹配到多条部署记录，请改用完整 ID 查询`,
      });
    }
    return this.withFailureDetail(project, user, hits[0]);
  }

  /**
   * 合成一个项目的部署记录清单（决策 30）。三份数据源：
   *   ① Dokploy 的构建记录——主体，也是状态的唯一事实源；**每个应用只留最近 10 条**；
   *   ② Dokploy 的部署队列——已触发但构建记录还没建出来的那段时间里，唯一能看到它的地方；
   *   ③ 平台侧元数据——谁触发的、带了什么检查报告，往 ①② 上挂；挂不上就是「Dokploy 侧直接触发」。
   * all=true 时再补上「元数据还在、构建记录已被 Dokploy 清理」的历史（archived），
   * 否则那些部署会随着第 11 次部署从平台上彻底消失。
   */
  private async mergeDeployments(project: ProjectRow, all: boolean): Promise<DeploymentInfo[]> {
    const client = await this.client();
    const builds = await this.callDokploy(
      () => client.listDeployments(project.dokployApplicationId),
      '拉取 Dokploy 构建记录失败',
    );
    // 队列读失败不该让整张清单挂掉（老版本 Dokploy 未必有这个端点），拿不到就当队列是空的
    let jobs: DokployQueueJob[] = [];
    try {
      jobs = (await client.queueList()).filter(
        (j) => j.applicationId === project.dokployApplicationId && QUEUE_PENDING_STATES.has(j.state),
      );
    } catch (err) {
      this.logger.warn(`拉取 Dokploy 部署队列失败（忽略）: ${(err as Error).message}`);
    }
    const metas = await this.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, project.id))
      .orderBy(desc(deployments.createdAt))
      .limit(all ? META_ALL_LIMIT : META_RECENT_LIMIT);
    const names = await this.userNames(metas.map((m) => m.triggeredBy));
    const nameOf = (row: MetaRow): string => names.get(row.triggeredBy) ?? '(已删除)';
    const claims = await this.claimBuilds(builds, metas);
    const used = new Set([...claims.values()].map((c) => c.meta.id));

    const rows: DeploymentInfo[] = builds.map((b) => {
      const claim = claims.get(b.deploymentId);
      return {
        projectSlug: project.slug,
        deploymentId: b.deploymentId,
        status: b.status,
        origin: claim ? 'platform' : 'dokploy',
        title: b.title,
        // 失败详情（构建日志末尾）只在查单条时补，列表里每条都读日志太贵
        error: b.status === 'error' ? b.errorMessage || null : null,
        createdAt: b.createdAt,
        platform: claim ? this.toMeta(claim.meta, nameOf(claim.meta), claim.how) : null,
      };
    });

    // 排队中：构建记录还没建出来的那段时间。队列里查得到最好；查不到但刚触发不久的也列出来
    // （老版本 Dokploy 没有队列端点），否则用户 eat deploy 完立刻查会看不到自己刚触发的部署。
    const jobByMeta = new Map<string, DokployQueueJob>();
    for (const job of jobs) {
      const metaId = parseDeployTag(job.description);
      if (metaId) jobByMeta.set(metaId, job);
    }
    for (const meta of metas) {
      if (used.has(meta.id)) continue;
      const job = jobByMeta.get(meta.id);
      // 认领过一次（dokploy_deployment_id 已回写）就不可能是排队中：这时构建记录不在清单里
      // 只意味着 Dokploy 把它清理掉了，那是 archived，不能靠「刚触发不久」把它退回排队中
      const neverBound = meta.dokployDeploymentId === null;
      if (!job && !(neverBound && Date.now() - meta.createdAt.getTime() <= QUEUED_GRACE_MS)) continue;
      used.add(meta.id);
      rows.push({
        projectSlug: project.slug,
        deploymentId: null,
        status: 'queued',
        origin: 'platform',
        title: job?.title ?? `eat · ${nameOf(meta)} · ${project.slug}`,
        error: null,
        createdAt: meta.createdAt.toISOString(),
        platform: this.toMeta(meta, nameOf(meta), job ? 'tagged' : 'none'),
      });
    }
    // Dokploy 侧直接触发、也还在排队的
    for (const job of jobs) {
      const metaId = parseDeployTag(job.description);
      if (metaId && metas.some((m) => m.id === metaId)) continue;
      rows.push({
        projectSlug: project.slug,
        deploymentId: null,
        status: 'queued',
        origin: 'dokploy',
        title: job.title,
        error: null,
        createdAt: new Date(job.timestamp || Date.now()).toISOString(),
        platform: null,
      });
    }

    if (all) {
      for (const meta of metas) {
        if (used.has(meta.id)) continue;
        rows.push({
          projectSlug: project.slug,
          deploymentId: meta.dokployDeploymentId,
          status: 'archived',
          origin: 'platform',
          title: '',
          error: null,
          createdAt: meta.createdAt.toISOString(),
          platform: this.toMeta(meta, nameOf(meta), 'none'),
        });
      }
    }
    return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  /**
   * 把 Dokploy 的构建记录与平台元数据对上（决策 30）。三轮，优先级从高到低：
   *   ① description 里的 `eat:<id>` 标记——精确，Dokploy ≥ v0.25.0 都走这条；
   *   ② 之前已回写过的 dokploy_deployment_id——认过一次就不再重算；
   *   ③ 按触发时间就近推断——只用于**没有标记**的构建记录，覆盖老版本 Dokploy 与本次改造
   *      之前留下的历史行。这一轮可能张冠李戴（同一应用被别人在 Dokploy 侧同时部署），
   *      所以标成 inferred，让 CLI/控制台能把「这条归属是猜的」显示出来。
   */
  private async claimBuilds(builds: DokployDeployment[], metas: MetaRow[]): Promise<Map<string, Claim>> {
    const claims = new Map<string, Claim>();
    const used = new Set<string>();
    const metaById = new Map(metas.map((m) => [m.id, m]));
    const buildIds = new Set(builds.map((b) => b.deploymentId));

    for (const b of builds) {
      const metaId = parseDeployTag(b.description);
      const meta = metaId ? metaById.get(metaId) : undefined;
      if (!meta || used.has(meta.id)) continue;
      claims.set(b.deploymentId, { meta, how: 'tagged' });
      used.add(meta.id);
    }
    for (const meta of metas) {
      const id = meta.dokployDeploymentId;
      if (!id || used.has(meta.id) || claims.has(id) || !buildIds.has(id)) continue;
      claims.set(id, { meta, how: 'inferred' });
      used.add(meta.id);
    }
    const free = builds
      .filter((b) => !claims.has(b.deploymentId) && !parseDeployTag(b.description))
      .map((b) => ({ build: b, at: Date.parse(b.createdAt) }))
      .filter((x) => Number.isFinite(x.at))
      .sort((a, b) => a.at - b.at);
    for (const meta of [...metas].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      // 已经认领过一次的元数据不再参与推断：它此刻没配上构建记录只说明那条被 Dokploy 清理了，
      // 让它去认领别人的构建就成了张冠李戴——把 Dokploy 侧触发的部署显示成经过平台扫描的部署
      if (used.has(meta.id) || meta.dokployDeploymentId !== null || free.length === 0) continue;
      const at = meta.createdAt.getTime();
      // 时间窗两头都要卡：只往后找（构建记录不可能早于触发），也不能找得太远，
      // 否则一条几天前、构建记录早被清理的元数据会去认领今天别人在 Dokploy 侧点的部署
      const i = free.findIndex((x) => x.at >= at - CLAIM_CLOCK_SKEW_MS && x.at <= at + CLAIM_WINDOW_MS);
      if (i < 0) continue;
      claims.set(free[i].build.deploymentId, { meta, how: 'inferred' });
      used.add(meta.id);
      free.splice(i, 1);
    }
    await this.rememberClaims(claims);
    return claims;
  }

  /** 把认领结果回写进元数据行：构建记录被 Dokploy 清理后，至少还知道当时是哪一条 */
  private async rememberClaims(claims: Map<string, Claim>): Promise<void> {
    for (const [deploymentId, { meta }] of claims) {
      if (meta.dokployDeploymentId === deploymentId) continue;
      try {
        await this.db
          .update(deployments)
          .set({ dokployDeploymentId: deploymentId })
          .where(and(eq(deployments.id, meta.id), isNull(deployments.dokployDeploymentId)));
        meta.dokployDeploymentId = deploymentId;
      } catch (err) {
        // 唯一索引冲突（历史上误认领过同一条）不该让查询失败，回写本就是缓存
        this.logger.warn(`回写 Dokploy 构建记录 id 失败（忽略）: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 构建失败时把日志末尾几行补进 error（决策 28）：排查一次不必跳出平台。
   * 日志可能带出构建期注入的密钥，所以只给能读日志的人（项目成员）补，
   * 其他人看到的仍是 Dokploy 构建记录上那句 errorMessage。
   */
  private async withFailureDetail(project: ProjectRow, user: AuthUser, row: DeploymentInfo): Promise<DeploymentInfo> {
    if (row.status !== 'error' || !row.deploymentId) return row;
    if (!(await this.canDeploy(project, user))) return row;
    try {
      const client = await this.client();
      return { ...row, error: await this.buildFailureReason(client, row.deploymentId, row.error, project.slug) };
    } catch (err) {
      this.logger.warn(`读取构建失败详情失败（忽略）: ${(err as Error).message}`);
      return row;
    }
  }

  private async buildFailureReason(
    client: DokployClient,
    deploymentId: string,
    errorMessage: string | null,
    slug: string,
  ): Promise<string> {
    const head = `Dokploy 构建失败（完整日志: eat project build-logs ${slug}）`;
    let logs = '';
    try {
      logs = await client.readDeploymentLogs(deploymentId, FAILURE_LOG_TAIL);
    } catch (err) {
      this.logger.warn(`读取 Dokploy 构建日志失败: ${(err as Error).message}`);
    }
    const tail = logs
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l !== '')
      .slice(-FAILURE_LOG_LINES)
      .join('\n');
    if (!tail) return errorMessage ? `${head}: ${errorMessage}` : head;
    const excerpt = tail.length > FAILURE_LOG_CHARS ? `…${tail.slice(-FAILURE_LOG_CHARS)}` : tail;
    return `${head}，日志末尾:\n${excerpt}`;
  }

  // ---------- 构建日志 / 运行日志（决策 28） ----------

  /** 日志可能带出构建期注入的密钥，比部署历史更敏感：只给项目成员/Owner/管理员 */
  private async assertCanDeploy(project: ProjectRow, user: AuthUser, what: string): Promise<void> {
    if (!(await this.canDeploy(project, user))) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `仅项目成员可${what}（找 Owner 把你加入项目）` });
    }
  }

  /** 构建日志：默认看最近一次构建，`deploymentId` 可回看指定那次 */
  async buildLogs(user: AuthUser, slug: string, query: LogsQuery): Promise<BuildLogsResult> {
    const project = await this.getProject(slug);
    await this.assertCanDeploy(project, user, '查看构建日志');
    const client = await this.client();
    const builds = await this.callDokploy(
      () => client.listDeployments(project.dokployApplicationId),
      '拉取 Dokploy 构建记录失败',
    );
    const target = query.deploymentId ? builds.find((b) => b.deploymentId === query.deploymentId) : builds[0];
    if (query.deploymentId && !target) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `Dokploy 上没有构建记录 ${query.deploymentId}` });
    }
    const logs = target
      ? await this.callDokploy(
          () => client.readDeploymentLogs(target.deploymentId, query.tail),
          '读取 Dokploy 构建日志失败',
        )
      : '';
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'deploy.build_logs_read',
      targetType: 'project',
      targetId: project.id,
      meta: { deploymentId: target?.deploymentId ?? null, tail: query.tail },
    });
    return { projectSlug: project.slug, deployment: target ?? null, logs, recent: builds.slice(0, RECENT_BUILDS) };
  }

  /** 运行日志：默认看第一个运行中的容器，`containerId` 可指定副本 */
  async runLogs(user: AuthUser, slug: string, query: LogsQuery): Promise<RunLogsResult> {
    const project = await this.getProject(slug);
    await this.assertCanDeploy(project, user, '查看运行日志');
    const client = await this.client();
    // 容器名前缀（appName）是 Dokploy 生成的，只有 application.one 里带
    const appName = await this.callDokploy(
      () => client.applicationAppName(project.dokployApplicationId),
      '读取 Dokploy 应用详情失败',
    );
    if (!appName) {
      throw new ServiceUnavailableException({
        error: 'DOKPLOY_UNAVAILABLE',
        message: 'Dokploy 上查不到该应用的容器名，确认项目绑定的 application id 是否正确',
      });
    }
    const containers = await this.callDokploy(() => client.listContainers(appName), '拉取 Dokploy 容器清单失败');
    const target = query.containerId
      ? containers.find((c) => c.containerId === query.containerId)
      : (containers.find((c) => c.state === 'running') ?? containers[0]);
    if (query.containerId && !target) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `该应用当前没有容器 ${query.containerId}` });
    }
    const logs = target
      ? await this.callDokploy(() => client.containerLogs(target.containerId, query.tail), '读取 Dokploy 运行日志失败')
      : '';
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'deploy.run_logs_read',
      targetType: 'project',
      targetId: project.id,
      meta: { containerId: target?.containerId ?? null, tail: query.tail },
    });
    return { projectSlug: project.slug, container: target ?? null, logs, containers };
  }

  // ---------- 密钥指纹清单（CLI 扫描用） ----------

  /**
   * 所有环境变量值的 SHA-256 单向指纹（仅长度 ≥ FINGERPRINT_MIN_LENGTH 的值）。
   * 无权限可见性为隐藏的变量不泄露 env/key 名。读取落审计。
   */
  async secretFingerprints(user: AuthUser): Promise<SecretFingerprint[]> {
    const rows = await this.db
      .select({ variable: envVariables, envSlug: environments.slug })
      .from(envVariables)
      .innerJoin(environments, eq(envVariables.environmentId, environments.id));
    const out: SecretFingerprint[] = [];
    for (const r of rows) {
      // 非敏感变量明文存储，不是密钥，不进指纹清单
      if (!r.variable.secret || !r.variable.valueEncrypted) continue;
      let value: string;
      try {
        value = decryptSecret(r.variable.valueEncrypted);
      } catch {
        continue;
      }
      if (value.length < FINGERPRINT_MIN_LENGTH) continue;
      const visible = r.variable.visibleWithoutPermission;
      out.push({
        fingerprint: sha256Hex(value),
        length: value.length,
        environment: visible ? r.envSlug : '(受限变量)',
        key: visible ? r.variable.key : '(受限变量)',
      });
    }
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'fingerprints.read',
      meta: { count: out.length },
    });
    return out;
  }
}
