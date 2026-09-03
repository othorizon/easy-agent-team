# 演示数据与截图 / 录屏工具

README 里的界面截图与命令行录屏由这里的脚本生成。原则只有一条：**画面里的东西必须是真的**——
数据通过平台自己的 HTTP API 写入（版本号、审计、授权、真实建库都由服务端逻辑产生），
命令行录屏是把命令真跑一遍录下来的，输出一个字都没改。

| 文件 | 作用 |
|---|---|
| `seed-demo.mjs` | 造演示数据：用户、环境变量、Skill、MCP、角色模板、求助与经验、数据库分配、平台设置 |
| `seed-demo-apps.mjs` | 部署托管部分：配好部署后台接入，并以成员身份自助创建两个应用 |
| `serve-demo-repos.mjs` | 起一台 smart HTTP 的 Git 服务，提供两个能真的构建成功的演示仓库 |
| `casts.mjs` | 录屏脚本：每条 step 是一条真实执行的命令 |
| `record-cli.mjs` | 执行 `casts.mjs` 并按时间戳记录输出 → cast JSON |
| `render-cast.mjs` + `gif.py` | 把 cast JSON 渲染成终端窗口样式的 GIF |
| `capture-web.mjs` | Playwright 截控制台的图 |

依赖：`playwright`（可只装在全局，脚本用 `NODE_PATH=$(npm root -g)` 拿全局那份）、`pillow`（`pip3 install pillow`）。

## 完整重跑一遍

下面这套在 Claude Code 云端会话里验证过。端口安排：部署后台（Dokploy）占 3000，
平台走 80（为了让录屏里的地址是 `http://eat.internal.example.com` 而不是带端口的 localhost），
演示 Git 服务 8088，PostgreSQL 5433。

```bash
# 0. 基础设施
scripts/dev-db.sh start                    # 平台自己的库
scripts/dev-dokploy.sh start               # 真机 Dokploy（云端会话内自建）
echo "127.0.0.1 eat.internal.example.com" >> /etc/hosts
docker service update --host-add git.internal.example.com:172.17.0.1 dokploy
docker pull node:22-alpine                 # 构建时 buildkit 不走代理，基础镜像先拉到本地

# 1. 演示 Git 仓库（smart HTTP，必须能 shallow clone）
node scripts/demo/serve-demo-repos.mjs &

# 2. 平台
pnpm build && pnpm db:migrate && pnpm db:seed
PORT=80 EAT_PUBLIC_URL=http://eat.internal.example.com node apps/server/dist/main.js &

# 3. 演示数据
export EAT_SERVER=http://eat.internal.example.com
node scripts/demo/seed-demo.mjs
DOKPLOY_API=http://127.0.0.1:3000/api DOKPLOY_TOKEN=$(scripts/dev-dokploy.sh key) \
  node scripts/demo/seed-demo-apps.mjs

# 4. 演示成员的 HOME 与工作目录（录屏里的路径就是它们）
mkdir -p /home/sunhao/work /home/wumin/work
git clone http://127.0.0.1:8088/crm-dashboard.git /home/sunhao/work/crm-dashboard
printf 'eat(){ node %s/apps/cli/dist/index.js "$@"; }\n' "$PWD" # 或把 eat 放进 PATH

# 5. 录屏 → GIF（有先后依赖，按这个顺序）
node scripts/demo/record-cli.mjs onboard permissions ask deploy-gate deploy-fail deploy-ok
NODE_PATH=$(npm root -g) node scripts/demo/render-cast.mjs

# 6. 截图（放在最后，这时应用已经有真实的部署历史了）
NODE_PATH=$(npm root -g) node scripts/demo/capture-web.mjs
```

演示账号：管理员 `admin@example.com / admin12345`，其余成员统一 `demo12345`。

## 几个必须知道的坑

- **录屏有先后顺序**：`onboard` 负责登录（后面的 cast 用它留下的凭证）；`deploy-fail`
  要求演示仓库的 HEAD 停在那个「跑不起来」的提交上，`deploy-ok` 里的 `git revert` 才有东西可 revert。
  重录之前先把工作目录复位（cast 的 `setup.run` 已经带了这几条 git 命令）。
- **Git 服务必须是 smart HTTP**：静态文件服务的 dumb HTTP 不支持 shallow，部署后台的
  `git clone --depth 1` 会直接报错；而地址又必须是 http(s) 形式——Dokploy 把非 http 的地址
  （含 `git://`）一律当 SSH 处理，没配 key 就拒绝。
- **基础镜像先 `docker pull`**：容器里的 buildkit 不认代理 CA，直接拉 `node:22-alpine` 会
  报证书错误；本地已有这个镜像就不会去 registry 取了。
- **截图放最后拍**：部署记录、审计、Skill 版本这些都会被前面的步骤改写。
