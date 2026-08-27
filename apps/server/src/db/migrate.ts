/** 执行 drizzle 迁移（drizzle/ 目录下的 SQL）。用法: pnpm db:migrate */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as path from 'node:path';
import { loadConfig } from '../config';

async function main() {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  await migrate(drizzle(pool), {
    migrationsFolder: path.resolve(__dirname, '../../drizzle'),
  });
  await pool.end();
  console.log('迁移完成');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
