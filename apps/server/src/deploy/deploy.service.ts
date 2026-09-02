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
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  BuildLogsResult,
  ConnectionTestResult,
  CreateProjectRequest,
  DeploymentInfo,
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
import { resolveShortId } from '../common/short-id';
import { DB, type Db } from '../db/db.module';
import { deployments, dokploySettings, environments, envVariables, projectMembers, projects, users } from '../db/schema';
import { DokployClient } from './dokploy.client';

type ProjectRow = typeof projects.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;

/** 绑不上 Dokploy 构建记录多久后回落到应用状态判定 */
const BIND_TIMEOUT_MS = 10 * 60_000;
/** 绑定时给两边时钟差留的余量 */
const BIND_CLOCK_SKEW_MS = 5_000;
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

  // ---------- 部署 ----------

  private async toDeploymentInfo(row: DeploymentRow): Promise<DeploymentInfo> {
    const [project] = await this.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId));
    const [trigger] = await this.db.select({ name: users.name }).from(users).where(eq(users.id, row.triggeredBy));
    return {
      id: row.id,
      projectSlug: project?.slug ?? '(已删除)',
      status: row.status,
      triggeredBy: row.triggeredBy,
      triggeredByName: trigger?.name ?? '(已删除)',
      error: row.error,
      dokployDeploymentId: row.dokployDeploymentId,
      report: (row.report as DeploymentInfo['report']) ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** 触发部署：必须携带通过的 CLI 检查报告（决策 #8） */
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
    const [row] = await this.db
      .insert(deployments)
      .values({ projectId: project.id, triggeredBy: user.id, report: report as unknown as Record<string, unknown> })
      .returning();
    try {
      await client.deploy(project.dokployApplicationId);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.db.update(deployments).set({ status: 'failed', error: message, updatedAt: sql`now()` }).where(eq(deployments.id, row.id));
      this.logger.warn(`部署触发失败(${slug}): ${message}`);
      return this.toDeploymentInfo((await this.db.select().from(deployments).where(eq(deployments.id, row.id)))[0]);
    }
    await this.audit.record({ actorId: user.id, action: 'deploy.triggered', targetType: 'deployment', targetId: row.id, meta: { project: slug } });
    return this.toDeploymentInfo(row);
  }

  async listDeployments(user: AuthUser, slug: string): Promise<DeploymentInfo[]> {
    const project = await this.getProject(slug);
    void user;
    const rows = await this.db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, project.id))
      .orderBy(desc(deployments.createdAt))
      .limit(50);
    return Promise.all(rows.map((r) => this.toDeploymentInfo(r)));
  }

  /**
   * CLI 各处展示的都是 ID 前 8 位，这里把短 ID 还原成完整 ID。
   * 部署记录对所有登录用户可见，故匹配范围即全部记录，与 getDeployment 的可见范围一致。
   */
  private async resolveDeploymentId(raw: string): Promise<string> {
    return resolveShortId(raw, '部署记录', async (prefix) => {
      const rows = await this.db
        .select({ id: deployments.id })
        .from(deployments)
        .where(sql`${deployments.id}::text like ${prefix + '%'}`)
        .limit(2);
      return rows.map((r) => r.id);
    });
  }

  /** 查询某次部署（按需刷新） */
  async getDeployment(user: AuthUser, rawId: string): Promise<DeploymentInfo> {
    void user;
    const id = await this.resolveDeploymentId(rawId);
    const row = (await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '部署记录不存在' });
    return this.toDeploymentInfo(await this.refreshIfDeploying(row));
  }

  /** 项目最近一次部署（按需刷新）：`eat project status <slug>` 用它，省得先去记部署 ID */
  async latestDeployment(user: AuthUser, slug: string): Promise<DeploymentInfo> {
    void user;
    const project = await this.getProject(slug);
    const row = (
      await this.db
        .select()
        .from(deployments)
        .where(eq(deployments.projectId, project.id))
        .orderBy(desc(deployments.createdAt))
        .limit(1)
    )[0];
    if (!row) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: `项目 ${slug} 还没有部署记录（eat deploy ${slug} 触发一次）` });
    }
    return this.toDeploymentInfo(await this.refreshIfDeploying(row));
  }

  /**
   * deploying 状态时按需向 Dokploy 拉一次真实状态（不做后台轮询任务）。
   *
   * 状态以 Dokploy 的**构建记录**为准（决策 28）：application.applicationStatus 是「应用当前状态」，
   * 同一应用被别人再次部署就会串味；构建记录一次部署一条，失败时还能顺着它读到真实报错。
   * Dokploy 的部署是排队执行的，触发那一刻记录还没建出来，所以只能懒绑定——首次查到就记住。
   */
  private async refreshIfDeploying(row: DeploymentRow): Promise<DeploymentRow> {
    if (row.status !== 'deploying') return row;
    const [project] = await this.db.select().from(projects).where(eq(projects.id, row.projectId));
    if (!project) return row;
    try {
      const client = await this.client();
      const build = await this.bindBuild(client, row, project);
      if (build?.status === 'done') {
        await this.settleDeployment(row.id, 'success', null);
      } else if (build?.status === 'error') {
        await this.settleDeployment(row.id, 'failed', await this.buildFailureReason(client, build, project.slug));
      } else if (!build && Date.now() - row.createdAt.getTime() > BIND_TIMEOUT_MS) {
        // 长时间绑不上（Dokploy 记录被删、或换了不建构建记录的老版本）就回落到应用状态，
        // 否则这条记录会永远停在 deploying
        const status = await client.applicationStatus(project.dokployApplicationId);
        if (status === 'done') {
          await this.settleDeployment(row.id, 'success', null);
        } else if (status === 'error') {
          await this.settleDeployment(
            row.id,
            'failed',
            `Dokploy 报告该应用构建失败，但没找到本次部署对应的构建记录（完整日志: eat project build-logs ${project.slug}）`,
          );
        }
      }
    } catch (err) {
      // 查不到就维持原状，下次再查——按需刷新本就允许失败
      this.logger.warn(`查询 Dokploy 状态失败: ${(err as Error).message}`);
    }
    return (await this.db.select().from(deployments).where(eq(deployments.id, row.id)))[0] ?? row;
  }

  /** 找出并记住本次部署对应的 Dokploy 构建记录 */
  private async bindBuild(
    client: DokployClient,
    row: DeploymentRow,
    project: ProjectRow,
  ): Promise<DokployDeployment | undefined> {
    const builds = await client.listDeployments(project.dokployApplicationId);
    if (row.dokployDeploymentId) return builds.find((b) => b.deploymentId === row.dokployDeploymentId);
    // 我们触发之后 Dokploy 建出来的第一条就是本次（留点余量给两边时钟差）
    const floor = row.createdAt.getTime() - BIND_CLOCK_SKEW_MS;
    const ours = builds
      .map((b) => ({ build: b, at: Date.parse(b.createdAt) }))
      .filter((x) => Number.isFinite(x.at) && x.at >= floor)
      .sort((a, b) => a.at - b.at)[0]?.build;
    if (!ours) return undefined;
    await this.db
      .update(deployments)
      .set({ dokployDeploymentId: ours.deploymentId })
      .where(eq(deployments.id, row.id));
    return ours;
  }

  private async settleDeployment(id: string, status: 'success' | 'failed', error: string | null): Promise<void> {
    await this.db.update(deployments).set({ status, error, updatedAt: sql`now()` }).where(eq(deployments.id, id));
  }

  /**
   * 失败原因直接带上构建日志末尾几行（决策 28）：以前只写一句「详见 Dokploy 控制台」，
   * 等于让人/Agent 自己去翻，排查一次要跳出平台。
   */
  private async buildFailureReason(
    client: DokployClient,
    build: DokployDeployment,
    slug: string,
  ): Promise<string> {
    const head = `Dokploy 构建失败（完整日志: eat project build-logs ${slug}）`;
    let logs = '';
    try {
      logs = await client.readDeploymentLogs(build.deploymentId, FAILURE_LOG_TAIL);
    } catch (err) {
      this.logger.warn(`读取 Dokploy 构建日志失败: ${(err as Error).message}`);
    }
    const tail = logs
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l !== '')
      .slice(-FAILURE_LOG_LINES)
      .join('\n');
    if (!tail) return build.errorMessage ? `${head}: ${build.errorMessage}` : head;
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
