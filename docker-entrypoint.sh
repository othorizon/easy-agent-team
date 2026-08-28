#!/bin/sh
# 启动序：迁移（幂等）→ 种子（幂等，已存在则跳过）→ 启动服务
set -e

echo "[entrypoint] 执行数据库迁移..."
node dist/db/migrate.js

if [ "${EAT_SKIP_SEED:-0}" != "1" ]; then
  echo "[entrypoint] 执行种子（初始管理员，幂等）..."
  node dist/db/seed.js
fi

echo "[entrypoint] 启动平台..."
exec node dist/main.js
