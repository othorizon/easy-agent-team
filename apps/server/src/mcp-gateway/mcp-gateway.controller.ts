import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mcpGatewayCallQuerySchema, type McpGatewayCallQuery } from '@eat/shared';
import { CurrentUser, Public, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { McpSubscriptionsService } from '../mcp-configs/mcp-subscriptions.service';
import { McpGatewayService, type GatewayIdentity } from './mcp-gateway.service';
import { filterRequestHeaders, filterResponseHeaders, UpstreamRejected } from './upstream';

/** 拿到上游响应头之前的等待上限；之后的流式传输不设限（SSE 本来就是长连接） */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000;

interface CallShape {
  method: string | null;
  toolName: string | null;
}

/** 从 JSON-RPC 请求体里取要记的那两个字段。**不碰 params 的其余部分**（业务数据 / 可能含密钥） */
function describeCall(httpMethod: string, body: unknown): CallShape {
  if (httpMethod !== 'POST') return { method: `http/${httpMethod.toLowerCase()}`, toolName: null };
  const first = (Array.isArray(body) ? body[0] : body) as { method?: unknown; params?: { name?: unknown } } | null;
  const method = typeof first?.method === 'string' ? first.method : null;
  const toolName =
    method === 'tools/call' && typeof first?.params?.name === 'string' ? first.params.name : null;
  return { method, toolName };
}

/**
 * 旧版 HTTP+SSE 传输（2024-11-05）的识别标志：上游会先发一个 `endpoint` 事件，
 * 里面是客户端接下来该 POST 的地址。那个地址属于上游，原样透传等于把要藏的东西直接漏回去；
 * 要正确代理它得把地址重写并再开一条路由。这里选择**明确报错而不是半代理**——
 * 泄漏上游地址比不支持旧传输严重得多。
 */
function looksLikeLegacyEndpointEvent(chunk: Uint8Array): boolean {
  const head = Buffer.from(chunk.subarray(0, 2048)).toString('utf8');
  return /(^|\n)event:\s*endpoint\s*\r?\n/.test(head);
}

@Controller()
export class McpGatewayController {
  constructor(
    private readonly gateway: McpGatewayService,
    private readonly subs: McpSubscriptionsService,
  ) {}

  // ---------- 管理面（正常登录鉴权） ----------

  /** 网关调用记录：管理员全部，其他人自己 Own 的配置 */
  @Get('api/mcp-gateway/calls')
  calls(
    @Query(new ZodValidationPipe(mcpGatewayCallQuerySchema)) query: McpGatewayCallQuery,
    @CurrentUser() user: AuthUser,
  ) {
    return this.gateway.calls(user, query);
  }

  /** 重新生成自己的专属接入地址（怀疑泄漏时用）；旧地址立即作废 */
  @Post('api/mcp-configs/:slug/gateway-url/regenerate')
  async regenerate(@Param('slug') slug: string, @CurrentUser() user: AuthUser) {
    const url = await this.gateway.regenerate(user, slug, (configId) => this.subs.isEffective(user.id, configId));
    return { slug, url };
  }

  // ---------- 数据面（鉴权在 URL 路径里） ----------

  @Public()
  @Post('mcp/:slug/:token')
  postMessage(
    @Param('slug') slug: string,
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.proxy('POST', slug, token, body, req, reply);
  }

  /** 服务端 → 客户端的通知流（Streamable HTTP 的 GET SSE） */
  @Public()
  @Get('mcp/:slug/:token')
  openStream(
    @Param('slug') slug: string,
    @Param('token') token: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.proxy('GET', slug, token, undefined, req, reply);
  }

  /** 结束会话 */
  @Public()
  @Delete('mcp/:slug/:token')
  endSession(
    @Param('slug') slug: string,
    @Param('token') token: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.proxy('DELETE', slug, token, undefined, req, reply);
  }

  private async proxy(
    httpMethod: 'POST' | 'GET' | 'DELETE',
    slug: string,
    token: string,
    body: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const startedAt = Date.now();
    const shape = describeCall(httpMethod, body);
    let identity: GatewayIdentity | null = null;

    const fail = async (status: number, code: string, message: string) => {
      await this.gateway.recordCall({
        tokenId: identity?.tokenId ?? null,
        userId: identity?.user.id ?? null,
        configId: identity?.config.id ?? null,
        method: shape.method,
        toolName: shape.toolName,
        status: 0,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      if (reply.sent || reply.raw.headersSent) {
        reply.raw.end();
        return;
      }
      await reply.code(status).header('content-type', 'application/json; charset=utf-8').send({ error: code, message });
    };

    identity = await this.gateway.resolve(slug, token, (userId, configId) => this.subs.isEffective(userId, configId));
    if (!identity) {
      // 「无效」与「已失效」故意不分开说：区分开等于给枚举者一个预言机
      await fail(403, 'MCP_GATEWAY_URL_INVALID', '这个接入地址无效或已失效，请在平台上重新获取');
      return;
    }

    let target;
    try {
      target = await this.gateway.resolveUpstream(identity.config);
    } catch (err) {
      const message = err instanceof UpstreamRejected ? err.message : '这个服务暂时不可用，请联系配置负责人';
      await fail(502, 'MCP_GATEWAY_UPSTREAM_UNAVAILABLE', message);
      return;
    }

    const controller = new AbortController();
    // 客户端断开时别让上游连接挂着（SSE 下这尤其重要）
    const onClose = () => controller.abort();
    req.raw.on('close', onClose);
    const headerTimer = setTimeout(() => controller.abort(), UPSTREAM_HEADER_TIMEOUT_MS);

    try {
      const upstream = await fetch(target.url, {
        method: httpMethod,
        headers: {
          ...filterRequestHeaders(req.headers as Record<string, string | string[] | undefined>),
          ...target.headers,
        },
        body: httpMethod === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        // 不跟随重定向：3xx 交回客户端就等于把上游真实地址交出去了
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(headerTimer);

      if (upstream.status >= 300 && upstream.status < 400) {
        await fail(502, 'MCP_GATEWAY_UPSTREAM_UNAVAILABLE', '这个服务的地址配置有误，请联系配置负责人');
        return;
      }

      const reader = upstream.body?.getReader();
      let firstChunk: Uint8Array | undefined;
      if (reader && (upstream.headers.get('content-type') ?? '').includes('text/event-stream')) {
        // 先看一眼第一块再决定要不要落响应头，避免旧传输下吐出半截流
        const first = await reader.read();
        if (!first.done && first.value) {
          if (looksLikeLegacyEndpointEvent(first.value)) {
            controller.abort();
            await fail(
              502,
              'MCP_GATEWAY_UPSTREAM_UNSUPPORTED',
              '这个服务用的是已弃用的 SSE 传输方式，平台暂不支持代理，请联系配置负责人改用 Streamable HTTP',
            );
            return;
          }
          firstChunk = first.value;
        }
      }

      await this.gateway.recordCall({
        tokenId: identity.tokenId,
        userId: identity.user.id,
        configId: identity.config.id,
        method: shape.method,
        toolName: shape.toolName,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      });

      // 从这里起接管原始响应：SSE 必须逐块吐出去，不能让框架缓冲或序列化
      reply.hijack();
      reply.raw.writeHead(upstream.status, filterResponseHeaders(upstream.headers));
      if (typeof reply.raw.flushHeaders === 'function') reply.raw.flushHeaders();

      if (!reader) {
        reply.raw.end();
        return;
      }
      if (firstChunk) reply.raw.write(Buffer.from(firstChunk));
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) reply.raw.write(Buffer.from(value));
      }
      reply.raw.end();
    } catch (err) {
      clearTimeout(headerTimer);
      // 客户端自己断开不算故障
      if (controller.signal.aborted && req.raw.destroyed) {
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }
      const message =
        err instanceof UpstreamRejected ? err.message : '这个服务暂时连不上，请稍后重试或联系配置负责人';
      await fail(502, 'MCP_GATEWAY_UPSTREAM_UNAVAILABLE', message);
    } finally {
      clearTimeout(headerTimer);
      req.raw.off('close', onClose);
    }
  }
}
