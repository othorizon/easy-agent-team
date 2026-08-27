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

export const dokploySettingsInfoSchema = z.object({
  apiUrl: z.string(),
  apiTokenMasked: z.string(),
  enabled: z.boolean(),
  configured: z.boolean(),
});
export type DokploySettingsInfo = z.infer<typeof dokploySettingsInfoSchema>;

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

export const deploymentStatusSchema = z.enum(['deploying', 'success', 'failed']);
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export const deploymentInfoSchema = z.object({
  id: z.string(),
  projectSlug: z.string(),
  status: deploymentStatusSchema,
  triggeredBy: z.string(),
  triggeredByName: z.string(),
  error: z.string().nullable(),
  report: precheckReportSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DeploymentInfo = z.infer<typeof deploymentInfoSchema>;

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
