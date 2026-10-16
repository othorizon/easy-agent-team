import type { Command } from 'commander';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  SITE_MAX_BYTES,
  SITE_MAX_FILES,
  siteFileSchema,
  siteToolRequest,
  type SiteFile,
  type SiteToolName,
} from '@eat/shared';
import { Api } from '../client.js';

export function collectSiteFiles(input: string): SiteFile[] {
  const root = resolve(input);
  const stat = lstatSync(root);
  const files: SiteFile[] = [];
  let total = 0;
  const add = (path: string, content: Uint8Array) => {
    total += content.length;
    if (total > SITE_MAX_BYTES || files.length >= SITE_MAX_FILES) throw new Error('发布最多 2000 个文件、50 MiB');
    files.push(siteFileSchema.parse({ path, content: Buffer.from(content).toString('base64'), encoding: 'base64' }));
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
    const entries = unzipSync(readFileSync(root), {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        declared += f.originalSize;
        count++;
        if (declared > SITE_MAX_BYTES || count > SITE_MAX_FILES)
          throw new Error('ZIP 解压内容超过 2000 个文件或 50 MiB');
        siteFileSchema.shape.path.parse(f.name);
        return true;
      },
    });
    for (const [path, content] of Object.entries(entries)) add(path, content);
  } else throw new Error('请指定静态目录或 ZIP 文件');
  if (!files.some((f) => f.path === 'index.html')) throw new Error('目录或 ZIP 根目录必须包含 index.html');
  return files;
}

export async function runSiteTool(name: SiteToolName, args: Record<string, unknown>) {
  const req = siteToolRequest(name, args);
  const result = await Api.fromSaved().request(req.method, req.path, req.body, req.headers);
  console.log(JSON.stringify(result, null, 2));
}
export async function sitePush(site: string, directory: string, opts: { message?: string }) {
  return runSiteTool('publish_site', { site, files: collectSiteFiles(directory), message: opts.message ?? '' });
}
export function siteComment(
  site: string,
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
    site,
    content,
    versionId: opts.versionId,
    mentions: opts.mention ?? [],
    accessToken: opts.accessToken,
  };
  return runSiteTool(
    opts.thread ? 'reply_site_comment' : 'create_site_comment',
    opts.thread
      ? { ...body, threadId: opts.thread }
      : { ...body, page: opts.page ?? '/', anchor: opts.anchor ? JSON.parse(opts.anchor) : { type: 'page' } },
  );
}

export function registerSiteCommands(program: Command): void {
  const site = program.command('site').description('页面：无需审批发布、版本、访问控制与评论');
  site
    .command('list')
    .description('列出页面')
    .action(() => runSiteTool('list_sites', {}));
  site
    .command('create <slug>')
    .description('创建页面并分配域名，默认仅登录用户可访问')
    .option('--name <name>', '页面名称，默认同 slug')
    .option('--description <text>', '说明')
    .option('--access <mode>', 'authenticated / public / password', 'authenticated')
    .option('--password <password>', '页面访问密码')
    .option('--spa', '启用 SPA 路由回退')
    .action((slug, o) => runSiteTool('create_site', { ...o, slug, name: o.name ?? slug }));
  site
    .command('update <site>')
    .description('更新页面设置；修改密码使旧免输密码链接失效')
    .option('--name <name>', '页面名称')
    .option('--description <text>', '说明')
    .option('--access <mode>', 'authenticated / public / password')
    .option('--password <password>', '新访问密码')
    .option('--spa', '启用 SPA')
    .option('--no-spa', '关闭 SPA')
    .action((site, o) => runSiteTool('update_site', { ...o, site }));
  site
    .command('push <site> <directory-or-zip>')
    .description('上传构建好的静态目录或 ZIP，发布并保留完整历史版本')
    .option('-m, --message <text>', '版本说明')
    .action(sitePush);
  site
    .command('versions <site>')
    .description('列出历史版本及固定访问地址')
    .option('--access-token <token>', '密码验证返回的页面访问凭据')
    .action((site, o) => runSiteTool('list_site_versions', { site, ...o }));
  site
    .command('activate <site> <version-id>')
    .description('切换当前版本，可用于回滚')
    .action((site, versionId) => runSiteTool('activate_site_version', { site, versionId }));
  site
    .command('share <site>')
    .description('生成免输密码访问链接')
    .action((site) => runSiteTool('create_site_share_link', { site }));
  site
    .command('unlock <site> <password>')
    .description('验证页面密码，获取仅限该页面的 accessToken')
    .action((site, password) => runSiteTool('unlock_site', { site, password }));
  site
    .command('comments <site>')
    .description('读取讨论和回复，每条评论带浏览版本')
    .option('--page <path>', '页面标识')
    .option('--version-id <id>', '讨论发起版本')
    .option('--status <status>', 'open / resolved')
    .option('--access-token <token>', '页面访问凭据')
    .action((site, o) => runSiteTool('list_site_comments', { site, ...o }));
  site
    .command('comment <site> <content>')
    .description('创建评论，或通过 --thread 回复已有讨论')
    .requiredOption('--version-id <id>', '实际浏览的版本 ID')
    .option('--page <path>', '页面标识，默认 /')
    .option('--thread <id>', '回复的讨论 ID')
    .option('--anchor <json>', '元素或区域锚点 JSON')
    .option('--mention <user-id...>', '@ 的用户 ID')
    .option('--access-token <token>', '页面访问凭据')
    .action(siteComment);
  site
    .command('delete-comment <site> <comment-id>')
    .description('删除一条评论或回复，仅作者、页面所有者或管理员可操作，不影响其他人的回复')
    .option('--access-token <token>', '页面访问凭据')
    .action((site, commentId, o) => runSiteTool('delete_site_comment', { site, commentId, ...o }));
  site
    .command('resolve <site> <thread-id>')
    .description('标记讨论已解决')
    .option('--reopen', '重新打开')
    .option('--access-token <token>', '页面访问凭据')
    .action((site, threadId, o) =>
      runSiteTool('set_site_thread_status', {
        site,
        threadId,
        status: o.reopen ? 'open' : 'resolved',
        accessToken: o.accessToken,
      }),
    );
  site
    .command('mention-users <site>')
    .description('列出可 @ 的用户及 ID')
    .option('--access-token <token>', '页面访问凭据')
    .action((site, o) => runSiteTool('list_site_mention_users', { site, ...o }));
}
