import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public } from './auth/auth.decorators';
import { DB, type Db } from './db/db.module';

/** 健康检查（Dokploy/负载均衡用）：验证进程与数据库连接 */
@Controller('api/health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Public()
  @Get()
  async health() {
    await this.db.execute(sql`select 1`);
    return { ok: true };
  }
}
