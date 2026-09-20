import { Body, Controller, Delete, Get, Options, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth/auth.decorators';
import type { AuthUser } from '../auth/auth.decorators';
import { AuthService } from '../auth/auth.service';
import { McpServerService } from './mcp-server.service';
import {
  jsonRpcError,
  JsonRpcErrorCode,
  LATEST_PROTOCOL_VERSION,
  toSseEvent,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from './protocol';

/** 除 Authorization: Bearer 外也认的几个「API Key 放哪」的写法——云端 AI 服务的配置界面五花八门 */
const API_KEY_HEADERS = ['x-api-key', 'x-eat-api-key', 'api-key'] as const;

/**
 * 浏览器里的 MCP 客户端（调试台、Web 版 Agent）要靠 CORS 才连得上。
 * 放 `*` 是安全的：平台的鉴权只认请求头里的 API Key，不用 Cookie，
 * 跨站页面拿不到别人的 Key，也就没有「浏览器自动带上凭证」这回事。
 */
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-api-key',
  'access-control-expose-headers': 'mcp-protocol-version',
  'access-control-max-age': '86400',
};

function extractApiKey(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  for (const name of API_KEY_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 平台自身能力的 MCP 端点（决策 55）：标准 Streamable HTTP，鉴权走请求头里的 API Key。
 *
 * 给的是**云端** AI 服务用的——它们跑在别人的机器上，装不了 CLI、也读不到本地凭证文件，
 * 此前只有 `eat mcp`（stdio）一条路，等于把这类客户端挡在门外。
 *
 * 路径 `/mcp`（与被代理的第三方配置 `/mcp/<slug>/<token>` 同一命名空间，互不冲突）。
 * 无状态：不发 `Mcp-Session-Id`，每个请求自带身份，多实例部署无需会话亲和。
 */
@Controller()
export class McpServerController {
  constructor(
    private readonly auth: AuthService,
    private readonly mcp: McpServerService,
  ) {}

  @Public()
  @Options('mcp')
  preflight(@Res() reply: FastifyReply) {
    return reply.code(204).headers(CORS_HEADERS).send();
  }

  @Public()
  @Post('mcp')
  async handle(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const user = await this.authenticate(req);
    if (!user) return this.unauthorized(reply);

    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcMessage[];
    if (messages.length === 0 || messages.some((m) => !m || typeof m !== 'object')) {
      return this.send(req, reply, jsonRpcError(null, JsonRpcErrorCode.InvalidRequest, '请求体不是合法的 JSON-RPC 消息'), 400);
    }

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const res = await this.mcp.handleMessage(user, message, req.ip);
      if (res) responses.push(res);
    }
    // 整批都是通知（如 notifications/initialized）：按规范回 202，不带 body
    if (responses.length === 0) {
      return reply.code(202).headers(CORS_HEADERS).send();
    }
    return this.send(req, reply, batch ? responses : responses[0]);
  }

  /**
   * GET 是给「服务端主动推消息」的 SSE 长连接用的。本 server 无状态、没有主动推送，
   * 按规范回 405（而不是挂一条永远不出数据的连接，那会让客户端一直等）。
   */
  @Public()
  @Get('mcp')
  stream(@Res() reply: FastifyReply) {
    return reply
      .code(405)
      .headers({ ...CORS_HEADERS, allow: 'POST, DELETE, OPTIONS' })
      .send({
        error: 'METHOD_NOT_ALLOWED',
        message: '该 MCP 端点不提供服务端推送流，请用 POST 发送 JSON-RPC 请求',
      });
  }

  /** 结束会话。无状态 server 没有会话可清，直接确认 */
  @Public()
  @Delete('mcp')
  async end(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const user = await this.authenticate(req);
    if (!user) return this.unauthorized(reply);
    return reply.code(204).headers(CORS_HEADERS).send();
  }

  private authenticate(req: FastifyRequest): Promise<AuthUser | null> {
    return this.auth.authenticate(extractApiKey(req));
  }

  private unauthorized(reply: FastifyReply) {
    return reply
      .code(401)
      .headers({
        ...CORS_HEADERS,
        // MCP 鉴权规范要求 401 带上 challenge；这里只有 API Key 一种方式，不做 OAuth 发现
        'www-authenticate': 'Bearer realm="easy-agent-team", error="invalid_token"',
      })
      .send({
        error: 'UNAUTHORIZED',
        message:
          '缺少或无效的 API Key：请在请求头里带上 Authorization: Bearer <API Key>（或 X-API-Key）。密钥在平台控制台的「安装与接入」页生成。',
      });
  }

  /**
   * 按客户端的 Accept 决定回 JSON 还是 SSE。
   * 规范允许两者任选其一；这里的取舍是「只要客户端能收 JSON 就回 JSON」——
   * 单次请求-响应用 SSE 没有收益，而有些客户端对 SSE 的处理反而更容易出岔子。
   */
  private send(req: FastifyRequest, reply: FastifyReply, payload: unknown, status = 200) {
    const accept = String(req.headers.accept ?? '');
    const acceptsJson = accept === '' || accept.includes('application/json') || accept.includes('*/*');
    const headers = { ...CORS_HEADERS, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION };
    if (acceptsJson || !accept.includes('text/event-stream')) {
      return reply.code(status).headers({ ...headers, 'content-type': 'application/json; charset=utf-8' }).send(payload);
    }
    return reply
      .code(status)
      .headers({ ...headers, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
      .send(toSseEvent(payload));
  }
}
