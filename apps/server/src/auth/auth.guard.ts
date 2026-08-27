import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { sha256Hex } from '../common/crypto';
import { DB, type Db } from '../db/db.module';
import { apiTokens, users } from '../db/schema';
import { AuthUser, IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';

/** 全局 Bearer Token 鉴权 + 角色检查 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
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

    const now = new Date();
    const rows = await this.db
      .select({
        tokenId: apiTokens.id,
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(apiTokens)
      .innerJoin(users, eq(apiTokens.userId, users.id))
      .where(
        and(
          eq(apiTokens.tokenHash, sha256Hex(token)),
          isNull(apiTokens.revokedAt),
          or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new UnauthorizedException({ error: 'UNAUTHORIZED', message: '令牌无效或已过期，请重新登录' });
    }

    request.authUser = {
      id: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      tokenId: row.tokenId,
    };

    // 记录 Token 最近使用时间（不阻塞请求）
    void this.db
      .update(apiTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiTokens.id, row.tokenId))
      .catch(() => undefined);

    const roles = this.reflector.getAllAndOverride<Array<'admin' | 'member'>>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && roles.length > 0 && !roles.includes(row.role)) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: '需要管理员权限' });
    }
    return true;
  }
}
