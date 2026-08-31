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
  ConnectionTestResult,
  CreateProjectRequest,
  DeploymentInfo,
  DokployApplication,
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
    try {
      return await client.listApplications();
    } catch (err) {
      const e = err as Error & { cause?: { message?: string } };
      const detail = e.cause?.message ? `${e.message}（${e.cause.message}）` : e.message;
      throw new ServiceUnavailableException({
        error: 'DOKPLOY_UNAVAILABLE',
        message: `拉取 Dokploy 应用清单失败: ${detail}`,
      });
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

  /** 查询部署：deploying 状态时向 Dokploy 拉取应用状态并刷新（按需轮询，不做后台任务） */
  async getDeployment(user: AuthUser, rawId: string): Promise<DeploymentInfo> {
    void user;
    const id = await this.resolveDeploymentId(rawId);
    let row = (await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '部署记录不存在' });
    if (row.status === 'deploying') {
      const [project] = await this.db.select().from(projects).where(eq(projects.id, row.projectId));
      if (project) {
        try {
          const status = await (await this.client()).applicationStatus(project.dokployApplicationId);
          if (status === 'done') {
            await this.db.update(deployments).set({ status: 'success', updatedAt: sql`now()` }).where(eq(deployments.id, id));
          } else if (status === 'error') {
            await this.db
              .update(deployments)
              .set({ status: 'failed', error: 'Dokploy 构建/部署失败，详见 Dokploy 控制台该应用的部署日志', updatedAt: sql`now()` })
              .where(eq(deployments.id, id));
          }
        } catch (err) {
          this.logger.warn(`查询 Dokploy 状态失败: ${(err as Error).message}`);
        }
        row = (await this.db.select().from(deployments).where(eq(deployments.id, id)))[0];
      }
    }
    return this.toDeploymentInfo(row);
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
