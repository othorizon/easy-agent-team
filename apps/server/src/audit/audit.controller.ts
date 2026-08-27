import { Controller, Get, Inject, Query } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { Roles } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { auditLogs } from '../db/schema';

@Controller('api/audit')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** 审计日志查询（仅管理员）。P0 提供最近记录 + 按 action 过滤 */
  @Get()
  @Roles('admin')
  async list(@Query('action') action?: string, @Query('limit') limit?: string) {
    const size = Math.min(Number(limit ?? 100) || 100, 500);
    const where = action ? eq(auditLogs.action, action) : undefined;
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(size);
    return rows;
  }
}
