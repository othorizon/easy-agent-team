import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, gt } from 'drizzle-orm';
import { Roles } from '../auth/auth.decorators';
import { DB, type Db } from '../db/db.module';
import { auditLogs } from '../db/schema';

@Controller('api/audit')
export class AuditController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * 审计日志查询（仅管理员）。最近记录 + 按 action 过滤；
   * `since`（ISO 时间）只取这之后的记录，给轮询式的事件流用——不带它每轮都得把最近 N 条重拉一遍再去重。
   */
  @Get()
  @Roles('admin')
  async list(
    @Query('action') action?: string,
    @Query('limit') limit?: string,
    @Query('since') since?: string,
  ) {
    const size = Math.min(Number(limit ?? 100) || 100, 500);
    const sinceDate = since ? new Date(since) : null;
    const where = and(
      action ? eq(auditLogs.action, action) : undefined,
      sinceDate && !Number.isNaN(sinceDate.getTime()) ? gt(auditLogs.createdAt, sinceDate) : undefined,
    );
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(size);
    return rows;
  }
}
