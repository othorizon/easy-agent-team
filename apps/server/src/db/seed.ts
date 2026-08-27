/**
 * 种子脚本：创建初始管理员（幂等）。
 * 账号可用 EAT_ADMIN_EMAIL / EAT_ADMIN_PASSWORD 环境变量覆盖。
 * 用法: pnpm db:seed
 */
import * as bcrypt from 'bcryptjs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { loadConfig } from '../config';
import * as schema from './schema';

async function main() {
  const email = process.env.EAT_ADMIN_EMAIL ?? 'admin@example.com';
  const password = process.env.EAT_ADMIN_PASSWORD ?? 'admin12345';
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  const db = drizzle(pool, { schema });

  const exists = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (exists.length > 0) {
    console.log(`管理员 ${email} 已存在，跳过`);
  } else {
    await db.insert(schema.users).values({
      name: '管理员',
      email,
      role: 'admin',
      passwordHash: await bcrypt.hash(password, 10),
    });
    console.log(`已创建管理员 ${email}（密码来自 EAT_ADMIN_PASSWORD，默认 admin12345，请尽快修改）`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
