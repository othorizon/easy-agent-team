import type { DevicePollResponse, DeviceStartResponse, UserPublic } from '@eat/shared';
import { Api } from '../client.js';
import {
  clearCredentials,
  clearPendingLogin,
  loadCredentials,
  loadPendingLogin,
  rememberServerUrl,
  rememberedServerUrl,
  resolveServerUrl,
  saveCredentials,
  savePendingLogin,
  type PendingLogin,
} from '../config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 「授权尚未完成」的退出码（决策 54）。
 * 不能用 0——脚本 / AI 会把它当成已登录；也不该和真正的失败（1）混在一起，
 * 毕竟这时授权链接还好好的，正确处置是过会儿再查一次而不是重来。
 */
export const EXIT_PENDING = 2;

export interface LoginOptions {
  server?: string;
  /** commander 的 --no-wait 会把它置为 false */
  wait?: boolean;
  /** 只查一次已发起的授权，立即返回 */
  status?: boolean;
  /** 阻塞等待的上限（秒），默认等到设备码过期 */
  timeout?: string;
  /** 丢开尚未完成的授权请求，重新发一个 */
  new?: boolean;
}

/**
 * 沿用旧授权请求的最短剩余有效期：只剩十几秒的码转告给用户也来不及确认，
 * 不如换一个新的。
 */
const REUSE_MIN_REMAINING_MS = 30_000;

/** 参数校验单独一步：发起授权之前就要挡下非法值，否则会白白作废一个设备码 */
export function parseTimeoutSeconds(timeout: string | undefined): number | null {
  if (timeout === undefined) return null;
  const seconds = Number(timeout);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`--timeout 需要是非负秒数，收到: ${timeout}`);
  }
  return seconds;
}

/** 等待上限：未指定时用服务端给的有效期（即一直等到设备码过期） */
export function resolveTimeoutMs(timeout: string | undefined, expiresInSeconds: number): number {
  const seconds = parseTimeoutSeconds(timeout);
  return (seconds === null ? expiresInSeconds : Math.min(seconds, expiresInSeconds)) * 1000;
}

/**
 * 能不能接着用上次那条尚未完成的授权请求。
 * 重新发起会让已经转告给用户的短码当场作废——AI 反复执行 `eat login` 时这是最容易踩的坑，
 * 所以默认沿用，要换新的显式加 --new。
 */
export function reusablePending(
  pending: PendingLogin | null,
  serverUrl: string,
  opts: Pick<LoginOptions, 'new'> = {},
  now = Date.now(),
): PendingLogin | null {
  if (!pending || opts.new) return null;
  if (pending.serverUrl !== serverUrl) return null;
  return remainingMs(pending, now) >= REUSE_MIN_REMAINING_MS ? pending : null;
}

export function remainingMs(pending: Pick<PendingLogin, 'expiresAt'>, now = Date.now()): number {
  const expiresAt = Date.parse(pending.expiresAt);
  if (Number.isNaN(expiresAt)) return 0;
  return Math.max(0, expiresAt - now);
}

export function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}

function printVerification(pending: PendingLogin): void {
  console.log('');
  console.log('请在浏览器中完成授权：');
  console.log(`  1. 打开  ${pending.verificationUri}`);
  console.log(`  2. 输入代码  ${pending.userCode}`);
  console.log('');
}

/** 领到 Token：写凭证、清掉待授权记录（deviceCode 用完即弃），再报身份 */
function acceptToken(serverUrl: string, token: string, user: UserPublic): void {
  saveCredentials({ serverUrl, token, user });
  // 地址单独记一份：凭证会随 logout / 过期消失，地址不该跟着丢（决策 59）
  rememberServerUrl(serverUrl);
  clearPendingLogin();
  console.log('状态：approved（授权完成）');
  console.log(`登录成功：${user.name} <${user.email}>（${serverUrl}）`);
}

export async function login(opts: LoginOptions = {}): Promise<void> {
  if (opts.status) return loginStatus(opts);

  const serverUrl = resolveServerUrl(opts.server);
  const timeoutSeconds = parseTimeoutSeconds(opts.timeout); // 发请求之前先挡下非法参数
  const api = new Api(serverUrl);

  const reused = reusablePending(loadPendingLogin(), serverUrl, opts);
  let pending: PendingLogin;
  if (reused) {
    pending = reused;
  } else {
    const start = await api.request<DeviceStartResponse>('POST', '/api/auth/device/start');
    // 先落盘再提示：无论接下来是等待、超时还是被用户 Ctrl-C，这次授权都还能用
    // `eat login --status` 接着领，不必让用户重新走一遍浏览器。
    // 地址取 api.resolvedUrl 而不是入参：平台在 http→https 跳转后面时，
    // 存下会跳转的那个地址，登录能成功而之后每条命令都拿不到令牌（决策 59）。
    pending = {
      serverUrl: api.resolvedUrl,
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      verificationUri: start.verificationUri,
      interval: start.interval,
      expiresAt: new Date(Date.now() + start.expiresIn * 1000).toISOString(),
    };
    savePendingLogin(pending);
  }
  const timeoutMs =
    timeoutSeconds === null
      ? remainingMs(pending)
      : Math.min(timeoutSeconds * 1000, remainingMs(pending));

  printVerification(pending);
  if (reused) {
    console.log(`（沿用上次尚未完成的授权请求，剩余 ${formatRemaining(remainingMs(pending))}；要换一个新的加 --new）`);
    console.log('');
  }

  if (opts.wait === false) {
    console.log('状态：pending（等待用户确认；本命令不阻塞）');
    console.log(`授权码 ${formatRemaining(remainingMs(pending))}内有效。`);
    console.log('请把上面的链接与代码转告用户；用户确认后执行 `eat login --status` 领取凭证（立即返回，可反复查）。');
    return;
  }

  process.stdout.write('等待授权中 ');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pending.interval * 1000, Math.max(0, deadline - Date.now())));
    process.stdout.write('.');
    const poll = await api.request<DevicePollResponse>('POST', '/api/auth/device/poll', {
      deviceCode: pending.deviceCode,
    });
    if (poll.status === 'approved') {
      console.log('');
      console.log('');
      acceptToken(pending.serverUrl, poll.token, poll.user);
      return;
    }
    if (poll.status === 'expired') {
      clearPendingLogin();
      console.log('\n状态：expired（授权码已失效，请重新运行 eat login）');
      process.exitCode = 1;
      return;
    }
  }

  // 等待超时 ≠ 授权失败：设备码多半还有效，留着待授权记录让 --status 接着领
  const left = remainingMs(pending);
  console.log('');
  if (left === 0) {
    clearPendingLogin();
    console.log('状态：expired（授权码已过期，请重新运行 eat login）');
    process.exitCode = 1;
    return;
  }
  console.log(`状态：pending（等待超时，授权链接仍然有效，剩余 ${formatRemaining(left)}）`);
  console.log('用户确认后执行 `eat login --status` 领取凭证，不必重新登录。');
  process.exitCode = EXIT_PENDING;
}

/** 查一次已发起的授权：立即返回，不阻塞（决策 54） */
export async function loginStatus(opts: Pick<LoginOptions, 'server'> = {}): Promise<void> {
  const pending = loadPendingLogin();
  if (!pending) {
    const cred = loadCredentials();
    if (cred) {
      const who = cred.user ? `${cred.user.name} <${cred.user.email}>` : '（未记录身份，可用 eat whoami 查看）';
      console.log(`状态：none（没有待授权的登录请求；当前已登录：${who}（${cred.serverUrl}））`);
      return;
    }
    console.log('状态：none（没有待授权的登录请求，请先运行 eat login --no-wait）');
    process.exitCode = 1;
    return;
  }

  if (remainingMs(pending) === 0) {
    clearPendingLogin();
    console.log('状态：expired（授权码已过期，请重新运行 eat login --no-wait）');
    process.exitCode = 1;
    return;
  }

  // 待授权记录自带平台地址：--server 指到别处多半是记混了，说一声而不是默默查另一台
  if (opts.server && resolveServerUrl(opts.server) !== pending.serverUrl) {
    console.log(`（--server 已忽略：这条待授权请求发给的是 ${pending.serverUrl}）`);
  }

  const api = new Api(pending.serverUrl);
  const poll = await api.request<DevicePollResponse>('POST', '/api/auth/device/poll', {
    deviceCode: pending.deviceCode,
  });
  if (poll.status === 'approved') {
    acceptToken(api.resolvedUrl, poll.token, poll.user);
    return;
  }
  if (poll.status === 'expired') {
    clearPendingLogin();
    console.log('状态：expired（授权码已失效，请重新运行 eat login --no-wait）');
    process.exitCode = 1;
    return;
  }
  console.log('状态：pending（用户尚未确认授权，这不是错误）');
  console.log(`  授权链接  ${pending.verificationUri}`);
  console.log(`  代码      ${pending.userCode}`);
  console.log(`  剩余有效  ${formatRemaining(remainingMs(pending))}`);
  console.log('稍后再次执行 `eat login --status` 即可；要等的是用户，重复发起登录没有意义。');
  process.exitCode = EXIT_PENDING;
}

export async function whoami(): Promise<void> {
  const api = Api.fromSaved();
  const me = await api.request<UserPublic>('GET', '/api/auth/whoami');
  // 报 resolvedUrl：地址被跳转修正过时，该打印真正在用的那一个
  console.log(`${me.name} <${me.email}>  角色: ${me.role}  平台: ${api.resolvedUrl}`);
}

export function logout(): void {
  const cred = loadCredentials();
  // 退出登录前把平台地址留下：它存在凭证文件里，删掉凭证等于把地址也删了，
  // 下一次裸跑 eat login 会悄悄回落到 http://localhost:3000（决策 59）。
  if (cred?.serverUrl) rememberServerUrl(cred.serverUrl);
  clearCredentials();
  clearPendingLogin();
  console.log(cred ? '已退出登录（本地凭证已删除；如需彻底作废 Token，请在控制台吊销）' : '当前未登录');
  const remembered = rememberedServerUrl();
  if (remembered) {
    console.log(`平台地址仍记着 ${remembered}，下次 eat login 直接连它（换平台用 --server，清除用 eat config unset server）`);
  }
}
