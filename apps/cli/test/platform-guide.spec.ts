import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFrontmatter, platformGuideSyncSkill, syncSkillSchema } from '@eat/shared';

describe('内置平台指南的按需加载结构', () => {
  it('入口只做导航；每个主题链接都能在真实分发文件中找到', () => {
    const guide = syncSkillSchema.parse(platformGuideSyncSkill());
    const meta = parseSkillFrontmatter(guide.content);
    expect(meta.name).toBe(guide.slug);
    expect(meta.description).toBe(guide.description);
    const links = [...guide.content.matchAll(/\[[^\]]+\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
    expect(new Set(links).size).toBe(links.length);
    expect(links.length).toBeGreaterThan(1);
    expect([...links].sort()).toEqual(
      guide.files
        .filter((f) => f.path.startsWith('references/'))
        .map((f) => f.path)
        .sort(),
    );
    const totalBytes =
      Buffer.byteLength(guide.content) + guide.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    expect(Buffer.byteLength(guide.content)).toBeLessThan(totalBytes / 4);
    expect(guide.content.split('\n').length).toBeLessThan(80);
    for (const file of [{ path: 'SKILL.md', content: guide.content }, ...guide.files]) {
      expect(file.content).toBe(
        readFileSync(resolve('../../packages/shared/src/eat-platform-guide', file.path), 'utf8'),
      );
      for (const [, href] of file.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (/^https?:\/\//.test(href)) continue;
        const linked = posix.normalize(posix.join(posix.dirname(file.path), href));
        expect(['SKILL.md', ...guide.files.map((f) => f.path)]).toContain(linked);
      }
    }
  });

  it('按任务保留模型调用、授权、发布和更新的关键流程', () => {
    const guide = platformGuideSyncSkill();
    const ref = (path: string) => guide.files.find((f) => f.path === `references/${path}.md`)!.content;
    expect(guide.content).not.toContain('https://docs.newapi.pro/zh/docs/api');
    expect(ref('llm-api')).toContain('https://docs.newapi.pro/zh/docs/api');
    expect(ref('llm-api')).toContain('eat llm key export --out');
    expect(ref('llm-api')).toContain('apiBaseUrl');
    expect(ref('environment')).toContain('request_access');
    expect(ref('databases')).toContain('eat db list');
    expect(ref('applications')).toContain('DEPLOY_NOT_APPROVED');
    expect(ref('folio')).toContain('用户已经选择');
    expect(ref('folio')).toContain('取得用户明确的删除指令');
    expect(ref('updates')).toContain('用户已经明确要求更新');
    expect(ref('updates')).toContain('仅授权 CLI 更新不代表同意同步 Skill');
    expect(ref('access')).toContain('eat login --no-wait');
    expect(ref('access')).toContain('eat login --status');
    expect(guide.files.find((f) => f.path === 'agents/openai.yaml')!.content).toContain(
      '$eat-platform-guide',
    );
  });
});
