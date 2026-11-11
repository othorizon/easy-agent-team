import { Global, Module, OnApplicationShutdown, Inject, Logger } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => {
        const pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
        const logger = new Logger('PgPool');
        // pg 会移除断开的空闲连接；必须监听 error，否则短暂断连会让整个进程退出。
        pool.on('error', (error: Error) => {
          logger.warn(`PostgreSQL 空闲连接异常，已移除失效连接：${error.message}`);
        });
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
