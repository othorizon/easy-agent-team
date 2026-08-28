# easy-agent-team 平台镜像（NestJS 单体 + 控制台静态文件）
# 构建: docker build -t easy-agent-team .
# 运行: 见 docs/deployment.md（需要 DATABASE_URL / EAT_KEK / EAT_PUBLIC_URL）

# ---------- 构建阶段 ----------
FROM node:22-slim AS builder
WORKDIR /build

# corepack 按 package.json 的 packageManager 字段固定 pnpm 版本
RUN corepack enable

# 先复制清单文件，让依赖安装层可缓存
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
COPY apps/cli apps/cli

# 拓扑序构建：shared → server/web/cli
RUN pnpm build

# 产出 server 的独立运行目录（生产依赖 + workspace 依赖内联 + dist/drizzle）
# --legacy：@eat/shared 以构建产物（dist）被复制内联，无需 inject 模式
RUN pnpm --filter @eat/server deploy --legacy --prod /out/server

# ---------- 运行阶段 ----------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app

# 目录布局需与 server 代码中的相对路径一致：
#   /app/server/dist/main.js 通过 ../../web/dist 找到 /app/web/dist
#   install 模块通过 ../../cli/dist/index.js 找到 CLI 单文件（平台自托管下载）
COPY --from=builder /out/server /app/server
COPY --from=builder /build/apps/web/dist /app/web/dist
COPY --from=builder /build/apps/cli/dist /app/cli/dist
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && chown -R node:node /app
USER node
WORKDIR /app/server

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
