/** 执行 drizzle 迁移（drizzle/ 目录下的 SQL）+ 幂等的数据订正。用法: pnpm db:migrate */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as path from 'node:path';
import { loadConfig } from '../config';
import { repairSkillDescriptions } from './repair-descriptions';

async function main() {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, '../../drizzle'),
  });
  // 旧版 CLI 推坏的 skill 描述（`>-` 之类）按 SKILL.md 正文重新解析回来，见 repair-descriptions.ts
  const repaired = await repairSkillDescriptions(db);
  for (const r of repaired) {
    console.log(`已订正 skill 描述: ${r.slug}（原「${r.before}」→「${r.after.slice(0, 40)}${r.after.length > 40 ? '…' : ''}」）`);
  }
  await pool.end();
  console.log('迁移完成');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
