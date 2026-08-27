import { Body, ConflictException, Controller, Get, Inject, Post } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { asc, eq } from 'drizzle-orm';
import { createUserRequestSchema, type CreateUserRequest } from '@eat/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DB, type Db } from '../db/db.module';
import { users } from '../db/schema';

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
}
