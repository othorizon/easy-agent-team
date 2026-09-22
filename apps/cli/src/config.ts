import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigFile, userConfigFile, writeConfigFile } from './sync-config.js';

export interface Credentials {
  serverUrl: string;
  token: string;
  user?: { name: string; email: string; role: string };
}

const CONFIG_DIR = path.join(os.homedir(), '.eat');
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.json');

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

/** mode 在 Windows 上被忽略（%USERPROFILE% 默认 ACL 已限本人可读），类 Unix 上必须 0600 */
export function saveCredentials(cred: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
}

export function clearCredentials(): void {
  fs.rmSync(CRED_FILE, { force: true });
}

/** 去掉末尾斜杠，保证同一个平台在各处比较时是同一个字符串 */
export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 记住的平台地址（决策 59）。
 *
 * 地址此前只存在凭证文件里，于是 `eat logout`（或凭证被手工删掉）会把地址一起带走，
 * 下一次裸跑 `eat login` 就悄悄回落到 http://localhost:3000——用户以为在登录团队平台，
 * 实际在连本机。地址不是凭证，退出登录不该把它一起丢掉，所以单独记进用户配置。
 */
export function rememberedServerUrl(home: string = os.homedir()): string | null {
  const server = readConfigFile(userConfigFile(home))?.server;
  return typeof server === 'string' && server.trim() ? normalizeServerUrl(server) : null;
}

export function rememberServerUrl(serverUrl: string, home: string = os.homedir()): void {
  const url = normalizeServerUrl(serverUrl);
  const file = userConfigFile(home);
  const config = readConfigFile(file) ?? {};
  if (config.server === url) return;
  config.server = url;
  writeConfigFile(file, config);
}

export function forgetServerUrl(home: string = os.homedir()): boolean {
  const file = userConfigFile(home);
  const config = readConfigFile(file);
  if (!config?.server) return false;
  delete config.server;
  writeConfigFile(file, config);
  return true;
}

/** 可测的纯函数版本：优先级即参数顺序 */
export function pickServerUrl(
  option: string | undefined,
  envServer: string | undefined,
  credentialUrl: string | undefined,
  remembered: string | null,
): string {
  return normalizeServerUrl(option ?? envServer ?? credentialUrl ?? remembered ?? 'http://localhost:3000');
}

/** 服务地址解析优先级：命令行参数 > EAT_SERVER 环境变量 > 已保存凭证 > 记住的平台地址 > 本地默认 */
export function resolveServerUrl(option?: string): string {
  return pickServerUrl(option, process.env.EAT_SERVER, loadCredentials()?.serverUrl, rememberedServerUrl());
}

export type ServerUrlSource = 'env' | 'credentials' | 'config' | 'default';

/** 给 eat config list 用：现在裸跑的命令会连哪台平台、这个地址是哪来的 */
export function describeServerUrl(): { url: string; source: ServerUrlSource } {
  const env = process.env.EAT_SERVER;
  if (env) return { url: normalizeServerUrl(env), source: 'env' };
  const cred = loadCredentials()?.serverUrl;
  if (cred) return { url: normalizeServerUrl(cred), source: 'credentials' };
  const remembered = rememberedServerUrl();
  if (remembered) return { url: remembered, source: 'config' };
  return { url: 'http://localhost:3000', source: 'default' };
}

/**
 * 待授权的设备码登录（决策 54：非阻塞登录）。
 * deviceCode 能换回 Token，按凭证对待：同样落 0600、用完即删。
 */
export interface PendingLogin {
  serverUrl: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** 建议的轮询间隔（秒），由服务端下发 */
  interval: number;
  /** 设备码失效时刻（ISO） */
  expiresAt: string;
}

const PENDING_FILE = path.join(CONFIG_DIR, 'pending-login.json');

export function loadPendingLogin(): PendingLogin | null {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) as PendingLogin;
    return p.deviceCode && p.serverUrl ? p : null;
  } catch {
    return null;
  }
}

export function savePendingLogin(pending: PendingLogin): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), { mode: 0o600 });
}

export function clearPendingLogin(): void {
  fs.rmSync(PENDING_FILE, { force: true });
}
