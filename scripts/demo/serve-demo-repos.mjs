#!/usr/bin/env node
/**
 * 演示用的 Git 服务：造两个能真的构建成功的小仓库，并用 smart HTTP 暴露出去。
 *
 * 为什么需要它：截图 / 录屏要展示「自助建应用 → 部署」，部署后台（Dokploy）会在自己的
 * 容器里 `git clone --depth 1`，而云端会话内的容器访问不到公网 Git。所以在宿主机上起一台。
 *
 *   node scripts/demo/serve-demo-repos.mjs            # 默认 0.0.0.0:8088，仓库放 /srv/git
 *   EAT_DEMO_GIT_PORT=9000 EAT_DEMO_GIT_ROOT=/tmp/git node scripts/demo/serve-demo-repos.mjs
 *
 * 两个坑（都踩过）：
 *   1. 必须是 smart HTTP（`git http-backend`）。静态文件服务的 dumb HTTP 不支持 shallow，
 *      部署后台的 `--depth 1` 会直接报 "dumb http transport does not support shallow capabilities"。
 *   2. 仓库地址必须是 http(s) 形式。Dokploy 把非 http 的地址（含 git://）一律当 SSH 处理，
 *      没配 SSH key 就报 "trying to clone a ssh repository without a ssh key"。
 *
 * 容器里要用 `git.internal.example.com` 这样的地址访问宿主机，给部署后台加个 hosts 即可：
 *   docker service update --host-add git.internal.example.com:172.17.0.1 dokploy
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const ROOT = process.env.EAT_DEMO_GIT_ROOT ?? '/srv/git';
const PORT = Number(process.env.EAT_DEMO_GIT_PORT ?? 8088);

const REPOS = {
  'crm-dashboard': [{
    author: '李维 <liwei@example.com>',
    message: '客户看板：本周指标与环比',
    files: {
      'Dockerfile': `FROM node:22-alpine
WORKDIR /app
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
`,
      'server.js': `const http = require('node:http');
const PORT = process.env.PORT || 3000;
const html = \`<!doctype html><meta charset="utf-8"><title>客户看板</title>
<style>body{font:14px/1.6 system-ui;margin:0;padding:48px;background:#fafafa;color:#18181b}
h1{font-size:20px;margin:0 0 4px}p{color:#71717a;margin:0 0 24px}
table{border-collapse:collapse;background:#fff;border:1px solid #e4e4e7;border-radius:8px;overflow:hidden}
th,td{padding:8px 16px;text-align:left;border-bottom:1px solid #f4f4f5}th{background:#f9f9fb;font-weight:600}</style>
<h1>客户看板</h1><p>数据来自 CRM 只读副本，延迟约 5 分钟。</p>
<table><tr><th>指标</th><th>本周</th><th>环比</th></tr>
<tr><td>有效订单</td><td>1,284</td><td>+8.2%</td></tr>
<tr><td>客单价</td><td>￥312.40</td><td>-1.4%</td></tr>
<tr><td>新客</td><td>216</td><td>+12.5%</td></tr></table>\`;
http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(PORT, () => console.log(\`crm-dashboard listening on \${PORT}\`));
`,
      'README.md': `# crm-dashboard

客户看板。指标口径见平台上的 \`crm-data-query\` Skill。
`,
    },
  }, {
    // 故意留个坑：Dockerfile 里 COPY 了仓库里并不存在的文件，构建必挂。
    // 演示「部署失败能在平台里看到真实报错」，以及随后的 git revert。
    author: '孙浩 <sunhao@example.com>',
    message: '改用 package.json 声明依赖',
    files: {
      'Dockerfile': `FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
`,
    },
  }],
  'ops-docs': [{
    author: '周琪 <zhouqi@example.com>',
    message: '运维手册首页',
    files: {
      'public/index.html': `<!doctype html><meta charset="utf-8"><title>运维手册</title>
<style>body{font:15px/1.7 system-ui;max-width:720px;margin:0 auto;padding:56px 24px;color:#18181b}
h1{font-size:22px}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}li{margin:6px 0}</style>
<h1>运维手册</h1>
<p>常用操作与值班流程。CLI 相关命令以 <code>eat --help</code> 为准。</p>
<ul><li>上线：<code>eat deploy</code>（本地检查不过不会触发部署）</li>
<li>看构建失败原因：<code>eat app build-logs &lt;应用&gt;</code></li>
<li>看容器运行日志：<code>eat app run-logs &lt;应用&gt;</code></li></ul>
`,
    },
  }],
};

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
  return r.stdout;
}

function ensureRepos() {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const [name, commits] of Object.entries(REPOS)) {
    const bare = path.join(ROOT, `${name}.git`);
    if (fs.existsSync(bare)) {
      console.log(`= ${bare}`);
      continue;
    }
    const work = path.join(ROOT, 'src', name);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    for (const commit of commits) {
      for (const [rel, content] of Object.entries(commit.files)) {
        fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(work, rel), content);
      }
      const [, authorName, authorEmail] = /^(.*) <(.*)>$/.exec(commit.author);
      git(['add', '-A'], work);
      git(['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-qm', commit.message], work);
    }
    git(['clone', '-q', '--bare', work, bare]);
    // 允许 push：录屏里有 `git revert && git push`，smart HTTP 默认只给读
    git(['config', 'http.receivepack', 'true'], bare);
    console.log(`+ ${bare}（${commits.length} 个提交）`);
  }
}

/** git http-backend 是个 CGI 程序：环境变量进、「头 + 空行 + 体」出 */
function serve() {
  http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const cgi = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: ROOT,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: decodeURIComponent(url.pathname),
          REQUEST_METHOD: req.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: req.headers['content-length'] ?? '',
          REMOTE_ADDR: req.socket.remoteAddress ?? '',
        },
      });
      req.pipe(cgi.stdin);
      let buf = Buffer.alloc(0);
      let headersDone = false;
      cgi.stdout.on('data', (chunk) => {
        if (headersDone) {
          res.write(chunk);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        const split = buf.indexOf('\r\n\r\n');
        if (split === -1) return;
        headersDone = true;
        const headers = {};
        let status = 200;
        for (const line of buf.subarray(0, split).toString('utf8').split('\r\n')) {
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').trim();
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10) || 200;
          else if (k) headers[k] = v;
        }
        res.writeHead(status, headers);
        res.write(buf.subarray(split + 4));
      });
      cgi.stdout.on('end', () => {
        if (!headersDone) res.writeHead(500);
        res.end();
      });
      cgi.stderr.on('data', (d) => process.stderr.write(`[http-backend] ${d}`));
    })
    .listen(PORT, '0.0.0.0', () => console.log(`\ngit smart HTTP: http://0.0.0.0:${PORT}/<repo>.git`));
}

ensureRepos();
serve();
