import { HttpException, Injectable, Logger } from '@nestjs/common';
import { EAT_MCP_INSTRUCTIONS, EAT_MCP_SERVER_NAME } from '@eat/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { McpToolsService } from './mcp-tools.service';
import {
  isNotification,
  jsonRpcError,
  jsonRpcResult,
  JsonRpcErrorCode,
  negotiateProtocolVersion,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol';

/** 本 MCP server 实现自身的版本（工具集有增删时递增）。与 CLI 版本无关，云端客户端里显示的是它 */
export const EAT_MCP_SERVER_VERSION = '1.0.0';

/** 工具执行失败时回给客户端的结构化错误（与 CLI stdio MCP 同形状，AI 两边看到的一致） */
function toToolError(err: unknown): { error: string; message: string; details?: unknown } {
  if (err instanceof HttpException) {
    const res = err.getResponse();
    if (typeof res === 'object' && res !== null && 'error' in res && 'message' in res) {
      return res as { error: string; message: string; details?: unknown };
    }
    return { error: 'ERROR', message: typeof res === 'string' ? res : err.message };
  }
  return { error: 'ERROR', message: (err as Error)?.message ?? '服务器内部错误' };
}

function textContent(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/**
 * 处理单条 JSON-RPC 消息。无状态：没有 session、没有服务端主动推送，
 * 每个请求自带身份（API Key），因此多实例部署下随便打到哪台都一样。
 */
@Injectable()
export class McpServerService {
  private readonly logger = new Logger('McpServer');

  constructor(private readonly tools: McpToolsService) {}

  async handleMessage(user: AuthUser, msg: JsonRpcMessage, ip?: string): Promise<JsonRpcResponse | null> {
    const id = msg.id ?? null;
    const method = typeof msg.method === 'string' ? msg.method : '';
    if (!method) {
      return isNotification(msg) ? null : jsonRpcError(id, JsonRpcErrorCode.InvalidRequest, '缺少 method');
    }

    // 通知：客户端不等回复（initialized / cancelled / progress 等），一律静默接收
    if (isNotification(msg)) return null;

    switch (method) {
      case 'initialize': {
        const params = (msg.params ?? {}) as { protocolVersion?: unknown };
        return jsonRpcResult(id, {
          protocolVersion: negotiateProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: EAT_MCP_SERVER_NAME,
            title: 'easy-agent-team 团队 AI 能力平台',
            version: EAT_MCP_SERVER_VERSION,
          },
          instructions: EAT_MCP_INSTRUCTIONS,
        });
      }
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, { tools: this.tools.listTools() });
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof params.name !== 'string' || !params.name) {
          return jsonRpcError(id, JsonRpcErrorCode.InvalidParams, '缺少工具名 params.name');
        }
        try {
          const data = await this.tools.call(user, params.name, params.arguments, ip);
          return jsonRpcResult(id, textContent(data));
        } catch (err) {
          // 工具执行失败是「结果」不是「协议错误」：按 MCP 规范回 isError 的结果，
          // 让模型能读到 PERMISSION_REQUIRED 这类错误码并自行走申请流程
          if (!(err instanceof HttpException)) {
            this.logger.error(`工具 ${params.name} 执行异常`, err as Error);
          }
          return jsonRpcResult(id, { ...textContent(toToolError(err)), isError: true });
        }
      }
      default:
        return jsonRpcError(id, JsonRpcErrorCode.MethodNotFound, `不支持的方法: ${method}`);
    }
  }
}
