import { z } from 'zod';
import { slugSchema } from './common.js';

/**
 * 部署托管（Dokploy 挂载）与 CLI 端前置检查的契约。
 *
 * 平台实体叫「应用（App）」，与 Dokploy 的 application 一一对应（决策 31）：
 * 用户自助创建应用时平台在 Dokploy 上建出 application 并绑好 Git 源 / SSH key / 构建方式；
 * 管理员也可以把 Dokploy 上既有的 application 挂载进来（managed=false）。
 * Dokploy 的「项目 / 环境」只出现在管理员的接入配置里，用户侧不再感知。
 */

// ---------- 自动分配域名（决策 32） ----------

/** RFC 1123 主机名（Dokploy 校验域名用的就是这个形状；下划线不许，Let's Encrypt 不给签） */
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** 域名后缀至少两段（`apps.example.com`），小写、不带协议 / 路径 / 前导点 */
export const DOMAIN_SUFFIX_REGEX = new RegExp(`^(?:${HOSTNAME_LABEL}\\.)+${HOSTNAME_LABEL}$`);
/** 能直接当域名前缀用的 slug：一个合法的 DNS label（不以连字符结尾、不超过 63 字符） */
export const DNS_LABEL_REGEX = new RegExp(`^${HOSTNAME_LABEL}$`);
/** 完整主机名上限（RFC 1035） */
export const HOSTNAME_MAX_LENGTH = 253;

/**
 * 把管理员输入的后缀标准化：去空白、去协议、去 `*.` / 前导点、去尾部斜杠与点、转小写。
 * 管理员十有八九会照着 DNS 里的通配记录 `*.apps.example.com` 或带 https:// 的地址贴进来，别为这个报错。
 */
export function normalizeDomainSuffix(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[*.]+/, '')
    .replace(/[/.]+$/, '');
}

export const domainSuffixSchema = z
  .string()
  .max(HOSTNAME_MAX_LENGTH)
  .transform(normalizeDomainSuffix)
  .refine((v) => v === '' || DOMAIN_SUFFIX_REGEX.test(v), '域名后缀需为合法主机名（如 apps.example.com），不含协议与路径');

/** 应用自动分配到的主机名：`<slug>.<后缀>` */
export function appDomainHost(slug: string, suffix: string): string {
  return `${slug}.${suffix}`;
}

/** 域名的访问地址（回给三端展示 / 复制用） */
export function appUrl(domain: string, https: boolean): string {
  return `${https ? 'https' : 'http'}://${domain}`;
}

/** 容器监听端口：域名的流量转发到它。Dokploy 的域名表单默认也是 3000 */
export const DEFAULT_CONTAINER_PORT = 3000;
/** 静态托管固定 80：Dokploy 的 static 构建器就是 `FROM nginx:alpine`，nginx 监听 80，用户改不了 */
export const STATIC_CONTAINER_PORT = 80;
export const containerPortSchema = z.coerce.number().int().min(1).max(65535);

/** 域名实际转发到的容器端口：static 一律 80，dockerfile 用应用自己填的 */
export function appContainerPort(buildType: AppBuildType | null, port: number): number {
  return buildType === 'static' ? STATIC_CONTAINER_PORT : port;
}

// ---------- Dokploy 接入配置（管理员） ----------

export const updateDokploySettingsSchema = z.object({
  apiUrl: z.url().max(500),
  /** 传空字符串表示保持现有 token 不变 */
  apiToken: z.string().max(1000),
  enabled: z.boolean(),
  /** 自助创建的应用落在 Dokploy 的哪个项目 / 环境下；空串 = 未配置（此时不能自助建应用） */
  projectId: z.string().max(200).default(''),
  environmentId: z.string().max(200).default(''),
  /** 自助创建的应用拉取 Git 仓库用的 SSH key（管理员预先在 Dokploy 建好）；空串 = 不绑，只能拉公开仓库 */
  sshKeyId: z.string().max(200).default(''),
  /** 自动分配域名的后缀（决策 32）：配了就在建应用时绑 `<slug>.<后缀>`；空串 = 不自动分配 */
  domainSuffix: domainSuffixSchema.default(''),
  /** 自动分配的域名是否走 HTTPS（Dokploy 用 Let's Encrypt 签发，需要它自己的证书邮箱配置） */
  domainHttps: z.boolean().default(false),
});
export type UpdateDokploySettingsRequest = z.infer<typeof updateDokploySettingsSchema>;

/** 连通性测试：用表单当前值调用 Dokploy 只读端点；apiToken 传空表示用已保存的 token */
export const testDokploySettingsSchema = updateDokploySettingsSchema.pick({ apiUrl: true, apiToken: true });
export type TestDokploySettingsRequest = z.infer<typeof testDokploySettingsSchema>;

export const dokploySettingsInfoSchema = z.object({
  apiUrl: z.string(),
  apiTokenMasked: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
  projectId: z.string(),
  environmentId: z.string(),
  sshKeyId: z.string(),
  domainSuffix: z.string(),
  domainHttps: z.boolean(),
  /** 自助创建应用的前提是否齐：已启用 + 项目 + 环境都配了（SSH key 可空） */
  provisioningReady: z.boolean(),
});
export type DokploySettingsInfo = z.infer<typeof dokploySettingsInfoSchema>;

/** 管理员配置用：Dokploy 上的项目及其环境（project.all 展平） */
export const dokployProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  environments: z.array(z.object({ environmentId: z.string(), name: z.string(), isDefault: z.boolean() })),
});
export type DokployProject = z.infer<typeof dokployProjectSchema>;

/** 管理员配置用：Dokploy 上的 SSH key（sshKey.allForApps，只有 id 与名字，不含私钥） */
export const dokploySshKeySchema = z.object({ sshKeyId: z.string(), name: z.string() });
export type DokploySshKey = z.infer<typeof dokploySshKeySchema>;

/**
 * Dokploy 上的一个应用（供管理员「挂载既有应用」时快速填 application id 用，决策 27）。
 * name 是应用显示名、appName 是 Dokploy 生成的容器名（同名应用靠它区分）、projectName 是所属 Dokploy 项目。
 */
export const dokployApplicationSchema = z.object({
  applicationId: z.string(),
  name: z.string(),
  appName: z.string(),
  projectName: z.string(),
  description: z.string(),
});
export type DokployApplication = z.infer<typeof dokployApplicationSchema>;

// ---------- 应用 ----------

/**
 * 构建方式（决策 31）：只开放两种。
 *   static     = Dokploy 把发布目录原样丢进 nginx 镜像托管，**不跑任何构建命令**，仓库里得直接有产物；
 *   dockerfile = 按仓库里的 Dockerfile 构建，要先 build 再托管产物的都走这条。
 */
export const appBuildTypeSchema = z.enum(['static', 'dockerfile']);
export type AppBuildType = z.infer<typeof appBuildTypeSchema>;

export const APP_BUILD_TYPE_LABEL: Record<AppBuildType, string> = {
  static: '静态托管',
  dockerfile: 'Dockerfile',
};

export const DEFAULT_BRANCH = 'main';
export const DEFAULT_DOCKERFILE = 'Dockerfile';
export const DEFAULT_PUBLISH_DIRECTORY = '.';

/** 相对仓库根的路径：不许绝对路径、不许 `..` 往上跳 */
const repoPathSchema = z
  .string()
  .max(300)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), '需为相对仓库根的路径');

/** 自助创建应用：平台在 Dokploy 上建 application 并绑好 Git 源、SSH key、构建方式 */
export const createAppSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  /** Git 仓库地址（必填）：https 或 ssh 形式都行；私有仓库要靠管理员配置的 SSH key */
  repoUrl: z.string().min(1).max(500),
  branch: z.string().min(1).max(200).default(DEFAULT_BRANCH),
  buildType: appBuildTypeSchema,
  /** dockerfile：Dockerfile 路径（相对仓库根） */
  dockerfile: repoPathSchema.default(DEFAULT_DOCKERFILE),
  /** dockerfile：构建上下文（相对仓库根，空 = 仓库根） */
  dockerContextPath: repoPathSchema.default(''),
  /** static：发布目录（相对仓库根） */
  publishDirectory: repoPathSchema.default(DEFAULT_PUBLISH_DIRECTORY),
  /** static：SPA 模式（所有路径回退到 index.html） */
  staticSpa: z.boolean().default(false),
  /** dockerfile：容器监听端口，自动分配的域名把流量转发到它（static 固定 80，此字段不生效） */
  port: containerPortSchema.default(DEFAULT_CONTAINER_PORT),
  description: z.string().max(2000).default(''),
});
export type CreateAppRequest = z.infer<typeof createAppSchema>;

/** 管理员挂载 Dokploy 上既有的 application（不由平台创建，删除时也不动 Dokploy） */
export const mountAppSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  dokployApplicationId: z.string().min(1).max(200),
  repoUrl: z.string().max(500).default(''),
  description: z.string().max(2000).default(''),
});
export type MountAppRequest = z.infer<typeof mountAppSchema>;

/**
 * 更新应用。平台托管的应用（managed=true）改 Git / 构建字段会同步写回 Dokploy；
 * 挂载的应用只改平台侧信息（名称 / 说明 / 仓库地址备注 / application id），构建配置归 Dokploy 侧维护。
 */
export const updateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  repoUrl: z.string().max(500).optional(),
  branch: z.string().min(1).max(200).optional(),
  buildType: appBuildTypeSchema.optional(),
  dockerfile: repoPathSchema.optional(),
  dockerContextPath: repoPathSchema.optional(),
  publishDirectory: repoPathSchema.optional(),
  staticSpa: z.boolean().optional(),
  port: containerPortSchema.optional(),
  /** 仅挂载的应用可改 */
  dokployApplicationId: z.string().min(1).max(200).optional(),
});
export type UpdateAppRequest = z.infer<typeof updateAppSchema>;

export const appInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  branch: z.string(),
  /** 挂载的应用为 null：构建配置在 Dokploy 侧，平台不替它记 */
  buildType: appBuildTypeSchema.nullable(),
  dockerfile: z.string(),
  dockerContextPath: z.string(),
  publishDirectory: z.string(),
  staticSpa: z.boolean(),
  /** dockerfile 应用的容器监听端口（static 固定 80，这里的值不生效） */
  port: z.number(),
  /** 创建时自动分配的域名（决策 32）；没配后缀时建的、以及挂载的应用为 null */
  domain: z.string().nullable(),
  /** 域名的访问地址（含协议），domain 为 null 时也为 null */
  url: z.string().nullable(),
  dokployApplicationId: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  members: z.array(z.object({ userId: z.string(), name: z.string() })),
  /** 当前用户是否为成员（Owner / 成员 / 管理员）：日志、env、部署历史详情都按它判 */
  isMember: z.boolean(),
  /** 当前用户此刻能不能部署 = 成员 && 已授权可部署 */
  canDeploy: z.boolean(),
  /** 平台托管：由平台在 Dokploy 上自动创建，删除时连带删除；false = 管理员挂载的既有应用 */
  managed: z.boolean(),
  /** 管理员是否已授权可部署（决策 31：用户自建的应用首次部署要管理员放行一次，之后不再拦） */
  deployApproved: z.boolean(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  /** 最近一次因未授权被拒的部署尝试；null = 没人试过。控制台据此显示「待授权」 */
  approvalRequestedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

// ---------- 应用 env（决策 31） ----------

/** runtime = Dokploy 的 env（容器运行时）；build = Dokploy 的 buildArgs（构建时） */
export const appEnvTargetSchema = z.enum(['runtime', 'build']);
export type AppEnvTarget = z.infer<typeof appEnvTargetSchema>;

export const APP_ENV_TARGET_LABEL: Record<AppEnvTarget, string> = { runtime: '运行时', build: '构建时' };

/** 拉取：两块 dotenv 文本原样带回 */
export const appEnvSchema = z.object({
  appSlug: z.string(),
  runtime: z.string(),
  build: z.string(),
});
export type AppEnv = z.infer<typeof appEnvSchema>;

export const APP_ENV_MAX_CHARS = 200_000;

/** 推送：整体覆盖目标区块（另一块原样保留） */
export const updateAppEnvSchema = z.object({
  target: appEnvTargetSchema,
  content: z.string().max(APP_ENV_MAX_CHARS),
});
export type UpdateAppEnvRequest = z.infer<typeof updateAppEnvSchema>;

/** 推送结果：只报 key 级变化，不回值 */
export const appEnvChangeSchema = z.object({
  appSlug: z.string(),
  target: appEnvTargetSchema,
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  unchanged: z.number(),
});
export type AppEnvChange = z.infer<typeof appEnvChangeSchema>;

// ---------- CLI 端前置检查报告 ----------

export const precheckFindingSchema = z.object({
  /** generic=通用密钥模式 / fingerprint=平台密钥指纹命中 / dotenv=.env 误提交 */
  rule: z.enum(['generic', 'fingerprint', 'dotenv']),
  file: z.string(),
  line: z.number().optional(),
  note: z.string(),
});
export type PrecheckFinding = z.infer<typeof precheckFindingSchema>;

export const precheckReportSchema = z.object({
  passed: z.boolean(),
  scannedFiles: z.number(),
  findings: z.array(precheckFindingSchema).max(200),
  /** 本地预跑命令（--check）的结果，可选 */
  localCheck: z.object({ command: z.string(), passed: z.boolean() }).optional(),
  cliVersion: z.string(),
  ranAt: z.iso.datetime(),
});
export type PrecheckReport = z.infer<typeof precheckReportSchema>;

// ---------- 部署 ----------

/**
 * 部署来源。cli = `eat deploy` / MCP `trigger_deploy`，必须携带通过的本地检查报告（决策 #8）；
 * console = 控制台的「部署」按钮，没有本地代码可扫，记录会明确标成「未做密钥扫描」（决策 31）。
 */
export const deploySourceSchema = z.enum(['cli', 'console']);
export type DeploySource = z.infer<typeof deploySourceSchema>;

export const triggerDeploySchema = z.object({
  source: deploySourceSchema.default('cli'),
  /** CLI 端检查报告：source=cli 时必须携带且 passed=true（决策 #8：防顺手绕过） */
  report: precheckReportSchema.optional(),
});
export type TriggerDeployRequest = z.infer<typeof triggerDeploySchema>;

/**
 * 一条部署记录的状态（决策 30：以 Dokploy 为准）。
 * running / done / error / cancelled 直接是 Dokploy 构建记录的取值，平台不再自己维护一套；
 * 另有两个平台补充的状态：
 *   queued    = 已提交给 Dokploy、还在它的部署队列里排队，构建记录尚未建出；
 *   archived  = Dokploy 已按「每个应用只留最近 10 条」把构建记录清理掉，只剩平台侧元数据。
 */
export const deploymentStatusSchema = z.enum(['queued', 'running', 'done', 'error', 'cancelled', 'archived']);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/**
 * 部署来源：platform=经 eat 平台触发 / external=绕过平台、直接在部署后台（Dokploy）触发，未经平台门禁。
 * 取值不叫 dokploy：这个枚举会原样回给 CLI / MCP，而部署后台是平台的内部实现，对 AI 没有意义（决策 33）。
 */
export const deploymentOriginSchema = z.enum(['platform', 'external']);
export type DeploymentOrigin = z.infer<typeof deploymentOriginSchema>;

/**
 * 平台为一次部署附加的业务元数据（决策 30）——Dokploy 的构建记录上没有这些信息。
 * claim 说明这份元数据是怎么跟构建记录对上的：
 *   tagged   = 触发时写进 Dokploy description 的标记精确匹配（Dokploy ≥ v0.25.0），可靠；
 *   inferred = 按触发时间就近推断（老版本 Dokploy、或本次改造之前的历史记录），可能张冠李戴；
 *   none     = 还没跟任何构建记录关联——要么刚触发、Dokploy 还没把记录建出来（queued），
 *              要么记录已被 Dokploy 清理（archived）。这两种情况下归属都是确定的，
 *              因为这行本来就是从平台元数据长出来的。
 */
export const deploymentMetaSchema = z.object({
  id: z.string(),
  triggeredBy: z.string(),
  triggeredByName: z.string(),
  source: deploySourceSchema,
  /** source=console 时为 null：没做密钥扫描 */
  report: precheckReportSchema.nullable(),
  claim: z.enum(['tagged', 'inferred', 'none']),
  /** 平台侧触发时间；Dokploy 构建记录自己的时间在外层 createdAt */
  triggeredAt: z.string(),
});
export type DeploymentMeta = z.infer<typeof deploymentMetaSchema>;

/**
 * 一条部署记录：主体是 Dokploy 的构建记录，platform 是平台能补上的元数据。
 * platform 为 null 即「直接在 Dokploy 侧触发、没经过平台的密钥扫描门禁」。
 */
export const deploymentInfoSchema = z.object({
  appSlug: z.string(),
  /** Dokploy 构建记录 id；排队中、以及记录已被 Dokploy 清理时为 null */
  deploymentId: z.string().nullable(),
  status: deploymentStatusSchema,
  origin: deploymentOriginSchema,
  /** 构建记录标题：平台触发的带 eat 前缀，Dokploy 侧触发的是 Manual deployment */
  title: z.string(),
  /** 失败原因：列表里是构建记录上的 errorMessage，查单条时会补上构建日志末尾几行（决策 28） */
  error: z.string().nullable(),
  createdAt: z.string(),
  platform: deploymentMetaSchema.nullable(),
});
export type DeploymentInfo = z.infer<typeof deploymentInfoSchema>;

/**
 * 部署历史查询。默认（all=false）以 Dokploy 的构建记录为准，只有它还留着的那些（最多 10 条）；
 * all=true 改以平台元数据为主干列出全部历史，Dokploy 已清理的显示为 archived。
 */
export const deploymentsQuerySchema = z.object({
  all: z
    .string()
    .optional()
    .transform((v) => v === '' || v === 'true' || v === '1'),
});
export type DeploymentsQuery = z.infer<typeof deploymentsQuerySchema>;

// ---------- 构建日志 / 运行日志（决策 28） ----------

/**
 * Dokploy 上的一次构建记录。status 用的是 Dokploy 自己的取值——它的 deploymentStatus 枚举
 * 就是 running=构建中 / done=成功 / error=失败 / cancelled=被取消这四个，没有别的
 * （曾经写成 idle，那是 application.applicationStatus 的取值，被取消的构建会被错显示成「空闲」）。
 */
export const dokployDeploymentSchema = z.object({
  deploymentId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  errorMessage: z.string(),
  createdAt: z.string(),
});
export type DokployDeployment = z.infer<typeof dokployDeploymentSchema>;

/** 构建日志：某次 Dokploy 构建的日志正文 + 最近几次构建供切换 */
export const buildLogsResultSchema = z.object({
  appSlug: z.string(),
  /** 本次读取的构建记录；应用还没构建过时为 null */
  deployment: dokployDeploymentSchema.nullable(),
  logs: z.string(),
  /** 最近的构建记录（最新在前，最多 20 条），供 --deployment 指定回看 */
  recent: z.array(dokployDeploymentSchema),
});
export type BuildLogsResult = z.infer<typeof buildLogsResultSchema>;

/** Dokploy 上跑着的一个容器 */
export const dokployContainerSchema = z.object({
  containerId: z.string(),
  name: z.string(),
  state: z.string(),
  status: z.string(),
});
export type DokployContainer = z.infer<typeof dokployContainerSchema>;

/** 运行日志：某个容器的最近日志 */
export const runLogsResultSchema = z.object({
  appSlug: z.string(),
  /** 本次读取的容器；没有运行中的容器时为 null */
  container: dokployContainerSchema.nullable(),
  logs: z.string(),
  /** 该应用当前的全部容器（多副本时供 --container 指定） */
  containers: z.array(dokployContainerSchema),
});
export type RunLogsResult = z.infer<typeof runLogsResultSchema>;

/** 日志读取的行数范围：Dokploy 侧 deployment.readLogs 的上限就是 10000 */
export const LOG_TAIL_MIN = 1;
export const LOG_TAIL_MAX = 10_000;
export const LOG_TAIL_DEFAULT = 200;

export const logsQuerySchema = z.object({
  tail: z.coerce.number().int().min(LOG_TAIL_MIN).max(LOG_TAIL_MAX).default(LOG_TAIL_DEFAULT),
  /** 构建日志：指定 Dokploy 构建记录 id；缺省取最近一次 */
  deploymentId: z.string().max(200).optional(),
  /** 运行日志：指定容器 id；缺省取第一个运行中的容器 */
  containerId: z.string().max(200).optional(),
});
export type LogsQuery = z.infer<typeof logsQuerySchema>;

// ---------- 密钥指纹清单（CLI 扫描用） ----------

export const secretFingerprintSchema = z.object({
  /** 变量值的 SHA-256 hex */
  fingerprint: z.string(),
  length: z.number(),
  environment: z.string(),
  key: z.string(),
});
export type SecretFingerprint = z.infer<typeof secretFingerprintSchema>;

/** 只对长度达到该值的密钥生成指纹（防离线字典猜测短值） */
export const FINGERPRINT_MIN_LENGTH = 12;
