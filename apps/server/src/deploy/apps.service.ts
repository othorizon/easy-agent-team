import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AppEnv,
  AppEnvChange,
  AppInfo,
  CreateAppRequest,
  MountAppRequest,
  UpdateAppEnvRequest,
  UpdateAppRequest,
} from '@eat/shared';
import {
  DEFAULT_DOCKERFILE,
  DEFAULT_PUBLISH_DIRECTORY,
  DNS_LABEL_REGEX,
  HOSTNAME_MAX_LENGTH,
  appContainerPort,
  appDomainHost,
  appUrl,
  diffDotenv,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { appMembers, apps, users } from '../db/schema';
import type { DokployClient } from './dokploy.client';
import { DokploySettingsService } from './dokploy-settings.service';

export type AppRow = typeof apps.$inferSelect;

/** Dokploy 侧「仓库内构建根目录」，平台不开放配置，固定仓库根 */
const GIT_BUILD_PATH = '/';

/**
 * 应用（决策 31）：平台实体与 Dokploy 的 application 一一对应。
 *
 * 两种来源：
 *   managed=true  用户自助创建——平台在 Dokploy 上建 application、绑 Git 源 + SSH key + 构建方式，
 *                 改 Git / 构建字段同步写回 Dokploy，删除时连 Dokploy 上的应用一起删；
 *   managed=false 管理员挂载既有 application——平台只记 id，构建配置归 Dokploy 侧维护、删除只解绑。
 *
 * 部署授权：用户自建的应用 deployApproved 默认 false，管理员放行一次后永久有效；
 * 管理员自己建的 / 挂载的创建即视为已授权。门禁本身在 DeployService.deploy 里。
 */
@Injectable()
export class AppsService {
  private readonly logger = new Logger(AppsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly dokploy: DokploySettingsService,
  ) {}

  // ---------- 查询与权限 ----------

  async getApp(slug: string): Promise<AppRow> {
    const row = (await this.db.select().from(apps).where(eq(apps.slug, slug)).limit(1))[0];
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: `应用 ${slug} 不存在` });
    return row;
  }

  private async memberIds(appId: string): Promise<Set<string>> {
    const rows = await this.db.select({ userId: appMembers.userId }).from(appMembers).where(eq(appMembers.appId, appId));
    return new Set(rows.map((r) => r.userId));
  }

  /** 成员 = Owner / 被加入的成员 / 管理员：部署、日志、env、部署失败详情都按它判 */
  async isMember(app: AppRow, user: AuthUser): Promise<boolean> {
    if (user.role === 'admin' || app.ownerId === user.id) return true;
    return (await this.memberIds(app.id)).has(user.id);
  }

  canManage(app: AppRow, user: AuthUser): boolean {
    return user.role === 'admin' || app.ownerId === user.id;
  }

  async assertMember(app: AppRow, user: AuthUser, what: string): Promise<void> {
    if (!(await this.isMember(app, user))) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `仅应用成员可${what}（找 Owner 把你加入应用）` });
    }
  }

  private assertCanManage(app: AppRow, user: AuthUser, what: string): void {
    if (!this.canManage(app, user)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `仅应用 Owner 或管理员可${what}` });
    }
  }

  private async userNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async toAppInfo(row: AppRow, user: AuthUser): Promise<AppInfo> {
    const names = await this.userNames([row.ownerId, row.approvedBy]);
    const members = await this.db
      .select({ userId: appMembers.userId, name: users.name })
      .from(appMembers)
      .innerJoin(users, eq(appMembers.userId, users.id))
      .where(eq(appMembers.appId, row.id));
    const isMember = await this.isMember(row, user);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      repoUrl: row.repoUrl,
      branch: row.branch,
      buildType: row.buildType,
      dockerfile: row.dockerfile,
      dockerContextPath: row.dockerContextPath,
      publishDirectory: row.publishDirectory,
      staticSpa: row.staticSpa,
      port: row.port,
      domain: row.domain,
      url: row.domain ? appUrl(row.domain, row.domainHttps) : null,
      dokployApplicationId: row.dokployApplicationId,
      description: row.description,
      ownerId: row.ownerId,
      ownerName: names.get(row.ownerId) ?? '(已删除)',
      members,
      isMember,
      canDeploy: isMember && row.deployApproved,
      managed: row.managed,
      deployApproved: row.deployApproved,
      approvedByName: row.approvedBy ? (names.get(row.approvedBy) ?? '(已删除)') : null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvalRequestedAt: row.approvalRequestedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listApps(user: AuthUser): Promise<AppInfo[]> {
    const rows = await this.db.select().from(apps).orderBy(asc(apps.slug));
    return Promise.all(rows.map((r) => this.toAppInfo(r, user)));
  }

  private async assertSlugFree(slug: string): Promise<void> {
    const exists = await this.db.select({ id: apps.id }).from(apps).where(eq(apps.slug, slug)).limit(1);
    if (exists.length > 0) throw new ConflictException({ error: 'CONFLICT', message: `应用 ${slug} 已存在` });
  }

  // ---------- 创建 / 挂载 ----------

  /**
   * 自动分配的域名（决策 32）：`<slug>.<后缀>`。slug 的规则比 DNS label 宽（允许以连字符结尾、长到 64），
   * 配了后缀时得先把它挡在建 Dokploy 应用之前，别建到一半才发现域名绑不上。
   */
  private domainFor(slug: string, suffix: string): string {
    const host = appDomainHost(slug, suffix);
    if (!DNS_LABEL_REGEX.test(slug) || host.length > HOSTNAME_MAX_LENGTH) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: `平台会给应用自动分配域名 ${host}，slug 需能作为域名前缀：不以连字符结尾、不超过 63 个字符`,
      });
    }
    return host;
  }

  /**
   * 自助创建（决策 31）：先在 Dokploy 上把应用建出来并配好，全部成功才落平台库。
   * Dokploy 侧几步（建应用 → 绑 Git 源 → 配构建方式 → 绑域名）任一步失败就把刚建的应用删掉
   * （域名随应用级联删），不留一个在 Dokploy 上有、平台里没有的孤儿——那种应用用户看不见也删不掉。
   */
  async createApp(user: AuthUser, dto: CreateAppRequest): Promise<AppInfo> {
    await this.assertSlugFree(dto.slug);
    const { client, environmentId, sshKeyId, domainSuffix, domainHttps } = await this.dokploy.provisioning();
    // 决策 32：管理员配了后缀才分配；没配就不绑域名，应用照常可建
    const domain = domainSuffix ? this.domainFor(dto.slug, domainSuffix) : null;

    const created = await this.dokploy.callDokploy(
      () =>
        client.createApplication({
          name: dto.name,
          description: [`由 eat 平台创建（${dto.slug}，Owner ${user.name}）`, dto.description].filter(Boolean).join('\n'),
          environmentId,
        }),
      '在部署后台创建应用失败',
    );
    let dokployDomainId: string | null = null;
    try {
      await this.syncGitProvider(client, created.applicationId, dto.repoUrl, dto.branch, sshKeyId);
      await this.syncBuildType(client, created.applicationId, dto);
      if (domain) {
        const bound = await this.dokploy.callDokploy(
          () =>
            client.createDomain({
              applicationId: created.applicationId,
              host: domain,
              port: appContainerPort(dto.buildType, dto.port),
              https: domainHttps,
            }),
          '在部署后台绑定域名失败',
        );
        dokployDomainId = bound.domainId;
      }
    } catch (err) {
      await client.deleteApplication(created.applicationId).catch((e: Error) => {
        this.logger.warn(`回滚删除部署后台应用 ${created.applicationId} 失败（忽略）: ${e.message}`);
      });
      throw err;
    }

    const admin = user.role === 'admin';
    const [row] = await this.db
      .insert(apps)
      .values({
        slug: dto.slug,
        name: dto.name,
        repoUrl: dto.repoUrl,
        branch: dto.branch,
        buildType: dto.buildType,
        dockerfile: dto.dockerfile,
        dockerContextPath: dto.dockerContextPath,
        publishDirectory: dto.publishDirectory,
        staticSpa: dto.staticSpa,
        port: dto.port,
        domain,
        domainHttps: domain ? domainHttps : false,
        dokployDomainId,
        dokployApplicationId: created.applicationId,
        description: dto.description,
        ownerId: user.id,
        managed: true,
        // 管理员自己建的不必再走一遍授权
        deployApproved: admin,
        approvedBy: admin ? user.id : null,
        approvedAt: admin ? new Date() : null,
      })
      .returning();
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'app.created',
      targetType: 'app',
      targetId: row.id,
      meta: { slug: dto.slug, dokployApplicationId: created.applicationId, buildType: dto.buildType, domain },
    });
    return this.toAppInfo(row, user);
  }

  /** 管理员挂载 Dokploy 上既有的 application：平台只记 id，不动 Dokploy 侧的任何配置 */
  async mountApp(user: AuthUser, dto: MountAppRequest): Promise<AppInfo> {
    await this.assertSlugFree(dto.slug);
    const [row] = await this.db
      .insert(apps)
      .values({
        slug: dto.slug,
        name: dto.name,
        repoUrl: dto.repoUrl,
        buildType: null,
        dokployApplicationId: dto.dokployApplicationId,
        description: dto.description,
        ownerId: user.id,
        managed: false,
        deployApproved: true,
        approvedBy: user.id,
        approvedAt: new Date(),
      })
      .returning();
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'app.mounted',
      targetType: 'app',
      targetId: row.id,
      meta: { slug: dto.slug, dokployApplicationId: dto.dokployApplicationId },
    });
    return this.toAppInfo(row, user);
  }

  private async syncGitProvider(
    client: DokployClient,
    applicationId: string,
    repoUrl: string,
    branch: string,
    sshKeyId: string,
  ): Promise<void> {
    await this.dokploy.callDokploy(
      () =>
        client.saveGitProvider({
          applicationId,
          customGitUrl: repoUrl,
          customGitBranch: branch,
          customGitBuildPath: GIT_BUILD_PATH,
          customGitSSHKeyId: sshKeyId || null,
        }),
      '在部署后台配置 Git 源失败',
    );
  }

  private async syncBuildType(
    client: DokployClient,
    applicationId: string,
    cfg: Pick<AppRow, 'buildType' | 'dockerfile' | 'dockerContextPath' | 'publishDirectory' | 'staticSpa'>,
  ): Promise<void> {
    await this.dokploy.callDokploy(
      () =>
        client.saveBuildType({
          applicationId,
          buildType: cfg.buildType ?? 'dockerfile',
          dockerfile: cfg.dockerfile || DEFAULT_DOCKERFILE,
          dockerContextPath: cfg.dockerContextPath,
          publishDirectory: cfg.publishDirectory || DEFAULT_PUBLISH_DIRECTORY,
          isStaticSpa: cfg.staticSpa,
        }),
      '在部署后台配置构建方式失败',
    );
  }

  // ---------- 更新 / 删除 ----------

  /**
   * 更新。平台托管的应用：Git 字段（仓库 / 分支）与构建字段有变化才回写 Dokploy，
   * 先写 Dokploy 再落库——Dokploy 拒绝时平台侧不该先改成一个 Dokploy 上并不生效的配置。
   * 域名转发的容器端口跟着构建方式 / port 走（static 固定 80），有域名的应用变了就回写域名记录。
   * 挂载的应用：只改平台侧信息，构建配置字段一律拒绝。
   */
  async updateApp(user: AuthUser, slug: string, dto: UpdateAppRequest): Promise<AppInfo> {
    const app = await this.getApp(slug);
    this.assertCanManage(app, user, '修改');
    const buildKeys = ['buildType', 'dockerfile', 'dockerContextPath', 'publishDirectory', 'staticSpa'] as const;
    const touchesBuild = (['branch', 'port', ...buildKeys] as const).some((k) => dto[k] !== undefined);

    if (!app.managed) {
      if (touchesBuild) {
        throw new BadRequestException({
          error: 'VALIDATION_FAILED',
          message: '管理员挂载的应用：分支与构建配置由管理员在部署后台维护，平台不代改',
        });
      }
    } else if (dto.dokployApplicationId !== undefined && dto.dokployApplicationId !== app.dokployApplicationId) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: '平台创建的应用不能改绑部署后台的 application id',
      });
    }

    const next: AppRow = {
      ...app,
      name: dto.name ?? app.name,
      description: dto.description ?? app.description,
      repoUrl: dto.repoUrl ?? app.repoUrl,
      branch: dto.branch ?? app.branch,
      buildType: dto.buildType ?? app.buildType,
      dockerfile: dto.dockerfile ?? app.dockerfile,
      dockerContextPath: dto.dockerContextPath ?? app.dockerContextPath,
      publishDirectory: dto.publishDirectory ?? app.publishDirectory,
      staticSpa: dto.staticSpa ?? app.staticSpa,
      port: dto.port ?? app.port,
      dokployApplicationId: app.managed ? app.dokployApplicationId : (dto.dokployApplicationId ?? app.dokployApplicationId),
    };

    if (app.managed) {
      if (next.repoUrl === '') {
        throw new BadRequestException({ error: 'VALIDATION_FAILED', message: '平台托管的应用必须有 Git 仓库地址' });
      }
      const gitChanged = next.repoUrl !== app.repoUrl || next.branch !== app.branch;
      const buildChanged = buildKeys.some((k) => next[k] !== app[k]);
      const portChanged =
        app.domain !== null &&
        app.dokployDomainId !== null &&
        appContainerPort(next.buildType, next.port) !== appContainerPort(app.buildType, app.port);
      if (gitChanged || buildChanged || portChanged) {
        const client = await this.dokploy.client();
        // 换仓库时沿用管理员当前配置的 key：应用创建后管理员可能换过 key，以当前配置为准
        if (gitChanged) {
          const sshKeyId = (await this.dokploy.getSettings()).sshKeyId;
          await this.syncGitProvider(client, app.dokployApplicationId, next.repoUrl, next.branch, sshKeyId);
        }
        if (buildChanged) await this.syncBuildType(client, app.dokployApplicationId, next);
        if (portChanged) {
          await this.dokploy.callDokploy(
            () =>
              client.updateDomain({
                domainId: app.dokployDomainId as string,
                applicationId: app.dokployApplicationId,
                host: app.domain as string,
                port: appContainerPort(next.buildType, next.port),
                https: app.domainHttps,
              }),
            '在部署后台更新域名端口失败',
          );
        }
      }
    }

    const [row] = await this.db
      .update(apps)
      .set({
        name: next.name,
        description: next.description,
        repoUrl: next.repoUrl,
        branch: next.branch,
        buildType: next.buildType,
        dockerfile: next.dockerfile,
        dockerContextPath: next.dockerContextPath,
        publishDirectory: next.publishDirectory,
        staticSpa: next.staticSpa,
        port: next.port,
        dokployApplicationId: next.dokployApplicationId,
      })
      .where(eq(apps.id, app.id))
      .returning();
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'app.updated',
      targetType: 'app',
      targetId: app.id,
      meta: { slug, fields: Object.keys(dto).filter((k) => dto[k as keyof UpdateAppRequest] !== undefined) },
    });
    return this.toAppInfo(row, user);
  }

  /** 删除：平台托管的连 Dokploy 上的应用一起删（先删 Dokploy，删不掉就不动平台记录）；挂载的只解绑 */
  async removeApp(user: AuthUser, slug: string) {
    const app = await this.getApp(slug);
    this.assertCanManage(app, user, '删除');
    if (app.managed) {
      const client = await this.dokploy.client();
      await this.dokploy.callDokploy(() => client.deleteApplication(app.dokployApplicationId), '在部署后台删除应用失败');
    }
    await this.db.delete(apps).where(eq(apps.id, app.id));
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'app.deleted',
      targetType: 'app',
      targetId: app.id,
      meta: { slug, managed: app.managed, dokployApplicationId: app.dokployApplicationId },
    });
    return { ok: true, dokployDeleted: app.managed };
  }

  // ---------- 成员 ----------

  async addMember(user: AuthUser, slug: string, userId: string) {
    const app = await this.getApp(slug);
    this.assertCanManage(app, user, '管理成员');
    await this.db.insert(appMembers).values({ appId: app.id, userId }).onConflictDoNothing();
    await this.audit.record({ actorId: user.id, action: 'app.member_added', targetType: 'app', targetId: app.id, meta: { userId } });
    return { ok: true };
  }

  async removeMember(user: AuthUser, slug: string, userId: string) {
    const app = await this.getApp(slug);
    this.assertCanManage(app, user, '管理成员');
    await this.db.delete(appMembers).where(and(eq(appMembers.appId, app.id), eq(appMembers.userId, userId)));
    return { ok: true };
  }

  // ---------- 部署授权（决策 31） ----------

  async approveDeploy(admin: AuthUser, slug: string): Promise<AppInfo> {
    const app = await this.getApp(slug);
    const [row] = await this.db
      .update(apps)
      .set({ deployApproved: true, approvedBy: admin.id, approvedAt: new Date(), approvalRequestedAt: null })
      .where(eq(apps.id, app.id))
      .returning();
    await this.audit.record({ actorId: admin.id, action: 'app.deploy_approved', targetType: 'app', targetId: app.id, meta: { slug } });
    return this.toAppInfo(row, admin);
  }

  async revokeDeployApproval(admin: AuthUser, slug: string): Promise<AppInfo> {
    const app = await this.getApp(slug);
    const [row] = await this.db
      .update(apps)
      .set({ deployApproved: false, approvedBy: null, approvedAt: null })
      .where(eq(apps.id, app.id))
      .returning();
    await this.audit.record({ actorId: admin.id, action: 'app.deploy_approval_revoked', targetType: 'app', targetId: app.id, meta: { slug } });
    return this.toAppInfo(row, admin);
  }

  /** 部署门禁拒绝时记一笔「有人试过」，控制台据此把应用标成待授权 */
  async markApprovalRequested(appId: string): Promise<void> {
    await this.db.update(apps).set({ approvalRequestedAt: sql`now()` }).where(eq(apps.id, appId));
  }

  // ---------- 应用 env（决策 31） ----------

  /** 拉取：运行时 env 与构建时 buildArgs 都是 Dokploy 上的 dotenv 文本，原样带回；值可能是密钥，只给成员且落审计 */
  async getEnv(user: AuthUser, slug: string): Promise<AppEnv> {
    const app = await this.getApp(slug);
    await this.assertMember(app, user, '读取应用 env');
    const client = await this.dokploy.client();
    const detail = await this.dokploy.callDokploy(() => client.getApplication(app.dokployApplicationId), '读取部署后台应用详情失败');
    await this.audit.record({ actorId: user.id, actorTokenId: user.tokenId, action: 'app.env_read', targetType: 'app', targetId: app.id, meta: { slug } });
    return { appSlug: slug, runtime: detail.env, build: detail.buildArgs };
  }

  /**
   * 推送：整体覆盖目标区块（运行时或构建时），另一块与 buildSecrets 原样保留——
   * Dokploy 的 saveEnvironment 是整体写，少带一个字段就把人家的清空了。
   * 只回 key 级差异，值不进响应也不进审计。
   */
  async setEnv(user: AuthUser, slug: string, dto: UpdateAppEnvRequest): Promise<AppEnvChange> {
    const app = await this.getApp(slug);
    await this.assertMember(app, user, '修改应用 env');
    const client = await this.dokploy.client();
    const detail = await this.dokploy.callDokploy(() => client.getApplication(app.dokployApplicationId), '读取部署后台应用详情失败');
    const before = dto.target === 'runtime' ? detail.env : detail.buildArgs;
    await this.dokploy.callDokploy(
      () =>
        client.saveEnvironment({
          applicationId: app.dokployApplicationId,
          env: dto.target === 'runtime' ? dto.content : detail.env,
          buildArgs: dto.target === 'build' ? dto.content : detail.buildArgs,
          buildSecrets: detail.buildSecrets,
          createEnvFile: detail.createEnvFile,
        }),
      '在部署后台写入环境变量失败',
    );
    const diff = diffDotenv(before, dto.content);
    await this.audit.record({
      actorId: user.id,
      actorTokenId: user.tokenId,
      action: 'app.env_written',
      targetType: 'app',
      targetId: app.id,
      meta: { slug, target: dto.target, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
    });
    return { appSlug: slug, target: dto.target, ...diff };
  }
}
