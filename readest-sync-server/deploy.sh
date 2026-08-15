#!/usr/bin/env bash
#
# Readest Sync Server 一键部署脚本
# 用法: ./deploy.sh
# 前置: 已在 readest-sync-server 目录下，且已配置好 .env
#
set -euo pipefail

cd "$(dirname "$0")"

SERVICE="app"
IMAGE_NAME="readest-sync-server-app"

echo "==> [1/4] 拉取最新代码 (git pull)"
# 优先用原生 remote，失败则走国内镜像代理回退
if ! git pull; then
  echo "    原生 git pull 失败，尝试通过 ghproxy 镜像拉取..."
  ORIGIN_URL="$(git remote get-url origin)"
  if [[ "$ORIGIN_URL" == https://github.com/* ]]; then
    MIRROR_URL="https://ghproxy.com/${ORIGIN_URL}"
    git pull "$MIRROR_URL" "$(git rev-parse --abbrev-ref HEAD)"
  else
    echo "    非 github.com 源，无法走镜像，请手动解决网络问题。" >&2
    exit 1
  fi
fi

echo "==> [2/4] 重新构建镜像 (docker compose build)"
docker compose build --no-cache "$SERVICE"

echo "==> [3/4] 停止并重建容器"
docker compose up -d --force-recreate "$SERVICE"

echo "==> [4/4] 等待启动并查看日志"
sleep 3
if command -v docker >/dev/null 2>&1; then
  CONTAINER_ID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
  if [[ -n "$CONTAINER_ID" ]]; then
    docker logs --tail 50 -f "$CONTAINER_ID" &
    LOG_PID=$!
    # 5 秒后自动停止跟踪日志（避免脚本一直阻塞）
    sleep 5
    kill "$LOG_PID" 2>/dev/null || true
  fi
fi

echo ""
echo "==> 部署完成。容器状态:"
docker compose ps "$SERVICE"
