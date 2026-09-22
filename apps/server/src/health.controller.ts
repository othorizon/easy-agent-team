import { Controller, Get, Inject } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { Public } from './auth/auth.decorators';
import { DB, type Db } from './db/db.module';

/** 健康检查（Dokploy/负载均衡用）：验证进程与数据库连接 */
@Controller('api/health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly adapterHost: HttpAdapterHost,
  ) {}

  /**
   * 生效中的空闲连接保活时长（决策 61）。
   *
   * 为什么要从接口回出来：`Keep-Alive` 是 hop-by-hop 响应头，**HTTP/2 里根本不允许存在**，
   * 中间的反代也会照规范把它摘掉——所以从外面 `curl -i` 是看不到这个值的，而它一旦小于
   * 前置代理回收空闲连接的时间，就是一串「间歇 502 且平台侧查不到任何记录」。
   * 取的是**运行中 HTTP server 的实际值**而不是配置读数：要验证的是「配了有没有生效」。
   */
  private keepAliveTimeoutMs(): number | null {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as { keepAliveTimeout?: unknown } | undefined;
    return typeof server?.keepAliveTimeout === 'number' ? server.keepAliveTimeout : null;
  }

  @Public()
  @Get()
  async health() {
    await this.db.execute(sql`select 1`);
    return { ok: true, keepAliveTimeoutMs: this.keepAliveTimeoutMs() };
  }
}
