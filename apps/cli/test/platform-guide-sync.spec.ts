import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformGuideSyncSkill } from '@eat/shared';
import { Api } from '../src/client.js';
import { ensureLink, sync } from '../src/commands/sync.js';

vi.mock('../src/update.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/update.js')>()),
  loadState: vi.fn(() => ({})),
  markSkillsSynced: vi.fn(),
  recordSyncTarget: vi.fn(),
}));

describe('单文件平台指南升级为多文件 Skill', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-guide-sync-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(Api, 'fromSaved').mockReturnValue({
      request: vi.fn(async (_method: string, url: string) => {
        if (url === '/api/skills/sync-bundle') return [platformGuideSyncSkill()];
        if (url === '/api/mcp-configs/sync-bundle') return [];
        throw new Error('Unexpected API call: ' + url);
      }),
    } as unknown as Api);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('实际 sync 替换旧入口并落地全部主题，软链与 Windows 副本均能读取', async () => {
    const target = path.join(root, 'skills');
    const guide = platformGuideSyncSkill();
    const dir = path.join(target, guide.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Legacy single-file guide');
    fs.writeFileSync(
      path.join(dir, '.eat-meta.json'),
      JSON.stringify({
        managed: true,
        slug: guide.slug,
        version: 36,
        files: ['SKILL.md'],
      }),
    );
    await sync({ dir: target, save: false });
    const entries = [{ path: 'SKILL.md', content: guide.content }, ...guide.files];
    for (const file of entries) expect(fs.readFileSync(path.join(dir, file.path), 'utf8')).toBe(file.content);
    const metadata = fs.readFileSync(path.join(dir, '.eat-meta.json'), 'utf8');
    expect(JSON.parse(metadata).version).toBe(guide.version);
    expect(JSON.parse(metadata).files.sort()).toEqual(entries.map((f) => f.path).sort());
    for (const strategy of ['symlink', 'copy'] as const) {
      const link = path.join(root, strategy);
      ensureLink(link, dir, false, true, strategy);
      for (const file of entries)
        expect(fs.readFileSync(path.join(link, file.path), 'utf8')).toBe(file.content);
    }
    await sync({ dir: target, save: false });
    expect(fs.readFileSync(path.join(dir, '.eat-meta.json'), 'utf8')).toBe(metadata);
  });

  it('预演只读取分发数据，不创建入口或参考文件', async () => {
    const target = path.join(root, 'dry-run');
    await sync({ dir: target, save: false, dryRun: true });
    expect(fs.existsSync(target)).toBe(false);
  });
});
