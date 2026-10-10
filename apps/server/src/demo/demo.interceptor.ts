import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type { AuthUser } from '../auth/auth.decorators';
import { demoConfig } from './demo.config';
import { demoDenyReason } from './demo.rules';

/**
 * 演示模式的封禁在拦截器里做而不是守卫里：拦截器排在所有守卫之后，
 * 此时 AuthGuard 已经把当前用户挂到请求上，才分得清是不是引导管理员。
 */
@Injectable()
export class DemoInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const cfg = demoConfig();
    if (!cfg.enabled || context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest & { authUser?: AuthUser }>();
    if (request.authUser?.email === cfg.bootstrapAdminEmail) return next.handle();

    const reason = demoDenyReason(
      { method: request.method, path: request.url.split('?')[0], body: request.body },
      cfg.mcpUpstreamAllow,
    );
    if (reason) {
      throw new ForbiddenException({ error: 'DEMO_DISABLED', message: `演示环境不开放：${reason}` });
    }
    return next.handle();
  }
}
