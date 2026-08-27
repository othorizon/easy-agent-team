import type { DevicePollResponse, DeviceStartResponse, UserPublic } from '@eat/shared';
import { Api } from '../client.js';
import { clearCredentials, loadCredentials, resolveServerUrl, saveCredentials } from '../config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function login(opts: { server?: string }): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const api = new Api(serverUrl);
  const start = await api.request<DeviceStartResponse>('POST', '/api/auth/device/start');

  console.log('');
  console.log('请在浏览器中完成授权：');
  console.log(`  1. 打开  ${start.verificationUri}`);
  console.log(`  2. 输入代码  ${start.userCode}`);
  console.log('');
  process.stdout.write('等待授权中 ');

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000);
    process.stdout.write('.');
    const poll = await api.request<DevicePollResponse>('POST', '/api/auth/device/poll', {
      deviceCode: start.deviceCode,
    });
    if (poll.status === 'approved') {
      saveCredentials({ serverUrl, token: poll.token, user: poll.user });
      console.log(`\n\n登录成功：${poll.user.name} <${poll.user.email}>（${serverUrl}）`);
      return;
    }
    if (poll.status === 'expired') break;
  }
  console.log('\n授权超时或已失效，请重新运行 eat login');
  process.exitCode = 1;
}

export async function whoami(): Promise<void> {
  const api = Api.fromSaved();
  const me = await api.request<UserPublic>('GET', '/api/auth/whoami');
  console.log(`${me.name} <${me.email}>  角色: ${me.role}  平台: ${api.serverUrl}`);
}

export function logout(): void {
  const cred = loadCredentials();
  clearCredentials();
  console.log(cred ? '已退出登录（本地凭证已删除；如需彻底作废 Token，请在控制台吊销）' : '当前未登录');
}
