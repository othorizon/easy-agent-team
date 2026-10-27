import { GithubStore } from '../github/github.store';
import { GithubService } from '../github/github.service';
import { OssService } from '../oss/oss.service';
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
  updateBioSchema,
  updateUserProfileSchema,
  type UpdateUserProfileRequest,
  createUserRequestSchema,
  resetUserPasswordRequestSchema,
  updateUserRequestSchema,
  type CreateUserRequest,
  type ResetUserPasswordRequest,
  type UpdateUserRequest,
  type UserNotificationStatus,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { apiTokens, feishuBindings, userNotifications, users } from '../db/schema';
import { FeishuAppService } from '../notify/feishu/feishu-app.service';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';

@Controller('api/users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly llmGateway: LlmGatewayService,
    private readonly oss: OssService,
    private readonly github: GithubStore,
    private readonly githubService: GithubService,
    private readonly feishu: FeishuAppService,
  ) {}

  /** 用户列表（登录即可见——授权、求助都需要选人）。管理员额外看到每人的通知状态（决策 92） */
  @Get()
  async list(@CurrentUser() actor: AuthUser) {
    const rows = await this.db
      .select({
        id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, bio: users.bio,
        webhookUrl: userNotifications.webhookUrl, verifiedAt: userNotifications.verifiedAt,
        feishuAppId: feishuBindings.appId, feishuBoundAt: feishuBindings.boundAt,
      })
      .from(users)
      .leftJoin(userNotifications, eq(userNotifications.userId, users.id))
      .leftJoin(feishuBindings, eq(feishuBindings.userId, users.id))
      .orderBy(asc(users.createdAt));
    const feishu = actor.role === 'admin' ? await this.feishu.row() : null;
    return rows.map(({ webhookUrl, verifiedAt, feishuAppId, feishuBoundAt, ...user }) => {
      if (!feishu) return user;
      const webhookVerified = !!webhookUrl && !!verifiedAt;
      const app = !feishuAppId ? 'none' : feishuAppId === feishu.appId ? 'bound' : 'stale';
      const notification: UserNotificationStatus = {
        channel: feishu.channel,
        connected: feishu.channel === 'app' ? app === 'bound' : webhookVerified,
        webhookVerified,
        feishuApp: app,
        feishuBoundAt: app === 'bound' && feishuBoundAt ? feishuBoundAt.toISOString() : null,
      };
      return { ...user, notification };
    });
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
    const row = await this.db.transaction(async tx => {
      const [updated] = await tx
      .update(users)
      .set({ ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}) })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status });
      if (updated && body.status === 'disabled') await this.github.userChanged(tx, id);
      return updated;
    });
    if (!row) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    }
    if (body.status === 'disabled') {
      this.githubService.wake();
      await this.revokeTokens(id);
    }
    const ossSyncPending = body.status ? await this.oss.onUserStatusChanged(id) : false;
    const llmGatewaySyncPending = body.status ? await this.llmGateway.onUserStatusChanged(id, actor.id) : false;
    await this.audit.record({
      actorId: actor.id,
      action: 'user.updated',
      targetType: 'user',
      targetId: id,
      meta: { role: body.role, status: body.status },
    });
    return { ...row, llmGatewaySyncPending, ossSyncPending };
  }

  /** 管理员可修改任意用户的姓名和简介，包含本人；角色/状态保护保持独立。 */
  @Patch(':id/profile')
  @Roles('admin')
  async updateProfile(@Param('id') id: string,
    @Body(new ZodValidationPipe(updateUserProfileSchema)) body: UpdateUserProfileRequest, @CurrentUser() actor: AuthUser) {
    const [row] = await this.db.update(users).set(body).where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, bio: users.bio });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    await this.audit.record({ actorId: actor.id, action: 'user.profile_updated', targetType: 'user', targetId: id });
    return row;
  }

  /** 保留旧版简介接口。 */
  @Patch(':id/bio')
  @Roles('admin')
  async updateBio(@Param('id') id: string,
    @Body(new ZodValidationPipe(updateBioSchema)) body: { bio: string }, @CurrentUser() actor: AuthUser) {
    const [row] = await this.db.update(users).set({ bio: body.bio }).where(eq(users.id, id))
      .returning({ id: users.id, bio: users.bio });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    await this.audit.record({ actorId: actor.id, action: 'user.bio_updated', targetType: 'user', targetId: id });
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
