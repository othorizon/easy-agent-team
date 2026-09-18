import type { FastifyInstance } from 'fastify';

/**
 * 让 `content-type: application/json` 且 **body 为空** 的请求也能进到路由里。
 *
 * Fastify 默认会对这种请求直接回 400 `Body cannot be empty...`，请求根本到不了 handler。
 * 这在 MCP 网关上是硬伤：客户端结束会话发的是 `DELETE <接入地址>`，
 * 多数 HTTP 客户端会顺手带上 `content-type: application/json` 而没有 body，
 * 于是「关会话」永远失败——而且是以一个跟平台完全无关的报错形式失败。
 *
 * 只放宽「空 body」这一种情况：body 非空时仍按 JSON 解析，解析失败照旧 400。
 * 放行后 body 是 undefined，交由各路由的 zod schema 去判该不该必填
 * （订阅接口本来就用 `z.preprocess` 兜过 undefined，口径一致）。
 */
export function registerTolerantJsonParser(fastify: FastifyInstance): void {
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    if (raw.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch {
      const err = new Error('请求体不是合法的 JSON') as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}
