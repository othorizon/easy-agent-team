import type { HelpRequestDetail, HelpRequestInfo, HelpTargets } from '@eat/shared';
import { Api } from '../client.js';

const STATUS_LABEL: Record<string, string> = {
  open: '等待回复',
  answered: '已回复',
  resolved: '已解决',
  closed: '已关闭',
};

export async function askTargets(): Promise<void> {
  const api = Api.fromSaved();
  const t = await api.request<HelpTargets>('GET', '/api/helpers');
  if (t.helpers.length > 0) {
    console.log('可求助的人：');
    for (const h of t.helpers) console.log(`  ${h.userId}  ${h.name} — ${h.description}`);
  }
  if (t.skillAuthors.length > 0) {
    console.log('可求助的 skill（问题与 skill 相关时优先）：');
    for (const s of t.skillAuthors) console.log(`  ${s.skillSlug}  ${s.skillName}（作者: ${s.authorName}）`);
  }
  if (t.helpers.length === 0 && t.skillAuthors.length === 0) console.log('暂无可求助对象');
}

export async function askCreate(opts: {
  title: string;
  description: string;
  tried: string;
  to?: string;
  skill?: string;
}): Promise<void> {
  const api = Api.fromSaved();
  if (!opts.to === !opts.skill) {
    console.error('错误: --to <helper用户ID> 与 --skill <slug> 必须且只能提供一个（eat ask targets 查看候选）');
    process.exitCode = 1;
    return;
  }
  const r = await api.request<HelpRequestInfo>('POST', '/api/help-requests', {
    title: opts.title,
    description: opts.description,
    tried: opts.tried,
    helperUserId: opts.to,
    skillSlug: opts.skill,
  });
  console.log(`求助已发出（ID: ${r.id}），已通知 ${r.helperName}。`);
  console.log(`查看回复: eat ask show ${r.id}`);
}

export async function askList(): Promise<void> {
  const api = Api.fromSaved();
  const rows = await api.request<HelpRequestInfo[]>('GET', '/api/help-requests/mine');
  const inbox = await api.request<HelpRequestInfo[]>('GET', '/api/help-requests/inbox');
  if (rows.length === 0 && inbox.length === 0) {
    console.log('没有求助记录');
    return;
  }
  if (rows.length > 0) {
    console.log('我发起的：');
    for (const r of rows) console.log(`  ${r.id.slice(0, 8)}  [${STATUS_LABEL[r.status]}] ${r.title} → ${r.helperName}`);
  }
  if (inbox.length > 0) {
    console.log('找我的：');
    for (const r of inbox) console.log(`  ${r.id.slice(0, 8)}  [${STATUS_LABEL[r.status]}] ${r.title} ← ${r.requesterName}`);
  }
}

async function resolveId(api: Api, shortId: string): Promise<string> {
  if (shortId.length >= 32) return shortId;
  const all = [
    ...(await api.request<HelpRequestInfo[]>('GET', '/api/help-requests/mine')),
    ...(await api.request<HelpRequestInfo[]>('GET', '/api/help-requests/inbox')),
  ];
  const hit = all.find((r) => r.id.startsWith(shortId));
  if (!hit) throw new Error(`找不到 ID 前缀为 ${shortId} 的求助`);
  return hit.id;
}

export async function askShow(id: string): Promise<void> {
  const api = Api.fromSaved();
  const r = await api.request<HelpRequestDetail>('GET', `/api/help-requests/${await resolveId(api, id)}`);
  console.log(`[${STATUS_LABEL[r.status]}] ${r.title}`);
  console.log(`${r.requesterName} → ${r.helperName}${r.skillSlug ? `（skill: ${r.skillSlug}）` : ''}`);
  console.log(`\n问题：${r.description}`);
  console.log(`已尝试：${r.tried}`);
  for (const m of r.messages) {
    console.log(`\n[${m.createdAt.slice(5, 16).replace('T', ' ')}] ${m.senderName}:`);
    console.log(`  ${m.content.split('\n').join('\n  ')}`);
  }
  if (r.experienceSkillSlug) console.log(`\n已沉淀为经验: ${r.experienceSkillSlug}（eat sync 可获取）`);
}

export async function askReply(id: string, opts: { message: string }): Promise<void> {
  const api = Api.fromSaved();
  await api.request('POST', `/api/help-requests/${await resolveId(api, id)}/reply`, { content: opts.message });
  console.log('已回复');
}

export async function askResolve(id: string): Promise<void> {
  const api = Api.fromSaved();
  await api.request('POST', `/api/help-requests/${await resolveId(api, id)}/resolve`, {});
  console.log('已标记解决。被求助者可以在控制台把它沉淀为经验。');
}

export async function askDelete(id: string): Promise<void> {
  const api = Api.fromSaved();
  await api.request('DELETE', `/api/help-requests/${await resolveId(api, id)}`);
  console.log('已删除（求助与对话记录不可恢复）。');
}
