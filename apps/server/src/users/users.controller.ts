import { FeishuAppService } from '../notify/feishu/feishu-app.service';
import { GithubStore } from '../github/github.store';
import { GithubService } from '../github/github.service';
import { OssService } from '../oss/oss.service';
import { DbAccessService } from '../dbs/db-access.service';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
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
  type UpdateUserResult,
  type UserNotificationStatus,
} from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { apiTokens, users, userNotifications, githubAccounts, feishuBindings, dbPersonalRoles } from '../db/schema';
import { LlmGatewayService } from '../llm-gateway/llm-gateway.service';

@Controller('api/users')
export class UsersController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly llmGateway: LlmGatewayService,
    private readonly oss: OssService,
    private readonly dbAccess: DbAccessService,
    private readonly github: GithubStore,
    private readonly githubService: GithubService,
    private readonly feishu: FeishuAppService,
  ) {}

  /** 用户列表（登录即可见——授权、求助都需要选人） */
  @Get()
  async list(@CurrentUser() actor: AuthUser) {
    const rows = await this.db.select({
      id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, bio: users.bio,
      canNotifyAll: users.canNotifyAll,
      ...(actor.role === 'admin' ? {
        dbSyncPending: sql<boolean>`exists(select 1 from db_personal_role p where p.user_id="user".id and (p.sync_pending or p.login_enabled <> ("user".status='active')))`,
        dbSyncError: sql<string | null>`(select p.sync_error from db_personal_role p where p.user_id="user".id and p.sync_pending and p.sync_error is not null order by p.sync_retry_at limit 1)`,
      } : {}),
      webhookUrl: userNotifications.webhookUrl, verifiedAt: userNotifications.verifiedAt,
      feishuAppId: feishuBindings.appId, feishuBoundAt: feishuBindings.boundAt,
      ...(actor.role === 'admin' ? { github: { login: githubAccounts.login, orgState: githubAccounts.orgState, needsAuthorization: githubAccounts.needsAuthorization } } : {}),
    }).from(users)
      .leftJoin(userNotifications, eq(userNotifications.userId, users.id))
      .leftJoin(feishuBindings, eq(feishuBindings.userId, users.id))
      .leftJoin(githubAccounts, eq(githubAccounts.userId, users.id))
      .where(actor.role === 'admin' ? undefined : eq(users.status, 'active'))
      .orderBy(asc(users.createdAt));
    const feishu = await this.feishu.row();
    return rows.map(({ webhookUrl, verifiedAt, feishuAppId, feishuBoundAt, ...user }) => {
      const webhookVerified = !!webhookUrl && !!verifiedAt;
      const app = !feishuAppId ? 'none' : feishuAppId === feishu.appId ? 'bound' : 'stale';
      const notification: UserNotificationStatus = {
        channel: feishu.channel,
        connected: user.status === 'active' && (feishu.channel === 'app' ? app === 'bound' : webhookVerified),
        webhookVerified, feishuApp: app,
        feishuBoundAt: app === 'bound' && feishuBoundAt ? feishuBoundAt.toISOString() : null,
      };
      const { status, ...profile } = user;
      return { ...profile, notificationReady: notification.connected,
        ...(actor.role === 'admin' ? { status, notification } : {}) };
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

  /** 修改角色/启用禁用/通知权限（仅管理员；角色与状态禁止操作自己）。禁用时吊销该用户全部 Token */
  @Patch(':id')
  @Roles('admin')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(updateUserRequestSchema)) body: UpdateUserRequest,
    @CurrentUser() actor: AuthUser,
  ): Promise<UpdateUserResult> {
    if (id.toLowerCase() === actor.id.toLowerCase() && (body.role !== undefined || body.status !== undefined)) {
      throw new BadRequestException({ error: 'BAD_REQUEST', message: '不能修改自己的角色或状态' });
    }
    const row = await this.db.transaction(async tx => {
      const [updated] = await tx
      .update(users)
      .set({ ...(body.role ? { role: body.role } : {}), ...(body.status ? { status: body.status } : {}), ...(body.canNotifyAll !== undefined ? { canNotifyAll: body.canNotifyAll } : {}) })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, canNotifyAll: users.canNotifyAll });
      if (updated && body.status === 'disabled') await this.github.userChanged(tx, id);
      // 与用户状态一同持久化，钩子调用前进程退出也不会漏掉安全同步。
      if (updated && body.status) await tx.update(dbPersonalRoles).set({ syncPending: true, syncError: null, syncAttempts: 0, syncRetryAt: null }).where(eq(dbPersonalRoles.userId, id));
      return updated;
    });
    if (!row) {
      throw new NotFoundException({ error: 'NOT_FOUND', message: '用户不存在' });
    }
    if (body.status === 'disabled') {
      this.githubService.wake();
      await this.revokeTokens(id);
    }
    const dbSyncPending = body.status ? await this.dbAccess.onUserStatusChanged(id) : false;
    const ossSyncPending = body.status ? await this.oss.onUserStatusChanged(id) : false;
    const llmGatewaySyncPending = body.status ? await this.llmGateway.onUserStatusChanged(id, actor.id) : false;
    await this.audit.record({
      actorId: actor.id,
      action: 'user.updated',
      targetType: 'user',
      targetId: id,
      meta: { role: body.role, status: body.status, canNotifyAll: body.canNotifyAll },
    });
    return { ...row, llmGatewaySyncPending, ossSyncPending, dbSyncPending };
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
