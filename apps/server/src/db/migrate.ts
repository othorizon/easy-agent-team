/** 执行 drizzle 迁移（drizzle/ 目录下的 SQL）+ 幂等的数据订正。用法: pnpm db:migrate */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as path from 'node:path';
import { loadConfig } from '../config';
import { repairSkillDescriptions } from './repair-descriptions';
import { moveDbCredentialsOutOfEnvs } from './repair-db-credentials';

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
  // 旧版本生成的数据库凭证环境：密码搬回分配记录、环境撤掉（决策 91），见 repair-db-credentials.ts
  for (const m of await moveDbCredentialsOutOfEnvs(db)) {
    const what = m.keptKeys.length > 0 ? `环境保留（另有变量 ${m.keptKeys.join(', ')}）` : '环境已删除';
    console.log(`已搬迁数据库凭证: ${m.dbName}（原环境 ${m.environment}，${what}${m.passwordMissing ? '；环境里已没有 DB_PASSWORD' : ''}）`);
  }
  await pool.end();
  console.log('迁移完成');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
