import type { EatToolDef } from './mcp-tools.js';
import { z } from 'zod';
import {
  OSS_CREDENTIAL_NOTE,
  OSS_PUBLIC_READ_NOTE,
  requestOssSpaceSchema,
  updateOssSpaceSchema,
  ossPublicReadSchema,
} from './oss.js';

const space = { type: 'string', description: '空间 ID，来自 list_oss_spaces' };
export function buildOssTools(): EatToolDef[] {
  return [
    {
      name: 'get_oss_status',
      description:
        '查询 OSS 对象存储是否已启用。未启用时请联系管理员配置系统设置。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'request_oss_space',
      description:
        '申请 Bucket 中的独立存储目录，需要管理员批准。提交后告知用户等待审批，用 list_oss_spaces 查询进度，不要重复申请。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '空间名称' },
          purpose: { type: 'string', description: '用途' },
          requestId: {
            type: 'string',
            description: '可选 UUID；网络失败重试时复用相同值',
          },
        },
        required: ['name', 'purpose'],
      },
    },
    {
      name: 'list_oss_spaces',
      description:
        '列出我的 OSS 空间、审批状态、官方及自定义域名、人工 CDN 标记和 EAT 公开读设置；不含密钥。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_oss_space',
      description:
        '查看空间信息，包括路径、SDK Endpoint、全部可选地址、公开前缀和操作状态。CDN 标记由管理员填写，不代表实时检测。',
      inputSchema: {
        type: 'object',
        properties: { space },
        required: ['space'],
      },
    },
    {
      name: 'update_oss_space',
      description: '修改本人空间的名称或用途，实际存储路径保持不变。',
      inputSchema: {
        type: 'object',
        properties: {
          space,
          name: { type: 'string' },
          purpose: { type: 'string' },
        },
        required: ['space'],
      },
    },
    {
      name: 'set_oss_space_public_read',
      description: `修改整个空间的公开读设置，返回操作中状态时需查询详情确认。${OSS_PUBLIC_READ_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: { space, enabled: { type: 'boolean' } },
        required: ['space', 'enabled'],
      },
    },
    {
      name: 'get_oss_credentials',
      description: `领取本人 OSS AK/SK（敏感操作，会审计），仅用于当前任务，勿写入源码、日志或对话。${OSS_CREDENTIAL_NOTE}`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'reset_oss_credentials',
      description: `重置本人共享 OSS 凭证。${OSS_CREDENTIAL_NOTE} 只有用户明确要求重置时使用；用 get_oss_operation 查询完成后重新领取凭证。`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_oss_operation',
      description: '查询 OSS 凭证重置等后台操作的状态。',
      inputSchema: {
        type: 'object',
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
      },
    },
  ];
}
export const isOssTool = (name: string) =>
  buildOssTools().some((t) => t.name === name);

export function ossToolRequest(
  name: string,
  input: unknown,
  requestId: string,
): { method: string; path: string; body?: unknown } {
  const args = z.record(z.string(), z.unknown()).parse(input ?? {});
  const id = () => z.uuid().parse(args.space);
  switch (name) {
    case 'get_oss_status':
      return { method: 'GET', path: '/api/oss/capability' };
    case 'request_oss_space':
      return {
        method: 'POST',
        path: '/api/oss/spaces',
        body: requestOssSpaceSchema.parse({
          ...args,
          requestId: args.requestId ?? requestId,
        }),
      };
    case 'list_oss_spaces':
      return { method: 'GET', path: '/api/oss/spaces' };
    case 'get_oss_space':
      return { method: 'GET', path: `/api/oss/spaces/${id()}` };
    case 'update_oss_space':
      return {
        method: 'PATCH',
        path: `/api/oss/spaces/${id()}`,
        body: updateOssSpaceSchema.parse(args),
      };
    case 'set_oss_space_public_read':
      return {
        method: 'PUT',
        path: `/api/oss/spaces/${id()}/public-read`,
        body: ossPublicReadSchema.parse(args),
      };
    case 'get_oss_credentials':
      return { method: 'POST', path: '/api/oss/me/credentials' };
    case 'reset_oss_credentials':
      return { method: 'POST', path: '/api/oss/me/credentials/reset' };
    case 'get_oss_operation':
      return {
        method: 'GET',
        path: `/api/oss/operations/${z.uuid().parse(args.operationId)}`,
      };
    default:
      throw new Error('未知 OSS 工具');
  }
}
