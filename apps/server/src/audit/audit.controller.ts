import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { auditLogs } from '../db/schema';

@Controller('api/audit')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 审计日志查询（仅管理员）。P0 提供最近记录 + 按 action 过滤 */
  @Get()
  @Roles('admin')
  async list(@CurrentUser() user: AuthUser, @Query('action') action?: string, @Query('limit') limit?: string) {
    const size = Math.min(Number(limit ?? 100) || 100, 500);
    // 审计元数据也不能向其他管理员暴露私有环境的名称与变量 key。
    const privateEnvironment = sql`NOT EXISTS (
      SELECT 1 FROM environment e WHERE e.visibility = 'private' AND e.owner_id <> ${user.id}
      AND (e.id::text = ${auditLogs.targetId} OR e.slug = ${auditLogs.meta}->>'environment'
        OR EXISTS (SELECT 1 FROM env_variable v WHERE v.environment_id = e.id AND v.id::text = ${auditLogs.targetId}))
    )`;
    const where = and(action ? eq(auditLogs.action, action) : undefined, privateEnvironment);
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(size);
    return rows;
  }
}
