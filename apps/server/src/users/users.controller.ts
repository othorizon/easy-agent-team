import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  createUserRequestSchema,
  resetUserPasswordRequestSchema,
  updateUserRequestSchema,
  type CreateUserRequest,
  type ResetUserPasswordRequest,
  type UpdateUserRequest,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { apiTokens, users } from '../db/schema';

@Controller('api/users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** 用户列表（登录即可见——授权、求助都需要选人） */
  @Get()
  list() {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status })
      .from(users)
      .orderBy(asc(users.createdAt));
  }

  /** 创建用户（仅管理员） */
  @Post()
  @Roles('admin')
  async create(
    @Body(new ZodValidationPipe(createUserRequestSchema)) body: CreateUserRequest,
    @CurrentUser() actor: AuthUser,
  ) {
    const exists = await this.db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (exists.length > 0) {
      throw new ConflictException({ error: 'CONFLICT', message: '该邮箱已存在' });
    }
    const [row] = await this.db
      .insert(users)
      .values({
        name: body.name,
        email: body.email,
        role: body.role,
        passwordHash: await bcrypt.hash(body.password, 10),
      })
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
    await this.audit.record({ actorId: actor.id, action: 'user.created', targetType: 'user', targetId: row.id });
    return row;
  }

  /** 修改角色/启用禁用（仅管理员；禁止操作自己）。禁用时吊销该用户全部 Token */
  @Patch(':id')
  @Roles('admin')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: AuthUser,
  ) {
    if (id === actor.id) {
      throw new BadRequestException({ error: 'BAD_REQUEST', message: '不能修改自己的角色或状态' });
    }
    const [row] = await this.db
      .update(users)
      .set({ ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status });
    if (!row) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    }
    if (body.status === 'disabled') {
      await this.revokeTokens(id);
    }
    await this.audit.record({
      actorId: actor.id,
      action: 'user.updated',
      targetType: 'user',
      targetId: id,
      meta: { role: body.role, status: body.status },
    });
    return row;
  }

  /** 重置密码（仅管理员）。吊销该用户全部 Token，强制重新登录 */
  @Post(':id/password')
  @Roles('admin')
  async resetPassword(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(resetUserPasswordRequestSchema)) body: ResetUserPasswordRequest,
    @CurrentUser() actor: AuthUser,
  ) {
    const [row] = await this.db
      .update(users)
      .set({ passwordHash: await bcrypt.hash(body.password, 10) })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!row) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    }
    await this.revokeTokens(id);
    await this.audit.record({ actorId: actor.id, action: 'user.password_reset', targetType: 'user', targetId: id });
    return { ok: true };
  }

  private async revokeTokens(userId: string): Promise<void> {
    await this.db
      .update(apiTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  }
}
