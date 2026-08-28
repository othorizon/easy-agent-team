import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
};

/** 统一错误响应为 { error, message, details? }；非 /api 的 404 回退到 SPA index.html */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private indexHtml: string | null | undefined;

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // SPA 回退：控制台前端的路由都交给 index.html。
    // /install.sh 与 /install/* 是 curl 下载端点，必须回真实 404（HTML 会被存成 eat.js）；
    // 控制台安装页路由是恰好 /install，不带后缀/子路径，仍走回退。
    const isDownloadPath = request.url.startsWith('/install.sh') || request.url.startsWith('/install/');
    if (status === 404 && request.method === 'GET' && !request.url.startsWith('/api') && !isDownloadPath) {
      const html = this.loadIndexHtml();
      if (html) {
        void reply.status(200).type('text/html').send(html);
        return;
      }
    }

    let body: { error: string; message: string; details?: unknown };
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null && 'error' in res && 'message' in res) {
        body = res as typeof body;
      } else {
        body = {
          error: STATUS_TO_CODE[status] ?? 'ERROR',
          message: typeof res === 'string' ? res : ((res as { message?: string }).message ?? exception.message),
        };
      }
    } else {
      console.error('未处理异常:', exception);
      body = { error: 'INTERNAL_ERROR', message: '服务器内部错误' };
    }
    void reply.status(status).send(body);
  }

  private loadIndexHtml(): string | null {
    if (this.indexHtml !== undefined) return this.indexHtml;
    const candidate = path.resolve(__dirname, '../../../web/dist/index.html');
    this.indexHtml = fs.existsSync(candidate) ? fs.readFileSync(candidate, 'utf8') : null;
    return this.indexHtml;
  }
}
