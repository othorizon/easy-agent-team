import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_VERSION, isNewerVersion, skillBundleVersion } from '@eat/shared';
import { describe, expect, it } from 'vitest';
import { isValidBundle, resolveInstallPath } from '../src/commands/self-update.js';
import { buildUpdateNotice, mergeServerVersions, notifierDisabled, type UpdateState } from '../src/update.js';

describe('CLI 版本号单一事实源', () => {
  it('package.json 与 shared 的 CLI_VERSION 保持一致', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe(CLI_VERSION);
  });
});

describe('skillBundleVersion：Skill 集合指纹', () => {
  it('与顺序无关', () => {
    const a = skillBundleVersion([
      { slug: 'b', version: 1 },
      { slug: 'a', version: 2 },
    ]);
    const b = skillBundleVersion([
      { slug: 'a', version: 2 },
      { slug: 'b', version: 1 },
    ]);
    expect(a).toBe(b);
  });

  it('单个 skill 出新版本会改变指纹', () => {
    const before = skillBundleVersion([{ slug: 'a', version: 1 }]);
    const after = skillBundleVersion([{ slug: 'a', version: 2 }]);
    expect(after).not.toBe(before);
  });

  it('新增订阅会改变指纹', () => {
    const before = skillBundleVersion([{ slug: 'a', version: 1 }]);
    const after = skillBundleVersion([
      { slug: 'a', version: 1 },
      { slug: 'b', version: 1 },
    ]);
    expect(after).not.toBe(before);
  });

  it('退订会改变指纹', () => {
    const before = skillBundleVersion([
      { slug: 'a', version: 1 },
      { slug: 'b', version: 1 },
    ]);
    const after = skillBundleVersion([{ slug: 'a', version: 1 }]);
    expect(after).not.toBe(before);
  });

  it('空集合也有稳定取值', () => {
    expect(skillBundleVersion([])).toBe(skillBundleVersion([]));
    expect(skillBundleVersion([])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('isNewerVersion：语义版本比较', () => {
  it('按主次修订依次比较', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true);
  });

  it('同版本与更旧版本都不算更新', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });

  it('缺省的修订段按 0 处理', () => {
    expect(isNewerVersion('0.2', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.2', '0.2.0')).toBe(false);
  });

  it('解析不了的版本号一律不提示（宁可漏也不误报）', () => {
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', 'dev')).toBe(false);
    expect(isNewerVersion('1.2.3.4', '0.1.0')).toBe(false);
  });
});

describe('buildUpdateNotice：提示什么、什么时候闭嘴', () => {
  const local = '0.1.0';

  it('无任何服务端信息时不提示', () => {
    expect(buildUpdateNotice({}, local, null)).toBeNull();
  });

  it('平台版本更新时给出 self-update 指引', () => {
    const notice = buildUpdateNotice({ latestCliVersion: '0.2.0' }, local, null);
    expect(notice?.lines.join('\n')).toContain('eat self-update');
    expect(notice?.lines.join('\n')).toContain('0.1.0 → 0.2.0');
    expect(notice?.cliVersion).toBe('0.2.0');
  });

  it('平台版本不比本地新时不提示', () => {
    expect(buildUpdateNotice({ latestCliVersion: '0.1.0' }, local, null)).toBeNull();
  });

  it('已就该版本提示过则不再重复（按版本去重）', () => {
    const state: UpdateState = { latestCliVersion: '0.2.0', notifiedCliVersion: '0.2.0' };
    expect(buildUpdateNotice(state, local, null)).toBeNull();
  });

  it('出了更新的版本后重新提示', () => {
    const state: UpdateState = { latestCliVersion: '0.3.0', notifiedCliVersion: '0.2.0' };
    expect(buildUpdateNotice(state, local, null)?.cliVersion).toBe('0.3.0');
  });

  it('本地 Skill 基线与服务端指纹不一致时提示 sync', () => {
    const state: UpdateState = { serverSkillVersion: 'aaaa', syncedSkillVersion: 'bbbb' };
    const notice = buildUpdateNotice(state, local, null);
    expect(notice?.lines.join('\n')).toContain('eat sync');
    expect(notice?.skillVersion).toBe('aaaa');
  });

  it('基线一致时不提示 Skill 更新', () => {
    const state: UpdateState = { serverSkillVersion: 'aaaa', syncedSkillVersion: 'aaaa' };
    expect(buildUpdateNotice(state, local, null)).toBeNull();
  });

  it('没有基线时回退到本地目录反推的指纹（覆盖老客户端）', () => {
    const state: UpdateState = { serverSkillVersion: 'aaaa' };
    expect(buildUpdateNotice(state, local, 'bbbb')?.skillVersion).toBe('aaaa');
    expect(buildUpdateNotice(state, local, 'aaaa')).toBeNull();
  });

  it('本地状态无法确定时不提示 Skill 更新（宁可漏也不误报）', () => {
    const state: UpdateState = { serverSkillVersion: 'aaaa' };
    expect(buildUpdateNotice(state, local, null)).toBeNull();
  });

  it('同一指纹只提示一次', () => {
    const state: UpdateState = {
      serverSkillVersion: 'aaaa',
      syncedSkillVersion: 'bbbb',
      notifiedSkillVersion: 'aaaa',
    };
    expect(buildUpdateNotice(state, local, null)).toBeNull();
  });

  it('两类更新并存时合并成一条提示，并始终带关闭方式', () => {
    const state: UpdateState = {
      latestCliVersion: '0.2.0',
      serverSkillVersion: 'aaaa',
      syncedSkillVersion: 'bbbb',
    };
    const notice = buildUpdateNotice(state, local, null);
    expect(notice?.lines).toHaveLength(4);
    const text = notice?.lines.join('\n') ?? '';
    expect(text).toContain('不影响本次命令结果');
    expect(text).toContain('eat self-update');
    expect(text).toContain('eat sync');
    expect(text).toContain('EAT_NO_UPDATE_NOTIFIER=1');
  });
});

describe('mergeServerVersions：把响应头合进状态', () => {
  const url = 'https://eat.example.com';

  it('首次记录服务端回传的两个值', () => {
    expect(mergeServerVersions({}, url, '0.2.0', 'aaaa')).toEqual({
      serverUrl: url,
      latestCliVersion: '0.2.0',
      serverSkillVersion: 'aaaa',
    });
  });

  it('值没变时返回 null，不必每个请求都写一次文件', () => {
    const state: UpdateState = { serverUrl: url, latestCliVersion: '0.2.0', serverSkillVersion: 'aaaa' };
    expect(mergeServerVersions(state, url, '0.2.0', 'aaaa')).toBeNull();
  });

  it('指纹变化必须被记录（回归：曾因就地改 state 导致比较恒为假、状态永远停在第一次）', () => {
    const state: UpdateState = { serverUrl: url, latestCliVersion: '0.2.0', serverSkillVersion: 'aaaa' };
    const next = mergeServerVersions(state, url, '0.2.0', 'bbbb');
    expect(next?.serverSkillVersion).toBe('bbbb');
    // 入参不能被就地修改
    expect(state.serverSkillVersion).toBe('aaaa');
  });

  it('CLI 版本变化同样被记录', () => {
    const state: UpdateState = { serverUrl: url, latestCliVersion: '0.2.0', serverSkillVersion: 'aaaa' };
    expect(mergeServerVersions(state, url, '0.3.0', 'aaaa')?.latestCliVersion).toBe('0.3.0');
  });

  it('保留 sync 基线与已提示标记，不被响应头覆盖', () => {
    const state: UpdateState = {
      serverUrl: url,
      serverSkillVersion: 'aaaa',
      syncedSkillVersion: 'aaaa',
      notifiedCliVersion: '0.2.0',
    };
    const next = mergeServerVersions(state, url, '0.2.0', 'bbbb');
    expect(next?.syncedSkillVersion).toBe('aaaa');
    expect(next?.notifiedCliVersion).toBe('0.2.0');
  });

  it('换平台时整体重置，旧平台的基线与提示标记一律作废', () => {
    const state: UpdateState = {
      serverUrl: 'https://old.example.com',
      latestCliVersion: '0.9.0',
      serverSkillVersion: 'aaaa',
      syncedSkillVersion: 'aaaa',
      notifiedCliVersion: '0.9.0',
    };
    expect(mergeServerVersions(state, url, '0.2.0', 'bbbb')).toEqual({
      serverUrl: url,
      latestCliVersion: '0.2.0',
      serverSkillVersion: 'bbbb',
    });
  });

  it('两个头都缺失时什么都不做（老服务端）', () => {
    expect(mergeServerVersions({ serverUrl: url }, url, null, null)).toBeNull();
  });
});

describe('notifierDisabled：关闭开关', () => {
  it('未设置时启用提示', () => {
    expect(notifierDisabled({})).toBe(false);
  });

  it('EAT_NO_UPDATE_NOTIFIER 置真即关闭', () => {
    expect(notifierDisabled({ EAT_NO_UPDATE_NOTIFIER: '1' })).toBe(true);
    expect(notifierDisabled({ EAT_NO_UPDATE_NOTIFIER: 'true' })).toBe(true);
  });

  it('兼容 update-notifier 生态的 NO_UPDATE_NOTIFIER', () => {
    expect(notifierDisabled({ NO_UPDATE_NOTIFIER: '1' })).toBe(true);
  });

  it('显式的假值不算关闭', () => {
    expect(notifierDisabled({ EAT_NO_UPDATE_NOTIFIER: '0' })).toBe(false);
    expect(notifierDisabled({ EAT_NO_UPDATE_NOTIFIER: 'false' })).toBe(false);
    expect(notifierDisabled({ EAT_NO_UPDATE_NOTIFIER: '' })).toBe(false);
  });
});

describe('self-update：产物校验与落地路径', () => {
  it('只接受带 shebang 且体量合理的产物', () => {
    expect(isValidBundle('#!/usr/bin/env node\n' + 'x'.repeat(2000))).toBe(true);
  });

  it('拒绝平台回的 JSON 错误体', () => {
    expect(isValidBundle('{"error":"NOT_FOUND","message":"CLI 产物未就绪"}')).toBe(false);
  });

  it('拒绝代理/门户塞回的 HTML 页面', () => {
    expect(isValidBundle('<!DOCTYPE html>' + 'x'.repeat(2000))).toBe(false);
  });

  it('拒绝被截断的下载', () => {
    expect(isValidBundle('#!/usr/bin/env node\nconsole.log(1)')).toBe(false);
  });

  const defaultBin = path.join(os.homedir(), '.eat', 'bin', 'eat.js');

  it('默认覆盖正在运行的那份产物', () => {
    const running = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eat-')), 'eat.js');
    fs.writeFileSync(running, '#!/usr/bin/env node\n');
    expect(resolveInstallPath(['node', running])).toBe(running);
  });

  it('运行路径不存在或不是产物时回退到安装脚本的默认位置', () => {
    expect(resolveInstallPath(['node', '/nowhere/eat.js'])).toBe(defaultBin);
    expect(resolveInstallPath(['node', path.resolve(__dirname, '..', 'package.json')])).toBe(defaultBin);
    expect(resolveInstallPath(['node'])).toBe(defaultBin);
  });
});
