import type { Command } from 'commander';
import { ALIYUN_CREDENTIAL_NOTE, matchAliyunAccounts, matchAliyunPermissions, requestAliyunPermissionSchema, type AliyunCatalogPermission, type AliyunPermissionRequestResult, type AliyunCredentials, type AliyunGrantInfo, type AliyunGrantsResult } from '@eat/shared';
import { Api } from '../client.js';
import { runWithEnv } from '../run-with-env.js';

export async function aliyunList(opts: { account?: string; json?: boolean } = {}) {
  const points = (await Api.fromSaved().request<AliyunCatalogPermission[]>('GET', '/api/aliyun/permissions'))
    .filter(p => !opts.account || p.connectionName === opts.account || p.accountId === opts.account);
  if (opts.json) { console.log(JSON.stringify(points, null, 2)); return; }
  if (!points.length) console.log('暂无开放申请的权限点');
  for (const p of points) console.log(`${p.policyName} @ ${p.connectionName} (${p.accountId})\n  说明：${p.description || '未填写'}\n  用途：${p.purpose || '未填写'}\n  数据范围：${p.dataScope || '未填写'}\n  Owner：${p.ownerName || '管理员审批'}${p.ownerStatus === 'disabled' ? '（Owner 已停用，由管理员审批）' : ''}${p.connectionStatus === 'paused' ? '\n  接入已暂停，恢复后可申请' : ''}`);
}
export async function aliyunRequest(ref: string, opts: { reason: string; account?: string }) {
  const dto = requestAliyunPermissionSchema.parse({ reason: opts.reason });
  const api = Api.fromSaved();
  const hits = matchAliyunPermissions(await api.request<AliyunCatalogPermission[]>('GET', '/api/aliyun/permissions'), ref, opts.account);
  if (!hits.length) throw new Error(`未找到权限点 ${ref}，请用 eat aliyun list 查看开放申请的目录。`);
  if (hits.length > 1) throw new Error(`多个云账号有同名权限点，请用 <权限点>@<接入名称> 或 --account 指定接入名称/云账号 ID：${hits.map(p => `${p.policyName}@${p.connectionName} (${p.accountId})`).join('、')}`);
  const r = await api.request<AliyunPermissionRequestResult>('POST', `/api/aliyun/permissions/${hits[0].id}/requests`, dto);
  if (r.grant) {
    if (r.grant.error) throw new Error(`已记录本人授权，执行失败：${r.grant.error}。请在控制台重试，无需重新申请。`);
    console.log('已直接授予本人，无需审批');
  } else console.log(`申请已提交：${r.requestId}。查看进度：eat requests show ${r.requestId}`);
}

async function ownGrants(api: Api) { return (await api.request<AliyunGrantsResult>('GET', '/api/aliyun/grants')).grants; }
async function account(api: Api, ref?: string) {
  const hits = matchAliyunAccounts(await ownGrants(api), ref);
  if (!hits.length) throw new Error(`没有${ref ? `云账号 ${ref} 的` : '任何云账号的'}有效授权，请用 eat aliyun list 查看目录并申请，或在控制台阿里云权限目录向 Owner 申请。`);
  if (hits.length > 1) throw new Error(`有多个有权云账号，请指定接入名称或云账号 ID：${hits.map(a => `${a.connectionName} (${a.accountId})`).join('、')}`);
  return hits[0];
}
export async function aliyunGrants() {
  const grants = await ownGrants(Api.fromSaved());
  if (!grants.length) console.log('暂无阿里云授权，请用 eat aliyun list 查看目录，在控制台向 Owner 申请。');
  for (const g of grants) console.log(`[${g.state}] ${g.policyName} @ ${g.connectionName} (${g.accountId})${g.error ? ` · ${g.error}` : ''}`);
  console.log(ALIYUN_CREDENTIAL_NOTE);
}
export async function aliyunRevoke(ref: string, opts: { account?: string } = {}) {
  const api = Api.fromSaved();
  const grants = (await ownGrants(api)).filter(g => !['revoked', 'revoking'].includes(g.state));
  const hits = grants.filter(g => (g.policyName === ref || g.permissionId === ref || g.id === ref) &&
    (!opts.account || g.connectionName === opts.account || g.accountId === opts.account));
  if (!hits.length) throw new Error(`没有权限点 ${ref} 的个人授权，请用 eat aliyun grants 查看。`);
  if (hits.length > 1) throw new Error(`多个云账号有同名权限点，请加 --account：${hits.map(g => g.connectionName).join('、')}`);
  const result = await api.request<AliyunGrantInfo>('POST', `/api/aliyun/grants/${hits[0].id}/relinquish`);
  if (result.state !== 'revoked') throw new Error(`放弃授权尚未完成：${result.error ?? result.state}。请在控制台重试。`);
  console.log(`已放弃 ${hits[0].policyName} @ ${hits[0].connectionName} 的授权`);
}
async function fetchKey(api: Api, ref?: string, reset = false) {
  const a = await account(api, ref);
  if (reset) console.error(`重置会影响同一云账号 ${a.connectionName} 下的 OSS 空间：它们共用这把 Key。${ALIYUN_CREDENTIAL_NOTE}`);
  return api.request<AliyunCredentials>('POST', `/api/aliyun/connections/${a.connectionId}/credentials${reset ? '/reset' : ''}`);
}
export async function aliyunCredentials(opts: { account?: string; reset?: boolean } = {}) {
  const key = await fetchKey(Api.fromSaved(), opts.account, opts.reset);
  console.error(ALIYUN_CREDENTIAL_NOTE);
  console.log(JSON.stringify(key, null, 2));
}
/** Each child gets direct AK authentication, even when the caller has a default profile/STS identity. */
export async function aliyunRun(ref: string | undefined, command: string[]) {
  if (!command.length) throw new Error('缺少命令：eat aliyun run [接入名称] -- <命令...>');
  const key = await fetchKey(Api.fromSaved(), ref);
  console.error(ALIYUN_CREDENTIAL_NOTE);
  let remaining = Date.parse(key.readyAt) - Date.now();
  if (remaining > 0) {
    console.error('正在等待新 Key 生效');
    while (remaining > 0) {
      await new Promise(r => setTimeout(r, Math.min(remaining, 30_000)));
      remaining = Date.parse(key.readyAt) - Date.now();
    }
  }
  const injected = new Map(Object.entries({
    ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE', ALIBABA_CLOUD_ACCESS_KEY_ID: key.accessKeyId,
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: key.accessKeySecret, ALIBABA_CLOUD_REGION_ID: key.defaultRegion,
    OSS_ACCESS_KEY_ID: key.accessKeyId, OSS_ACCESS_KEY_SECRET: key.accessKeySecret, OSS_REGION: key.defaultRegion,
  }));
  const identityVariables = Object.keys(process.env).filter(k => k.startsWith('ALIBABA_CLOUD_') ||
    /^(OSS_SESSION_TOKEN|OSS_ROLE_ARN|OSS_ROLE_SESSION_NAME|OSSUTIL_CONFIG_FILE|OSSUTIL_PROFILE|OSS_CREDENTIALS_URI|OSS_ECS_ROLE_NAME|OSS_OIDC_PROVIDER_ARN|OSS_OIDC_TOKEN_FILE)$/.test(k));
  await runWithEnv(command, injected, identityVariables);
}
export function registerAliyunCommands(program: Command) {
  const aliyun = program.command('aliyun').description('阿里云权限与本人临时凭证');
  aliyun.command('list').description('查看开放申请的权限点').option('--account <account>', '接入名称或云账号 ID').option('--json', '输出 JSON').action(aliyunList);
  aliyun.command('request <permission>').description('申请权限点；同名用 权限点@接入名称 或 --account').requiredOption('--reason <reason>', '申请用途').option('--account <account>', '接入名称或云账号 ID').action(aliyunRequest);
  aliyun.command('grants').description('查看我的授权').action(aliyunGrants);
  aliyun.command('revoke <permission>').option('--account <account>', '接入名称或云账号 ID').description('放弃自己的权限点授权').action(aliyunRevoke);
  const credentials = aliyun.command('credentials').option('--account <account>', '接入名称或云账号 ID').description(`读取本人的 Key。${ALIYUN_CREDENTIAL_NOTE}`)
    .action(opts => aliyunCredentials(opts));
  credentials.command('reset').option('--account <account>', '接入名称或云账号 ID').description('重置本人 Key；同一云账号下的 OSS 空间也受影响')
    .action((_opts, cmd) => aliyunCredentials({ ...cmd.optsWithGlobals(), reset: true }));
  aliyun.command('run [args...]').allowUnknownOption().usage('[接入名称或云账号ID] -- <命令...>')
    .description('将 Key 注入 aliyun / ossutil 2 子进程，不写文件，退出码透传；管道请显式用 sh -c')
    .action(async () => {
      // Commander 13 exposes rawArgs at runtime but omits it from its declaration.
      const raw = (program as Command & { rawArgs: string[] }).rawArgs, split = raw.indexOf('--'), start = raw.indexOf('run');
      if (split < 0 || raw.slice(start + 1, split).length > 1) throw new Error('用法：eat aliyun run [接入名称或云账号ID] -- <命令...>');
      await aliyunRun(raw[start + 1] === '--' ? undefined : raw[start + 1], raw.slice(split + 1));
    });
}
