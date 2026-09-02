import { z } from 'zod';
import { slugSchema } from './common.js';

/** 部署托管（Dokploy 挂载）与 CLI 端前置检查的契约 */

// ---------- Dokploy 接入配置（管理员） ----------

export const updateDokploySettingsSchema = z.object({
  apiUrl: z.url().max(500),
  /** 传空字符串表示保持现有 token 不变 */
  apiToken: z.string().max(1000),
  enabled: z.boolean(),
});
export type UpdateDokploySettingsRequest = z.infer<typeof updateDokploySettingsSchema>;

/** 连通性测试：用表单当前值调用 Dokploy 只读端点；apiToken 传空表示用已保存的 token */
export const testDokploySettingsSchema = updateDokploySettingsSchema.omit({ enabled: true });
export type TestDokploySettingsRequest = z.infer<typeof testDokploySettingsSchema>;

export const dokploySettingsInfoSchema = z.object({
  apiUrl: z.string(),
  apiTokenMasked: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
});
export type DokploySettingsInfo = z.infer<typeof dokploySettingsInfoSchema>;

/**
 * Dokploy 上的一个应用（供控制台「从 Dokploy 选择」快速填 application id 用，决策 27）。
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

// ---------- 项目 ----------

export const createProjectSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  repoUrl: z.string().max(500).default(''),
  /** Dokploy 上对应的 application id */
  dokployApplicationId: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
});
export type CreateProjectRequest = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial().omit({ slug: true });
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;

export const projectInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  dokployApplicationId: z.string(),
  description: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  members: z.array(z.object({ userId: z.string(), name: z.string() })),
  /** 当前用户是否可部署（Owner/成员/管理员） */
  canDeploy: z.boolean(),
  createdAt: z.string(),
});
export type ProjectInfo = z.infer<typeof projectInfoSchema>;

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

export const triggerDeploySchema = z.object({
  /** CLI 端检查报告：必须携带且 passed=true（决策 #8：防顺手绕过） */
  report: precheckReportSchema,
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

/** 部署来源：platform=经 eat 平台触发（带密钥扫描报告）/ dokploy=直接在 Dokploy 侧触发，未经平台门禁 */
export const deploymentOriginSchema = z.enum(['platform', 'dokploy']);
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
  projectSlug: z.string(),
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
  projectSlug: z.string(),
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
  projectSlug: z.string(),
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
