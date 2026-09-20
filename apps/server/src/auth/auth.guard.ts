import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuthUser, IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AuthService } from './auth.service';

/** 全局 Bearer Token 鉴权 + 角色检查（Token 解析逻辑在 AuthService.authenticate，与 HTTP MCP 端点共用） */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { authUser?: AuthUser }>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: '缺少访问令牌，请先登录' });
    }

    const user = await this.auth.authenticate(token);
    if (!user) {
      throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: '令牌无效或已过期，请重新登录' });
    }
    request.authUser = user;

    const roles = this.reflector.getAllAndOverride<Array<'admin' | 'member'>>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '需要管理员权限' });
    }
    return true;
  }
}
