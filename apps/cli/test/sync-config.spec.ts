import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfigs,
  persistSyncChoice,
  readConfigFile,
  resolveSyncRoots,
  writeConfigFile,
  type LoadedConfig,
} from '../src/sync-config.js';
import { syncTargetDrifted, wouldConflict } from '../src/commands/sync.js';

const home = '/home/tester';
const cwd = '/work/my-project';
const bare = { configs: [] as LoadedConfig[], env: {} as NodeJS.ProcessEnv, home };

function cfg(location: 'project' | 'user', sync: Record<string, unknown>): LoadedConfig {
  return {
    location,
    file: path.join(location === 'project' ? cwd : home, '.eat', 'config.json'),
    config: { sync } as LoadedConfig['config'],
  };
}

describe('resolveSyncRoots：安装范围解析（决策 14）', () => {

  it('默认落全局目录并软链 ~/.claude/skills', () => {
    expect(resolveSyncRoots({}, cwd, bare)).toEqual({
      scope: 'global',
      target: path.join(home, '.agents', 'skills'),
      linkRoot: path.join(home, '.claude', 'skills'),
      relativeLinks: false,
      source: { kind: 'default', label: '内置默认' },
    });
  });

  it('--global 与默认行为一致（来源标注不同）', () => {
    const g = resolveSyncRoots({ global: true }, cwd, bare);
    const d = resolveSyncRoots({}, cwd, bare);
    expect({ ...g, source: undefined }).toEqual({ ...d, source: undefined });
    expect(g.source.kind).toBe('flag');
  });

  it('--project 落当前项目并用相对软链', () => {
    expect(resolveSyncRoots({ project: true }, cwd, bare)).toMatchObject({
      scope: 'project',
      target: path.join(cwd, '.agents', 'skills'),
      linkRoot: path.join(cwd, '.claude', 'skills'),
      relativeLinks: true,
    });
  });

  it('--dir 直接落指定目录且不建软链（相对路径按 cwd 解析）', () => {
    expect(resolveSyncRoots({ dir: 'my-skills' }, cwd, bare)).toMatchObject({
      scope: 'dir',
      target: path.join(cwd, 'my-skills'),
      linkRoot: null,
      relativeLinks: false,
    });
  });

  it('安装范围参数互斥', () => {
    expect(() => resolveSyncRoots({ global: true, project: true }, cwd, bare)).toThrow(/不能同时使用/);
    expect(() => resolveSyncRoots({ project: true, dir: '/x' }, cwd, bare)).toThrow(/不能同时使用/);
    expect(() => resolveSyncRoots({ global: true, dir: '/x' }, cwd, bare)).toThrow(/不能同时使用/);
  });
});

describe('resolveSyncRoots：落点优先级（决策 56）', () => {
  it('配置里的 dir 让裸跑 eat sync 落到同一个地方——这是决策 56 要解决的问题本身', () => {
    const res = resolveSyncRoots({}, cwd, {
      ...bare,
      configs: [cfg('user', { scope: 'dir', dir: '/srv/agent/skills' })],
    });
    expect(res.target).toBe('/srv/agent/skills');
    expect(res.linkRoot).toBeNull();
    expect(res.source.kind).toBe('user-config');
  });

  it('项目配置优先于用户配置（选乙：project 作用域跟着目录走）', () => {
    const res = resolveSyncRoots({}, cwd, {
      ...bare,
      configs: [cfg('project', { scope: 'project' }), cfg('user', { scope: 'dir', dir: '/srv/skills' })],
    });
    expect(res.target).toBe(path.join(cwd, '.agents', 'skills'));
    expect(res.source.kind).toBe('project-config');
  });

  it('环境变量压过配置，命令行压过环境变量', () => {
    const configs = [cfg('user', { scope: 'dir', dir: '/srv/skills' })];
    const env = { EAT_SYNC_DIR: '/env/skills' } as NodeJS.ProcessEnv;
    expect(resolveSyncRoots({}, cwd, { ...bare, configs, env }).target).toBe('/env/skills');
    expect(resolveSyncRoots({ dir: '/flag/skills' }, cwd, { ...bare, configs, env }).target).toBe('/flag/skills');
  });

  it('命令行作用域整体覆盖配置，而不是按字段合并', () => {
    // 按字段合并的话，配置里的 dir 会和命令行的 --project 撞上「三者互斥」那条校验
    const res = resolveSyncRoots({ project: true }, cwd, {
      ...bare,
      configs: [cfg('user', { scope: 'dir', dir: '/srv/skills' })],
    });
    expect(res.scope).toBe('project');
    expect(res.target).toBe(path.join(cwd, '.agents', 'skills'));
  });

  it('配置里的相对 dir 按配置文件所在的根目录解析，而不是按 cwd', () => {
    const res = resolveSyncRoots({}, '/somewhere/else', {
      ...bare,
      configs: [cfg('project', { scope: 'dir', dir: 'skills' })],
    });
    expect(res.target).toBe(path.join(cwd, 'skills'));
  });

  it('配置写坏了要报得能看懂', () => {
    expect(() => resolveSyncRoots({}, cwd, { ...bare, configs: [cfg('user', { scope: 'dir' })] })).toThrow(
      /sync.scope=dir 却没有 sync.dir/,
    );
    expect(() => resolveSyncRoots({}, cwd, { ...bare, configs: [cfg('user', { scope: 'weird' })] })).toThrow(
      /无效/,
    );
    expect(() =>
      resolveSyncRoots({}, cwd, { ...bare, env: { EAT_SYNC_SCOPE: 'dir' } as NodeJS.ProcessEnv }),
    ).toThrow(/需要同时设置 EAT_SYNC_DIR/);
  });

  it('来源被如实标注出来，漂移检测与输出都靠它', () => {
    expect(resolveSyncRoots({ dir: '/x' }, cwd, bare).source.kind).toBe('flag');
    expect(
      resolveSyncRoots({}, cwd, { ...bare, env: { EAT_SYNC_DIR: '/x' } as NodeJS.ProcessEnv }).source.kind,
    ).toBe('env');
    expect(
      resolveSyncRoots({}, cwd, { ...bare, configs: [cfg('user', { scope: 'global' })] }).source.kind,
    ).toBe('user-config');
    // 配置文件存在但没写 sync，等同于没有配置——照样是「回落到内置默认」
    expect(resolveSyncRoots({}, cwd, { ...bare, configs: [cfg('user', {})] }).source.kind).toBe('default');
    expect(resolveSyncRoots({}, cwd, bare).source.kind).toBe('default');
  });
});

describe('syncTargetDrifted：落点漂移检测', () => {
  const defaultSource = { kind: 'default' as const, label: '内置默认' };
  const configSource = { kind: 'user-config' as const, label: '用户配置' };
  const projectSource = { kind: 'project-config' as const, label: '项目配置' };
  const flagSource = { kind: 'flag' as const, label: '命令行参数 --dir' };

  it('配置丢了导致裸跑回落到默认全局时拦下来——这正是要挡的那条静默链路', () => {
    expect(syncTargetDrifted('/srv/skills', '/home/x/.agents/skills', defaultSource, false)).toBe(true);
  });

  it('落点没变、没有上次记录、显式指定、已确认，四种都不拦', () => {
    expect(syncTargetDrifted('/srv/skills', '/srv/skills', defaultSource, false)).toBe(false);
    expect(syncTargetDrifted(undefined, '/srv/skills', defaultSource, false)).toBe(false);
    expect(syncTargetDrifted('/srv/skills', '/other', flagSource, false)).toBe(false);
    expect(syncTargetDrifted('/srv/skills', '/other', defaultSource, true)).toBe(false);
  });

  it('配置给出的落点不拦：项目目录与自定义目录来回同步是正常用法，次次误报等于没有拦截', () => {
    expect(syncTargetDrifted('/work/repo/.agents/skills', '/srv/skills', configSource, false)).toBe(false);
    expect(syncTargetDrifted('/srv/skills', '/work/repo/.agents/skills', projectSource, false)).toBe(false);
  });

  it('预演不拦：中止信息里给的排查办法就是 --dry-run，拦掉它等于堵死出路', () => {
    expect(syncTargetDrifted('/srv/skills', '/other', defaultSource, false, true)).toBe(false);
  });
});

describe('配置读写与 persistSyncChoice', () => {
  let root: string;
  let fakeHome: string;
  let project: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-cfg-'));
    fakeHome = path.join(root, 'home');
    project = path.join(root, 'repo');
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('--dir 记进用户配置，存的是绝对路径', () => {
    const saved = persistSyncChoice('dir', path.join(root, 'skills'), project, fakeHome);
    expect(saved.location).toBe('user');
    expect(readConfigFile(saved.file)?.sync).toEqual({ scope: 'dir', dir: path.join(root, 'skills') });
  });

  it('--project 记进项目内配置：写进用户配置会让换个仓库裸跑也变成项目级', () => {
    const saved = persistSyncChoice('project', undefined, project, fakeHome);
    expect(saved.location).toBe('project');
    expect(saved.file).toBe(path.join(project, '.eat', 'config.json'));
    expect(readConfigFile(saved.file)?.sync).toEqual({ scope: 'project' });
  });

  it('切回非 dir 作用域时丢掉 dir，避免以后悄悄复活一个早就不对的旧目录', () => {
    persistSyncChoice('dir', path.join(root, 'skills'), project, fakeHome);
    const saved = persistSyncChoice('global', undefined, project, fakeHome);
    expect(readConfigFile(saved.file)?.sync).toEqual({ scope: 'global' });
  });

  it('写配置不碰同一文件里的其他字段', () => {
    const file = path.join(fakeHome, '.eat', 'config.json');
    writeConfigFile(file, { sync: { scope: 'global' }, other: 1 } as never);
    persistSyncChoice('dir', '/srv/skills', project, fakeHome);
    expect((readConfigFile(file) as Record<string, unknown>).other).toBe(1);
  });

  it('cwd 就是 home 时两份配置是同一个文件，只算一次', () => {
    writeConfigFile(path.join(fakeHome, '.eat', 'config.json'), { sync: { scope: 'global' } });
    expect(loadConfigs(fakeHome, fakeHome)).toHaveLength(1);
    expect(loadConfigs(project, fakeHome)).toHaveLength(1);
  });

  it('配置文件损坏时当作没有，不让 sync 挂掉', () => {
    const file = path.join(fakeHome, '.eat', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ 不是 json');
    expect(readConfigFile(file)).toBeNull();
    expect(loadConfigs(project, fakeHome)).toHaveLength(0);
  });
});

describe('wouldConflict：预演时的冲突判定与 ensureLink 一致', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-conflict-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('不存在 / 软链 / 受管目录都不算冲突，用户自己的目录才算', () => {
    expect(wouldConflict(path.join(root, 'missing'), false)).toBe(false);

    const src = path.join(root, 'src');
    fs.mkdirSync(src);
    const link = path.join(root, 'link');
    fs.symlinkSync(src, link, 'dir');
    expect(wouldConflict(link, false)).toBe(false);

    const managed = path.join(root, 'managed');
    fs.mkdirSync(managed);
    fs.writeFileSync(path.join(managed, '.eat-meta.json'), JSON.stringify({ slug: 'x', managed: true }));
    expect(wouldConflict(managed, false)).toBe(false);

    const mine = path.join(root, 'mine');
    fs.mkdirSync(mine);
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '# 我自己的\n');
    expect(wouldConflict(mine, false)).toBe(true);
    expect(wouldConflict(mine, true)).toBe(false);
  });
});
