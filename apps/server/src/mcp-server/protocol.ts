/**
 * MCP 的 JSON-RPC 与 Streamable HTTP 协议常量 / 小工具（决策 55）。
 *
 * 这里刻意手写而不引官方 SDK 的 StreamableHTTPServerTransport：平台侧只需要一个
 * **无状态、只提供 tools 的** server，协议面就是 initialize / tools/list / tools/call 三件事；
 * 而 SDK 的传输层绑定 Node 原生 req/res（要在 Fastify 上 hijack 才能接），并且对 Accept 头
 * 的校验极严（不带 `text/event-stream` 直接 406）——真实世界里不少云端 AI 服务只发
 * `Accept: application/json`。自己实现才能做到「发出去的严格守规范、收进来的尽量宽容」。
 */

export const JSONRPC_VERSION = '2.0';

/** 从新到旧：initialize 时若客户端报的版本在列就原样回，否则回最新的让它自己决定 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** JSON-RPC 2.0 标准错误码 */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** 通知（没有 id）不回响应，只回 202 */
export function isNotification(msg: JsonRpcMessage): boolean {
  return msg.id === undefined || msg.id === null;
}

/** 单条 JSON-RPC 响应包成一个 SSE 事件；发完即结束流（无状态 server 没有后续消息要推） */
export function toSseEvent(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}
