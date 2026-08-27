#!/usr/bin/env bash
# 本地开发用 PostgreSQL 16，无需 Docker。
# 用法: scripts/dev-db.sh {start|stop|status|psql [db]}
# 连接串: postgres://dev@127.0.0.1:5433/eat_dev
set -euo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT="${PGPORT:-5433}"
DBUSER=dev
DBS=(eat_dev eat_test)

# 远程容器以 root 运行，Postgres 拒绝 root：转由 postgres 用户执行，
# 数据目录放 postgres 用户可访问的路径。普通用户（本地开发）直接跑。
if [ "$(id -u)" = "0" ]; then
  RUN=(runuser -u postgres --)
  PGHOME=/var/lib/postgresql
else
  RUN=()
  PGHOME="${XDG_DATA_HOME:-$HOME/.local/share}/eat-pg"
  mkdir -p "$PGHOME"
fi
PGDATA="$PGHOME/eat-data"
LOG="$PGHOME/eat-pg.log"

start() {
  if [ ! -d "$PGDATA" ]; then
    "${RUN[@]}" "$PGBIN/initdb" -D "$PGDATA" -U "$DBUSER" --auth=trust -E UTF8 >/dev/null
  fi
  if ! "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" \
      -o "-k $PGHOME -p $PGPORT -c listen_addresses=127.0.0.1" -l "$LOG" start >/dev/null
  fi
  for db in "${DBS[@]}"; do
    "${RUN[@]}" "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" "$db" 2>/dev/null || true
  done
  echo "PostgreSQL 已就绪: postgres://$DBUSER@127.0.0.1:$PGPORT/eat_dev (测试库 eat_test)"
}

case "${1:-start}" in
  start)  start ;;
  stop)   "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null && echo "已停止" ;;
  status) "${RUN[@]}" "$PGBIN/pg_ctl" -D "$PGDATA" status ;;
  psql)   exec psql -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" "${2:-eat_dev}" ;;
  *)      echo "用法: $0 {start|stop|status|psql [db]}" >&2; exit 1 ;;
esac
