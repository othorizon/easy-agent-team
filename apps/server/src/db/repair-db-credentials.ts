/**
 * 数据搬迁（幂等，决策 91）：把旧版本生成的「数据库凭证环境」里的密码搬回分配记录，再把环境撤掉。
 *
 * 决策 39 及以前，批准数据库申请时会生成一个环境（DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD），
 * 凭证的读取、授权、审计全走环境变量。决策 91 起凭证只存在 `db_assignment.password_encrypted`、只在数据库页取，
 * 线上已有的那些环境得搬过来——**每次启动（entrypoint 的迁移步骤）扫一遍还挂着 environment_id 的分配**：
 *
 * - 密码按原样搬：敏感变量的密文是同一个 KEK 的信封加密，直接拷；被 Owner 改成非敏感的就地加密。
 *   以环境里的**当前值**为准（Owner 可能改过），而不是批准时生成的那个。主机 / 端口 / 库名 / 账号不搬：
 *   它们分别取实例与分配记录，那才是平台真正建出来的东西。
 * - 环境里只有生成的那五个变量 → 整个环境删掉（变量、读值授权、权限申请随外键级联，角色模板里的引用一并清掉）。
 * - 有人往里加过别的变量 → 环境保留，只删生成的五个，备注里补一句凭证去哪了——不能为了搬凭证把别人的数据删了。
 * - 环境里的 DB_PASSWORD 已被删掉 → 平台上本就没有这个密码了，照样断开关联，分配显示「无可用凭证」。
 *
 * 每搬一条落一条审计，旧环境的 slug 记在里面，事后能对上「这个环境去哪了」。
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { encryptSecret } from '../common/crypto';
import { auditLogs, dbAssignments, environments, envVariables, templateItems } from './schema';

/** 旧版本批准时生成进环境的变量 */
const GENERATED_KEYS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

export interface MovedDbCredentials {
  dbName: string;
  /** 原凭证环境的 slug */
  environment: string;
  /** 环境里另有别人加的变量，环境保留了下来（只删了生成的那几个） */
  keptKeys: string[];
  /** 环境里已经没有 DB_PASSWORD，平台上没有这个账号的密码了 */
  passwordMissing: boolean;
}

/** db 既可能是 migrate 脚本里不带 schema 的裸实例，也可能是带 schema 的 Db，故取泛型 */
export async function moveDbCredentialsOutOfEnvs<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
): Promise<MovedDbCredentials[]> {
  const pending = await db
    .select({ id: dbAssignments.id })
    .from(dbAssignments)
    .where(isNotNull(dbAssignments.environmentId));
  const moved: MovedDbCredentials[] = [];
  for (const { id } of pending) {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(dbAssignments).where(eq(dbAssignments.id, id)).for('update');
      if (!row?.environmentId) return null;
      const [env] = await tx.select().from(environments).where(eq(environments.id, row.environmentId));
      // 外键是 set null，环境不在了列也该是空的；真碰上就当没有凭证处理
      const vars = env ? await tx.select().from(envVariables).where(eq(envVariables.environmentId, env.id)) : [];
      const pw = vars.find((v) => v.key === 'DB_PASSWORD');
      const fromEnv = !pw
        ? null
        : pw.secret
          ? pw.valueEncrypted
          : pw.valuePlain !== null
            ? encryptSecret(pw.valuePlain)
            : null;
      const password = row.passwordEncrypted ?? fromEnv;
      const kept = vars.filter((v) => !GENERATED_KEYS.includes(v.key)).map((v) => v.key).sort();

      if (env && kept.length === 0) {
        await tx
          .delete(templateItems)
          .where(and(eq(templateItems.itemType, 'environment'), eq(templateItems.itemId, env.id)));
        await tx.delete(environments).where(eq(environments.id, env.id));
      } else if (env) {
        await tx
          .delete(envVariables)
          .where(and(eq(envVariables.environmentId, env.id), inArray(envVariables.key, GENERATED_KEYS)));
        await tx
          .update(environments)
          .set({
            description: `${env.description}\n\n数据库 ${row.dbName} 的连接凭证已移到数据库页（eat db credentials pull ${row.dbName}），这里只保留后来加进来的变量。`.trim(),
          })
          .where(eq(environments.id, env.id));
      }
      await tx
        .update(dbAssignments)
        .set({ environmentId: null, passwordEncrypted: password })
        .where(eq(dbAssignments.id, id));
      const entry: MovedDbCredentials = {
        dbName: row.dbName,
        environment: env?.slug ?? '(已删除)',
        keptKeys: kept,
        passwordMissing: password === null,
      };
      await tx.insert(auditLogs).values({
        action: 'db_assignment.credentials_moved',
        targetType: 'db_assignment',
        targetId: id,
        meta: { ...entry, environmentDeleted: !!env && kept.length === 0 },
      });
      return entry;
    });
    if (result) moved.push(result);
  }
  return moved;
}
