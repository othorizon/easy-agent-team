import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记无需登录的端点 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** 标记仅特定平台角色可访问的端点 */
export const Roles = (...roles: Array<'admin' | 'member'>) => SetMetadata(ROLES_KEY, roles);

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  tokenId: string;
}

/** 从请求中取当前登录用户（由 AuthGuard 注入） */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().authUser as AuthUser;
});
