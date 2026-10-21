import { z } from 'zod';

export const REQUEST_TYPES = {
  env: '环境变量读取',
  mcp: 'MCP 配置订阅',
  db: '数据库申请',
  oss: 'OSS 空间申请',
  app: '应用部署授权',
} as const;
export const REQUEST_STATUSES = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  withdrawn: '已撤回',
  invalid: '已失效',
} as const;
export const requestTypeSchema = z.enum(['env', 'mcp', 'db', 'oss', 'app']);
export const requestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'invalid']);
export const requestListSchema = z.object({
  scope: z.enum(['inbox', 'mine', 'history', 'resource']).default('mine'),
  type: requestTypeSchema.optional(),
  status: z.enum(['all', 'ongoing', ...requestStatusSchema.options]).default('all'),
  q: z.string().trim().max(120).default(''),
  days: z.coerce.number().int().min(0).max(3650).default(0),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sourceId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
});
export const requestDecisionSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().max(2000).optional(),
    grantExpiresAt: z.string().datetime().optional(),
  })
  .superRefine((v, c) => {
    if (v.decision === 'rejected' && !v.reason)
      c.addIssue({ code: 'custom', path: ['reason'], message: '请填写驳回原因' });
    if (v.grantExpiresAt && Date.parse(v.grantExpiresAt) <= Date.now())
      c.addIssue({ code: 'custom', path: ['grantExpiresAt'], message: '授权有效期必须晚于当前时间' });
  });
export const requestResubmitSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
export type RequestListQuery = z.infer<typeof requestListSchema>;
export type RequestDecision = z.infer<typeof requestDecisionSchema>;
export interface ApprovalRequest {
  id: string;
  type: keyof typeof REQUEST_TYPES;
  sourceId: string;
  resourceId: string;
  requesterId: string;
  requesterName: string;
  targetName: string;
  resourceUrl: string;
  reason: string;
  status: keyof typeof REQUEST_STATUSES;
  rejectionReason: string | null;
  closedReason: string | null;
  execution: string | null;
  executionError: string | null;
  decidedByName: string | null;
  createdAt: string;
  decidedAt: string | null;
  round: number;
  latest: boolean;
  details: Record<string, unknown>;
  canApprove: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  canRemind: boolean;
  notificationError: string | null;
}
export interface ApprovalRequestPage {
  items: ApprovalRequest[];
  total: number;
  page: number;
  pageSize: number;
  pendingCount: number;
}
export interface ApprovalRequestDetail {
  request: ApprovalRequest;
  rounds: ApprovalRequest[];
}
