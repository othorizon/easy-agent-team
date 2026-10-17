import type { Command } from 'commander';
import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  SITE_MAX_BYTES,
  SITE_MAX_FILES,
  sitePathSchema, siteContentType, uploadFolioFiles, folioManifestKey,
  folioToolRequest,
  type FolioUploadFile,
  type FolioToolName,
} from '@eat/shared';
import { Api } from '../client.js';

export function collectFolioFiles(input: string): FolioUploadFile[] {
  const root = resolve(input);
  const stat = lstatSync(root);
  const files: FolioUploadFile[] = [];
  let total = 0;
  const add = (path: string, content: Uint8Array) => {
    total += content.length;
    if (total > SITE_MAX_BYTES || files.length >= SITE_MAX_FILES) throw new Error('发布最多 2000 个文件、50 MiB');
    sitePathSchema.parse(path);
    const bytes = Uint8Array.from(content);
    files.push({ path, bytes, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, type: siteContentType(path) });
  };
  if (stat.isDirectory()) {
    const walk = (dir: string, prefix = '') => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules' || /^\.env(?:\.|$)/.test(e.name) || e.name === '.DS_Store')
          continue;
        const path = prefix + e.name;
        if (e.isSymbolicLink()) throw new Error(`发布目录不能包含软链接：${path}`);
        if (e.isDirectory()) walk(join(dir, e.name), path + '/');
        else if (e.isFile()) {
          const file = join(dir, e.name);
          if (total + lstatSync(file).size > SITE_MAX_BYTES) throw new Error('发布最多 50 MiB');
          add(path, readFileSync(file));
        }
      }
    };
    walk(root);
  } else if (stat.isFile() && root.toLowerCase().endsWith('.zip')) {
    if (stat.size > SITE_MAX_BYTES) throw new Error('ZIP 文件最多 50 MiB');
    let declared = 0,
      count = 0;
    const seen = new Set<string>();
    const entries = unzipSync(readFileSync(root), {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        declared += f.originalSize;
        count++;
        if (declared > SITE_MAX_BYTES || count > SITE_MAX_FILES)
          throw new Error('ZIP 解压内容超过 2000 个文件或 50 MiB');
        sitePathSchema.parse(f.name);
        if (seen.has(f.name)) throw new Error('ZIP 中存在重复路径');
        seen.add(f.name);
        return true;
      },
    });
    for (const [path, content] of Object.entries(entries)) add(path, content);
  } else throw new Error('请指定静态目录或 ZIP 文件');
  if (!files.some((f) => f.path === 'index.html')) throw new Error('目录或 ZIP 根目录必须包含 index.html');
  return files;
}

export async function runFolioTool(name: FolioToolName, args: Record<string, unknown>) {
  const req = folioToolRequest(name, args);
  const result = await Api.fromSaved().request(req.method, req.path, req.body, req.headers);
  console.log(JSON.stringify(result, null, 2));
}
export async function folioPush(folio: string, directory: string, opts: { message?: string; resume?: string; fresh?: boolean }) {
  const api = Api.fromSaved();
  const files = collectFolioFiles(directory);
  const key = createHash('sha256').update(`${api.serverUrl}:${folio}:${folioManifestKey(files)}:${opts.message ?? ''}`).digest('hex');
  const stateDir = join(homedir(), '.eat', 'folio-uploads');
  const stateFile = join(stateDir, key + '.json');
  let saved: { requestId: string; sessionId?: string } = { requestId: randomUUID() };
  if (!opts.fresh && existsSync(stateFile)) saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (opts.resume) saved.sessionId = opts.resume;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, JSON.stringify(saved), { mode: 0o600 });
  const result = await uploadFolioFiles((...args) => api.request(...args), folio, files, {
    ...saved, message: opts.message,
    onSession: (id) => {
      saved.sessionId = id;
      writeFileSync(stateFile, JSON.stringify(saved), { mode: 0o600 });
      console.error(`上传会话 ${id}；中断后重跑同一命令继续，或使用 --resume ${id}`);
    },
    onProgress: (message) => console.error(message),
  });
  rmSync(stateFile, { force: true });
  console.log(`已发布 v${result.number}：${result.url}`);
  if (result.share) {
    console.log(`免输密码链接：${result.share.url}`);
    console.log(`链接有效期：${result.share.expiresInDays} 天；修改密码或访问方式后失效。`);
  }
  return result;
}
export function folioComment(
  folio: string,
  content: string,
  opts: {
    versionId: string;
    page?: string;
    thread?: string;
    mention?: string[];
    anchor?: string;
    accessToken?: string;
  },
) {
  const body = {
    folio,
    content,
    versionId: opts.versionId,
    mentions: opts.mention ?? [],
    accessToken: opts.accessToken,
  };
  return runFolioTool(
    opts.thread ? 'reply_folio_comment' : 'create_folio_comment',
    opts.thread
      ? { ...body, threadId: opts.thread }
      : { ...body, page: opts.page ?? '/', anchor: opts.anchor ? JSON.parse(opts.anchor) : { type: 'page' } },
  );
}

export function registerFolioCommands(program: Command): void {
  const folio = program.command('folio').description('Folio：无需审批发布、版本、访问控制与评论');
  folio
    .command('list')
    .description('列出 Folio')
    .action(() => runFolioTool('list_folios', {}));
  folio
    .command('create <slug>')
    .description('创建 Folio 并分配域名，默认仅登录用户可访问')
    .option('--name <name>', 'Folio 名称，默认同 slug')
    .option('--description <text>', '说明')
    .option('--access <mode>', 'authenticated / public / password', 'authenticated')
    .option('--password <password>', 'Folio 访问密码；密码访问时省略则自动生成随机密码')
    .option('--spa', '启用 SPA 路由回退')
    .action((slug, o) => runFolioTool('create_folio', { ...o, slug, name: o.name ?? slug }));
  folio
    .command('update <folio>')
    .description('更新 Folio 设置；修改密码使旧免输密码链接失效')
    .option('--name <name>', 'Folio 名称')
    .option('--description <text>', '说明')
    .option('--access <mode>', 'authenticated / public / password')
    .option('--password <password>', '新访问密码；省略则保留已有密码，无密码时自动生成')
    .option('--spa', '启用 SPA')
    .option('--no-spa', '关闭 SPA')
    .action((folio, o) => runFolioTool('update_folio', { ...o, folio }));
  folio
    .command('delete <folio>')
    .description('永久删除 Folio、全部历史版本和评论，链接立即失效，无法恢复；仅所有者或管理员可操作')
    .action((folio) => runFolioTool('delete_folio', { folio }));
  folio
    .command('push <folio> <directory-or-zip>')
    .description('上传静态目录或 ZIP 并保留历史版本；密码访问时输出免输密码链接及有效期')
    .option('-m, --message <text>', '版本说明')
    .option('--resume <upload-id>', '恢复指定上传会话，需选择相同内容')
    .option('--fresh', '放弃本地恢复记录，开始新的发布')
    .action(async (folio, directory, opts) => { await folioPush(folio, directory, opts); });
  folio
    .command('versions <folio>')
    .description('列出历史版本及固定访问地址')
    .option('--access-token <token>', '密码验证返回的 Folio 访问凭据')
    .action((folio, o) => runFolioTool('list_folio_versions', { folio, ...o }));
  folio
    .command('activate <folio> <version-id>')
    .description('切换当前版本，可用于回滚')
    .action((folio, versionId) => runFolioTool('activate_folio_version', { folio, versionId }));
  folio
    .command('share <folio>')
    .description('生成免输密码访问链接')
    .action((folio) => runFolioTool('create_folio_share_link', { folio }));
  folio
    .command('unlock <folio> <password>')
    .description('验证 Folio 密码，获取仅限该 Folio 的 accessToken')
    .action((folio, password) => runFolioTool('unlock_folio', { folio, password }));
  folio
    .command('comments <folio>')
    .description('读取讨论和回复，每条评论带浏览版本')
    .option('--page <path>', '页面标识')
    .option('--version-id <id>', '讨论发起版本')
    .option('--status <status>', 'open / resolved')
    .option('--access-token <token>', 'Folio 访问凭据')
    .action((folio, o) => runFolioTool('list_folio_comments', { folio, ...o }));
  folio
    .command('comment <folio> <content>')
    .description('创建评论，或通过 --thread 回复已有讨论')
    .requiredOption('--version-id <id>', '实际浏览的版本 ID')
    .option('--page <path>', '页面标识，默认 /')
    .option('--thread <id>', '回复的讨论 ID')
    .option('--anchor <json>', '元素或区域锚点 JSON')
    .option('--mention <user-id...>', '@ 的用户 ID')
    .option('--access-token <token>', 'Folio 访问凭据')
    .action(folioComment);
  folio
    .command('delete-comment <folio> <comment-id>')
    .description('删除一条评论或回复，仅作者、Folio 所有者或管理员可操作，不影响其他人的回复')
    .option('--access-token <token>', 'Folio 访问凭据')
    .action((folio, commentId, o) => runFolioTool('delete_folio_comment', { folio, commentId, ...o }));
  folio
    .command('resolve <folio> <thread-id>')
    .description('标记讨论已解决')
    .option('--reopen', '重新打开')
    .option('--access-token <token>', 'Folio 访问凭据')
    .action((folio, threadId, o) =>
      runFolioTool('set_folio_thread_status', {
        folio,
        threadId,
        status: o.reopen ? 'open' : 'resolved',
        accessToken: o.accessToken,
      }),
    );
  folio
    .command('mention-users <folio>')
    .description('列出可 @ 的用户及 ID')
    .option('--access-token <token>', 'Folio 访问凭据')
    .action((folio, o) => runFolioTool('list_folio_mention_users', { folio, ...o }));
}
