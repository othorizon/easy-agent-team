import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

/** 服务地址解析优先级：命令行参数 > EAT_SERVER 环境变量 > 已保存配置 > 本地默认 */
export function resolveServerUrl(option?: string): string {
  return (
    option ??
    process.env.EAT_SERVER ??
    loadCredentials()?.serverUrl ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
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
