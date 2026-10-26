# 应用、部署与日志

平台里的「应用」= 一个 Git 仓库 + 一种构建方式 + 一套 env，由平台托管构建与部署。拉取私有仓库的凭证、部署落点这些底层配置由管理员预先配好，你不需要、也无法直接操作部署后台，一切都通过下面的命令 / 工具完成。

**创建应用**：`eat app create <slug> --repo <git 地址> --build dockerfile|static`（MCP: `create_app`）。平台会建好应用并配好 Git 源与构建方式。构建方式只有两种：`dockerfile`（按仓库里的 Dockerfile 构建，可用 `--dockerfile` / `--context` 指定路径与上下文）和 `static`（静态托管：**不跑任何构建命令**，把 `--publish-dir` 目录原样交给 nginx，仓库里必须直接有产物；前端路由用 `--spa`）。要先 build 再托管产物的一律选 dockerfile。之后用 `eat app update <slug> ...`（MCP: `update_app`）改配置，下次部署生效。

**域名**：管理员配置了自动域名后缀时，创建结果里会带 `domain` / `url`（`<slug>.<后缀>`，`eat app show` / `list_apps` 也能看到），把访问地址告诉用户；结果里 `url` 为 null 说明平台没开自动域名，要域名找管理员。dockerfile 应用用 `--port`（MCP: `port`，默认 3000）声明容器监听的端口——域名流量转发到它，填错了页面打不开；static 固定转发到 80，不用填。

**首次部署需要管理员授权一次**：新建的应用 `deployApproved=false`，部署会返回 `DEPLOY_NOT_APPROVED`——创建时已自动提交审批，告诉用户由管理员在控制台「权限申请」中批准，**不要反复重试**。用 `eat requests list --type app` 查询进度和驳回原因。授权绑定当前仓库，更换仓库重新审批，更换分支无需重审；撤销后由应用 owner 显式重新申请。

**应用 env**：`eat app env pull <slug>` / `eat app env push <slug> --file .env`（MCP: `get_app_env` / `set_app_env`）读写应用的运行时 env；加 `--build`（MCP: `target=build`）是构建时变量（Dockerfile 里以 ARG 取用）。**推送是整体覆盖不是合并**：先 pull 再改再 push，否则没带上的变量会被删掉。pull 遇到不是 eat 写的同名文件时会中止，按提示用 `--out` / `--print`，别无脑 `--force`；按需读取的配置与权限申请见[环境变量流程](environment.md)。值可能是密钥，只用于当前任务、不写进代码或对话。

**部署**：`eat deploy [slug]`（MCP: `trigger_deploy`）。构建源是应用绑定的 Git 仓库与分支，不是你本地的工作区——**要部署的改动先提交并推送**，否则部署出去的还是旧代码。应用运行要用的密钥放进应用 env（`eat app env push`），不要写进代码或提交进仓库。

部署完是否成功、失败在哪，按这个顺序查，不要让用户自己去翻部署后台：

1. `eat app status <slug>`（MCP: `get_deploy_status`）——失败时 `error` 里已经带着构建日志末尾的真实报错；
2. `eat app build-logs <slug>`（MCP: `get_build_logs`）——**构建**日志，依赖装不上、编译报错、镜像拉不动看这里；
3. `eat app run-logs <slug>`（MCP: `get_run_logs`）——**运行**日志，构建成功但服务不正常（进程起不来、接口 500、连不上依赖）看这里。

日志读到的报错是排查依据，改完代码重新 `eat deploy` 即可；日志可能带出构建期注入的密钥，不要把整段日志贴进求助或提交里。

**停止部署**：部署了错的分支、发现改动有问题，或排了一串不需要的部署时，用 `eat app stop-build <slug>`（CLI 与控制台「部署记录」页可用，MCP 暂无对应工具）——正在构建的会被中断、排队中的会被撤下，**已上线的版本不受影响**，被停掉的部署状态显示为 `cancelled`。命令要等构建真正停下，可能十几秒才返回；回报「构建还没停下」时稍后用 `eat app status` 再看，别连续重试。部署后台此刻还有其他应用在构建时会被拒绝（`DEPLOY_BACKEND_BUSY`：中断操作会波及它们），等一会儿再试或找管理员。

部署状态与历史实时来自部署后台：`status` 取值是 `queued`(排队中) / `running`(构建中) / `done`(成功) / `error`(失败) / `cancelled`(已取消，含在平台上被手动停止的，`platform.stoppedByName` 是谁停的) / `archived`(构建记录已被清理)。`eat app deployments <slug>` 列出的是还保留着的最近 10 次构建——**其中可能有绕开平台、在部署后台直接触发的部署**（`platform` 为 null），也可能有别人从控制台按钮或远程 MCP 触发的部署（`platform.source=console` 或 `remote`），排查问题时要把它们算进来；加 `--all` 看平台侧的完整历史。
