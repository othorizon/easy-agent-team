import { Body, Controller, Delete, Get, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { mcpGatewayCallQuerySchema, type McpGatewayCallQuery } from '@eat/shared';
import { CurrentUser, Public, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { loadConfig } from '../config';
import { McpSubscriptionsService } from '../mcp-configs/mcp-subscriptions.service';
import { McpGatewayService, type GatewayIdentity } from './mcp-gateway.service';
import { filterRequestHeaders, filterResponseHeaders, requestUpstream, UpstreamRejected } from './upstream';

interface CallShape {
  method: string | null;
  toolName: string | null;
}

/**
 * 转发失败时的**技术原因**，只进调用记录与服务端日志，不回给调用方（照决策 33）。
 *
 * 回给客户端的那句「这个服务暂时连不上」对排查毫无帮助：一次 502 背后可能是 DNS 解析不了、
 * 连接被中途重置、TLS 握手失败……而这些差别恰恰决定了该去查谁。原先这些细节被整句丢掉，
 * 留在记录里的只有那句安慰话，等于每次都要靠猜。
 */
function describeCause(err: unknown): string {
  if (err instanceof UpstreamRejected) return err.message;
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'ERROR';
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return `${code}: ${message}`.slice(0, 500);
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
function looksLikeLegacyEndpointEvent(chunk: Buffer): boolean {
  const head = chunk.subarray(0, 2048).toString('utf8');
  return /(^|\n)event:\s*endpoint\s*\r?\n/.test(head);
}

/** 取响应体的第一块后就地暂停，剩下的留给后面的 pipeline；流直接结束时返回 undefined */
function readFirstChunk(res: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('data', onData);
      res.off('end', onEnd);
      res.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      res.pause();
      cleanup();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('error', onError);
  });
}

@Controller()
export class McpGatewayController {
  private readonly logger = new Logger(McpGatewayController.name);

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

    // detail 是给运维看的技术原因（调用记录 + 服务端日志），message 是给调用方看的那句话
    const fail = async (status: number, code: string, message: string, detail?: string) => {
      await this.gateway.recordCall({
        tokenId: identity?.tokenId ?? null,
        userId: identity?.user.id ?? null,
        configId: identity?.config.id ?? null,
        method: shape.method,
        toolName: shape.toolName,
        status: 0,
        durationMs: Date.now() - startedAt,
        error: detail ?? message,
      });
      // 容器日志里也留一条：出问题时多半先看的是这里（上游地址与凭证一个字都不打）
      this.logger.warn(
        `网关转发失败 ${code} slug=${slug} method=${shape.method ?? '-'} tool=${shape.toolName ?? '-'} ` +
          `耗时=${Date.now() - startedAt}ms 原因=${detail ?? message}`,
      );
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
      await fail(502, 'MCP_GATEWAY_UPSTREAM_UNAVAILABLE', message, describeCause(err));
      return;
    }

    const timeoutMs = loadConfig().mcpGatewayUpstreamTimeoutMs;
    const controller = new AbortController();
    let clientGone = false;
    let timedOut = false;

    /**
     * 客户端还在不在，**只能看响应侧**：Node 16 起 `IncomingMessage` 的 `close`
     * 在请求体读完时就触发、并把流标记成 destroyed，跟「客户端断开」根本是两回事
     * （POST 走到这个方法时 `req.raw.destroyed` 早已是 true）。拿它当断开判据，
     * 结果是任何一次上游超时都会被当成「客户端自己走了」而静默收场。
     * 响应没写完就 close 的，才是真断开。
     */
    const onClientGone = () => {
      if (reply.raw.writableFinished) return;
      clientGone = true;
      controller.abort();
    };
    reply.raw.on('close', onClientGone);
    // 客户端断在流中途时，在途的那次 write 会在已销毁的流上报错；没人听 'error' 会直接掀掉进程
    reply.raw.on('error', () => undefined);

    // 只管到「拿到响应头」为止：之后的流式传输不设限（SSE 本来就是长连接）
    const headerTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const upstream = await requestUpstream(target.url, {
        method: httpMethod,
        headers: {
          ...filterRequestHeaders(req.headers as Record<string, string | string[] | undefined>),
          ...target.headers,
        },
        body: httpMethod === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
      clearTimeout(headerTimer);
      const status = upstream.statusCode ?? 502;

      if (status >= 300 && status < 400) {
        // 3xx 交回客户端就等于把上游真实地址交出去了
        upstream.destroy();
        await fail(
          502,
          'MCP_GATEWAY_UPSTREAM_UNAVAILABLE',
          '这个服务的地址配置有误，请联系配置负责人',
          `上游回了 ${status} 跳转（平台不跟随跳转，以免把上游地址交出去）`,
        );
        return;
      }

      let firstChunk: Buffer | undefined;
      if ((upstream.headers['content-type'] ?? '').includes('text/event-stream')) {
        // 先看一眼第一块再决定要不要落响应头，避免旧传输下吐出半截流
        firstChunk = await readFirstChunk(upstream);
        if (firstChunk && looksLikeLegacyEndpointEvent(firstChunk)) {
          upstream.destroy();
          await fail(
            502,
            'MCP_GATEWAY_UPSTREAM_UNSUPPORTED',
            '这个服务用的是已弃用的 SSE 传输方式，平台暂不支持代理，请联系配置负责人改用 Streamable HTTP',
          );
          return;
        }
      }

      await this.gateway.recordCall({
        tokenId: identity.tokenId,
        userId: identity.user.id,
        configId: identity.config.id,
        method: shape.method,
        toolName: shape.toolName,
        status,
        durationMs: Date.now() - startedAt,
      });

      // 从这里起接管原始响应：SSE 必须逐块吐出去，不能让框架缓冲或序列化
      reply.hijack();
      reply.raw.writeHead(status, filterResponseHeaders(upstream.headers));
      if (typeof reply.raw.flushHeaders === 'function') reply.raw.flushHeaders();
      if (firstChunk) reply.raw.write(firstChunk);

      try {
        // pipeline 管背压、收尾与两端的错误传播；客户端中途断开在这里表现为 reject
        await pipeline(upstream, reply.raw);
      } catch {
        // 响应头早就发出去了，没有「改回一个错误码」这个选项，只能就地掐断让客户端看到截断
        if (!reply.raw.writableEnded) reply.raw.destroy();
      }
    } catch (err) {
      clearTimeout(headerTimer);
      // 客户端自己断开不算故障
      if (clientGone) {
        if (!reply.raw.writableEnded) reply.raw.end();
        return;
      }
      if (timedOut) {
        await fail(
          504,
          'MCP_GATEWAY_UPSTREAM_TIMEOUT',
          `这个服务超过 ${Math.round(timeoutMs / 1000)} 秒没有响应，请稍后重试或联系配置负责人`,
          `等上游响应头超过 ${timeoutMs}ms（可用 EAT_MCP_GATEWAY_UPSTREAM_TIMEOUT_MS 调整）`,
        );
        return;
      }
      const message =
        err instanceof UpstreamRejected ? err.message : '这个服务暂时连不上，请稍后重试或联系配置负责人';
      await fail(502, 'MCP_GATEWAY_UPSTREAM_UNAVAILABLE', message, describeCause(err));
    } finally {
      clearTimeout(headerTimer);
      reply.raw.off('close', onClientGone);
    }
  }
}
