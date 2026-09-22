import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseFromFinalUrl, classifyRedirect } from '../src/client.js';
import { forgetServerUrl, pickServerUrl, rememberServerUrl, rememberedServerUrl } from '../src/config.js';
import { readConfigFile, userConfigFile, writeConfigFile } from '../src/sync-config.js';

const u = (s: string) => new URL(s);

describe('classifyRedirect：跳转后还能不能带着令牌（决策 59）', () => {
  it('同源跳转照跟', () => {
    expect(classifyRedirect(u('https://eat.example.com/api/x'), u('https://eat.example.com/api/y'))).toBe('follow');
    expect(classifyRedirect(u('http://127.0.0.1:3000/a'), u('http://127.0.0.1:3000/a/'))).toBe('follow');
  });

  it('同主机的 http → https 算地址升级，跟随并记下修正', () => {
    expect(classifyRedirect(u('http://eat.example.com/api/x'), u('https://eat.example.com/api/x'))).toBe('upgrade');
  });

  it('换了主机一律停下：令牌绝不转发给另一台主机', () => {
    expect(classifyRedirect(u('http://eat.example.com/x'), u('https://evil.example.net/x'))).toBe('stop');
    expect(classifyRedirect(u('https://old.example.com/x'), u('https://new.example.com/x'))).toBe('stop');
  });

  it('https 降级到 http 也停', () => {
    expect(classifyRedirect(u('https://eat.example.com/x'), u('http://eat.example.com/x'))).toBe('stop');
  });
});

describe('baseFromFinalUrl：从最终地址反推平台根地址', () => {
  it('去掉请求路径剩下的就是根地址', () => {
    expect(baseFromFinalUrl('https://eat.example.com/api/auth/whoami', '/api/auth/whoami')).toBe(
      'https://eat.example.com',
    );
  });

  it('平台挂在子路径下也能还原', () => {
    expect(baseFromFinalUrl('https://x.com/eat/api/health', '/api/health')).toBe('https://x.com/eat');
  });

  it('对不上就不猜', () => {
    expect(baseFromFinalUrl('https://eat.example.com/login', '/api/health')).toBeNull();
  });
});

describe('pickServerUrl：平台地址的来源优先级（决策 59）', () => {
  it('命令行 > 环境变量 > 凭证 > 记住的地址 > 内置默认', () => {
    expect(pickServerUrl('http://a', 'http://b', 'http://c', 'http://d')).toBe('http://a');
    expect(pickServerUrl(undefined, 'http://b', 'http://c', 'http://d')).toBe('http://b');
    expect(pickServerUrl(undefined, undefined, 'http://c', 'http://d')).toBe('http://c');
    expect(pickServerUrl(undefined, undefined, undefined, 'http://d')).toBe('http://d');
    expect(pickServerUrl(undefined, undefined, undefined, null)).toBe('http://localhost:3000');
  });

  it('退出登录后仍落在记住的平台上，而不是悄悄回落到 localhost', () => {
    expect(pickServerUrl(undefined, undefined, undefined, 'https://eat.example.com')).toBe('https://eat.example.com');
  });

  it('统一去掉末尾斜杠', () => {
    expect(pickServerUrl('https://eat.example.com/', undefined, undefined, null)).toBe('https://eat.example.com');
  });
});

describe('记住的平台地址：logout 不该把地址一起带走（决策 59）', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eat-home-'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('写入后读得回来，且与 sync 配置共存一份文件', () => {
    writeConfigFile(userConfigFile(home), { sync: { scope: 'global' } });
    rememberServerUrl('https://eat.example.com/', home);
    expect(rememberedServerUrl(home)).toBe('https://eat.example.com');
    expect(readConfigFile(userConfigFile(home))).toEqual({
      sync: { scope: 'global' },
      server: 'https://eat.example.com',
    });
  });

  it('没配过时返回 null（由调用方回落到内置默认）', () => {
    expect(rememberedServerUrl(home)).toBeNull();
  });

  it('清除只拿掉 server，不动 sync 配置', () => {
    writeConfigFile(userConfigFile(home), { sync: { scope: 'global' }, server: 'https://eat.example.com' });
    expect(forgetServerUrl(home)).toBe(true);
    expect(readConfigFile(userConfigFile(home))).toEqual({ sync: { scope: 'global' } });
    expect(forgetServerUrl(home)).toBe(false);
  });
});
