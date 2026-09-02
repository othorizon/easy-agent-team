#!/usr/bin/env bash
# 【仅用于 Claude Code 云端会话】在容器内起一台真实的 Dokploy，用于 Dokploy API 联调。
# 用法: scripts/dev-dokploy.sh {start|bootstrap|status|key|logs|stop|clean}
#
# 为什么不直接用官方 install.sh（https://dokploy.com/install.sh）：
#   1. 官方脚本用 ss/ip 做端口与网卡探测，云端容器里这两个命令都没有；
#   2. 官方脚本默认建 VIP（IPVS）端点模式的 swarm service，而云端容器内核没有 IPVS
#      （/proc/net/ip_vs 不存在），dokploy 会一直卡在 "Waiting for postgres"——
#      必须用 --endpoint-mode dnsrr（官方脚本的 ENDPOINT_MODE 环境变量就是干这个的）。
# 本脚本按官方 install.sh 的服务定义逐条复刻，并补上以上两点差异。
#
# 与 scripts/dev-db.sh 的关系：那个起的是平台自己的业务库（5433），跟这里互不相干。
# 端口冲突提醒：Dokploy 与平台 server 默认都占 3000，同时跑请给 server 传 PORT=3001。
set -euo pipefail

DOKPLOY_PORT="${DOKPLOY_PORT:-3000}"
DOKPLOY_IMAGE="${DOKPLOY_IMAGE:-dokploy/dokploy:latest}"
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.6.7}"
# traefik 只有真跑部署（域名路由）时才用得上，纯 API 联调可以 SKIP_TRAEFIK=1 省下 80/443
SKIP_TRAEFIK="${SKIP_TRAEFIK:-0}"
STATE_DIR="${EAT_DOKPLOY_STATE:-/var/lib/eat-dokploy}"
CRED_FILE="$STATE_DIR/credentials.json"
ADMIN_EMAIL="${DOKPLOY_ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${DOKPLOY_ADMIN_PASSWORD:-Admin12345!}"
BASE="http://127.0.0.1:$DOKPLOY_PORT"
CURL=(curl -sS --noproxy '*')

log() { echo "[dev-dokploy] $*"; }
die() { echo "[dev-dokploy] 错误: $*" >&2; exit 1; }

# ---------- docker 守护进程 ----------
# 云端容器默认没起 dockerd（docker CLI 有、socket 没有），但内核允许我们自己拉起来。
# 镜像拉取要走出站代理（代理 CA 已在系统信任库里，不用额外配置）。
# 代理端口每个会话都可能变（容器重建就换一个），daemon.json 里留着旧端口会让
# 镜像拉取报 "proxyconnect ... connection refused"，所以每次都按当前环境重写。
# 返回 0 表示配置有变化。
write_docker_proxy_config() {
  [ -n "${HTTPS_PROXY:-}" ] || return 1
  mkdir -p /etc/docker
  local tmp=/etc/docker/daemon.json.new
  cat > "$tmp" <<EOF
{
  "proxies": {
    "http-proxy": "${HTTP_PROXY:-$HTTPS_PROXY}",
    "https-proxy": "$HTTPS_PROXY",
    "no-proxy": "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  }
}
EOF
  if [ -f /etc/docker/daemon.json ] && cmp -s "$tmp" /etc/docker/daemon.json; then
    rm -f "$tmp"
    return 1
  fi
  mv "$tmp" /etc/docker/daemon.json
  return 0
}

ensure_dockerd() {
  local proxy_changed=0
  if [ "$(id -u)" = "0" ]; then
    write_docker_proxy_config && proxy_changed=1 || true
  fi
  if docker info >/dev/null 2>&1; then
    if [ "$proxy_changed" = "0" ]; then return; fi
    # 代理不是可热加载的配置项，只能重启 dockerd；swarm 状态在磁盘上，服务会自行恢复
    log "出站代理地址变了，重启 dockerd 刷新镜像拉取代理..."
    pkill -x dockerd || true
    for _ in $(seq 1 30); do
      docker info >/dev/null 2>&1 || break
      sleep 1
    done
  fi
  [ "$(id -u)" = "0" ] || die "需要 root 才能启动 dockerd"
  log "启动 dockerd..."
  # 容器网络出站要转发，默认是关的
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  mkdir -p "$STATE_DIR"
  nohup dockerd > "$STATE_DIR/dockerd.log" 2>&1 &
  for _ in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "dockerd 就绪"
      return
    fi
    sleep 2
  done
  die "dockerd 启动超时，见 $STATE_DIR/dockerd.log"
}

ensure_swarm() {
  [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" = "active" ] && return
  local addr
  addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$addr" ] || addr=127.0.0.1
  log "初始化 swarm (advertise-addr=$addr)..."
  docker swarm init --advertise-addr "$addr" >/dev/null
}

# 无 IPVS 的内核（云端容器就是）必须用 dnsrr，否则服务名解析到的 VIP 不通
endpoint_mode_args() {
  [ -e /proc/net/ip_vs ] || echo "--endpoint-mode dnsrr"
}

service_exists() { docker service inspect "$1" >/dev/null 2>&1; }

start() {
  mkdir -p "$STATE_DIR"
  ensure_dockerd
  ensure_swarm

  docker network inspect dokploy-network >/dev/null 2>&1 \
    || docker network create --driver overlay --attachable dokploy-network >/dev/null

  mkdir -p /etc/dokploy && chmod 777 /etc/dokploy

  docker secret inspect dokploy_postgres_password >/dev/null 2>&1 \
    || openssl rand -base64 32 | tr -d "=+/" | cut -c1-32 | docker secret create dokploy_postgres_password - >/dev/null
  docker secret inspect dokploy_auth_secret >/dev/null 2>&1 \
    || openssl rand -hex 32 | docker secret create dokploy_auth_secret - >/dev/null

  local em; em="$(endpoint_mode_args)"
  if [ -n "$em" ]; then log "内核无 IPVS，服务改用 dnsrr 端点模式"; fi

  if ! service_exists dokploy-postgres; then
    log "创建 dokploy-postgres..."
    # shellcheck disable=SC2086
    docker service create --detach \
      --name dokploy-postgres \
      --constraint 'node.role==manager' \
      --network dokploy-network \
      --env POSTGRES_USER=dokploy \
      --env POSTGRES_DB=dokploy \
      --secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
      --env POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
      --mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
      $em postgres:16 >/dev/null
  fi

  if ! service_exists dokploy; then
    log "创建 dokploy（首次要拉镜像，约 1-3 分钟）..."
    # shellcheck disable=SC2086
    docker service create --detach \
      --name dokploy \
      --replicas 1 \
      --network dokploy-network \
      --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
      --mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
      --mount type=volume,source=dokploy,target=/root/.docker \
      --secret source=dokploy_postgres_password,target=/run/secrets/postgres_password \
      --secret source=dokploy_auth_secret,target=/run/secrets/dokploy_auth_secret \
      --publish published="$DOKPLOY_PORT",target=3000,mode=host \
      --update-parallelism 1 --update-order stop-first \
      --constraint 'node.role == manager' \
      $em \
      -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
      -e BETTER_AUTH_SECRET_FILE=/run/secrets/dokploy_auth_secret \
      "$DOKPLOY_IMAGE" >/dev/null
  fi

  if [ "$SKIP_TRAEFIK" != "1" ] && ! docker inspect dokploy-traefik >/dev/null 2>&1; then
    log "启动 dokploy-traefik..."
    docker run -d --name dokploy-traefik --restart always --network dokploy-network \
      -v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
      -v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
      -v /var/run/docker.sock:/var/run/docker.sock:ro \
      -p 80:80/tcp -p 443:443/tcp -p 443:443/udp "$TRAEFIK_IMAGE" >/dev/null
  fi

  # 只探 HTTP 不够：容器起来但 DB 连不上时端口照样有人应答（healthcheck 还没过、
  # 副本仍是 0/1），此时 bootstrap 必然失败。要副本收敛 + 端口有应答两条同时满足。
  log "等待 Dokploy 就绪 $BASE ..."
  for _ in $(seq 1 90); do
    if [ "$(docker service ls --filter name=dokploy --format '{{.Name}} {{.Replicas}}' | awk '$1=="dokploy"{print $2}')" = "1/1" ] \
       && "${CURL[@]}" -o /dev/null "$BASE/api/settings.health" 2>/dev/null; then
      log "Dokploy 已就绪: $BASE"
      return
    fi
    sleep 3
  done
  die "Dokploy 启动超时，用 scripts/dev-dokploy.sh logs 看日志"
}

pg_container() { docker ps -q --filter "name=dokploy-postgres" | head -1; }

# ---------- 建管理员 + 发 API key ----------
# 调 better-auth 的 sign-up/sign-in，取回 session cookie（拿不到就回空串，交给调用方判断）
auth_cookie() {
  "${CURL[@]}" -X POST "$BASE/api/auth/$1" \
    -H 'content-type: application/json' -H "origin: $BASE" -d "$2" -D - -o /dev/null 2>/dev/null \
    | { grep -i '^set-cookie: better-auth.session_token=' || true; } \
    | head -1 | sed 's/^[Ss]et-[Cc]ookie: //; s/;.*//'
}

# Dokploy v0.30 起 API key 走 better-auth 的 apiKey 插件，但服务端校验（validateRequest）
# 额外要求 key 的 metadata.organizationId——不带就一律 401，这是本脚本存在的主要理由。
bootstrap() {
  mkdir -p "$STATE_DIR"
  local cookie
  # 首次注册；邮箱已存在（脚本重跑）时 sign-up 不回 set-cookie，回落到登录
  cookie=$(auth_cookie sign-up/email "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p,name:"admin"}')")
  if [ -z "$cookie" ]; then
    log "账号已存在，改为登录..."
    cookie=$(auth_cookie sign-in/email "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')")
  fi
  [ -n "$cookie" ] || die "登录失败，检查 DOKPLOY_ADMIN_EMAIL / DOKPLOY_ADMIN_PASSWORD"

  local org
  org=$("${CURL[@]}" -H "cookie: $cookie" "$BASE/api/auth/organization/list" | jq -r '.[0].id // empty')
  [ -n "$org" ] || die "拿不到 organizationId"

  local key
  key=$("${CURL[@]}" -X POST "$BASE/api/auth/api-key/create" \
    -H 'content-type: application/json' -H "cookie: $cookie" -H "origin: $BASE" \
    -d "$(jq -nc --arg o "$org" '{name:"eat-dev",prefix:"eat",metadata:{organizationId:$o}}')" \
    | jq -r '.key // empty')
  [ -n "$key" ] || die "创建 API key 失败"

  # better-auth 默认给 key 加 10 次/天 的限流，联调根本不够用；服务端不让从客户端关，直接改库
  local pg; pg="$(pg_container)"
  if [ -n "$pg" ]; then
    docker exec "$pg" psql -U dokploy -d dokploy -q \
      -c "update apikey set rate_limit_enabled=false, remaining=null;" >/dev/null
  fi

  jq -nc --arg url "$BASE/api" --arg key "$key" --arg email "$ADMIN_EMAIL" \
    --arg pw "$ADMIN_PASSWORD" --arg org "$org" \
    '{apiUrl:$url,apiKey:$key,adminEmail:$email,adminPassword:$pw,organizationId:$org}' > "$CRED_FILE"
  chmod 600 "$CRED_FILE"
  log "凭证已写入 $CRED_FILE"
  status
}

status() {
  docker service ls --filter name=dokploy 2>/dev/null || true
  if [ -f "$CRED_FILE" ]; then
    echo
    echo "控制台:      $BASE  ($(jq -r .adminEmail "$CRED_FILE") / $(jq -r .adminPassword "$CRED_FILE"))"
    echo "平台里填:    系统设置 → Dokploy → 地址 $(jq -r .apiUrl "$CRED_FILE")"
    echo "API token:   $(jq -r .apiKey "$CRED_FILE")"
    echo "自测:        curl -H \"x-api-key: \$(scripts/dev-dokploy.sh key)\" $BASE/api/project.all"
  else
    echo "（还没发 API key，跑 scripts/dev-dokploy.sh bootstrap）"
  fi
}

# 删卷前必须等 service 的容器真的退出：容器还在时卷删不掉（-f 也不行），
# 而 secret 里的 postgres 密码是新生成的，留着旧卷下次起来就是 28P01 认证失败。
clean() {
  docker service rm dokploy dokploy-postgres >/dev/null 2>&1 || true
  docker rm -f dokploy-traefik >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    [ -z "$(docker ps -aq --filter name=dokploy 2>/dev/null)" ] && break
    sleep 2
  done
  local left=""
  for v in dokploy dokploy-postgres; do
    docker volume inspect "$v" >/dev/null 2>&1 || continue
    docker volume rm -f "$v" >/dev/null 2>&1 || left="$left $v"
  done
  docker secret rm dokploy_postgres_password dokploy_auth_secret >/dev/null 2>&1 || true
  rm -f "$CRED_FILE"
  if [ -n "$left" ]; then
    die "数据卷$left 没删掉（还被容器占用），别急着 start：残留旧库会让 postgres 认证失败"
  fi
  echo "已清空 Dokploy（含数据卷与凭证）"
}

case "${1:-start}" in
  start)     start
             # 已有凭证就别重发 key（重发不会失效旧的，但 status 里只留最后一把，容易搞混）
             if [ -f "$CRED_FILE" ]; then status; else bootstrap; fi ;;
  bootstrap) bootstrap ;;
  status)    status ;;
  key)       jq -r .apiKey "$CRED_FILE" ;;
  logs)      docker service logs dokploy --tail "${2:-50}" ;;
  stop)      docker service rm dokploy dokploy-postgres 2>/dev/null || true
             docker rm -f dokploy-traefik 2>/dev/null || true
             echo "已停止（数据卷保留，clean 才删）" ;;
  clean)     clean ;;
  *)         die "用法: scripts/dev-dokploy.sh {start|bootstrap|status|key|logs|stop|clean}" ;;
esac
