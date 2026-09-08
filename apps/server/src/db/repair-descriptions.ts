/**
 * 数据订正（幂等）：把库里已经坏掉的 skill 描述按 SKILL.md 正文重新解析回来。
 *
 * 旧版 CLI（≤0.5.5）解析不了块标量，`description: >-` 只取到指示符本身就推了上来，
 * 网页创建时只贴正文不填描述则存了个空串。决策 36 之后新推的版本没问题，但**已经躺在库里的行
 * 不会自己变好**——描述是 AI 判断何时用这个 skill 的唯一依据，一直坏着等于这些 skill 是废的，
 * 所以每次启动（entrypoint 的迁移步骤）顺手扫一遍：只动描述为空或只是块标量指示符的行，
 * 按当前版本的 SKILL.md frontmatter 重新解析；解析不出东西就保持原样。
 */
import { isBlockScalarIndicator, parseSkillFrontmatter } from '@eat/shared';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { skills, skillVersions } from './schema';

export interface RepairedSkill {
  slug: string;
  before: string;
  after: string;
}

/** 需要订正的描述：空串，或只是个块标量指示符（`>-`、`|2+` 等） */
function isBroken(description: string): boolean {
  return description.trim() === '' || isBlockScalarIndicator(description);
}

/** db 既可能是 migrate 脚本里不带 schema 的裸实例，也可能是带 schema 的 Db，故取泛型 */
export async function repairSkillDescriptions<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
): Promise<RepairedSkill[]> {
  const rows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      description: skills.description,
      content: skillVersions.content,
    })
    .from(skills)
    .innerJoin(
      skillVersions,
      and(eq(skillVersions.skillId, skills.id), eq(skillVersions.version, skills.currentVersion)),
    );

  const repaired: RepairedSkill[] = [];
  for (const row of rows) {
    const nameBroken = isBlockScalarIndicator(row.name);
    if (!isBroken(row.description) && !nameBroken) continue;
    const fm = parseSkillFrontmatter(row.content);
    const description = isBroken(row.description) ? (fm.description?.slice(0, 2000) ?? '') : row.description;
    const name = nameBroken ? (fm.name?.slice(0, 100) ?? row.name) : row.name;
    if (description === row.description && name === row.name) continue;
    // 不动 updated_at：这是订正不是更新，别把 skill 顶到列表最前，也别让人以为内容变了
    await db.update(skills).set({ name, description }).where(eq(skills.id, row.id));
    repaired.push({ slug: row.slug, before: row.description, after: description });
  }
  return repaired;
}
