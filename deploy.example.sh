#!/bin/sh
# 发布示例：把 server/ 传到服务器的 releases/<时间>，沿用 shared/ 里的 .env 和 data，切换 current 后重建容器。
# 用法：HOST=<ssh 主机> APP=/opt/apps/pp-health-book sh deploy.example.sh
set -e
cd "$(dirname "$0")"
: "${HOST:?请设置 HOST}" "${APP:=/opt/apps/pp-health-book}"
R=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "set -e; mkdir -p $APP/releases/$R/public $APP/shared/data; cd $APP/releases/$R; ln -sfn $APP/shared/.env .env; ln -sfn $APP/shared/data data"
scp -q server/server.js server/Dockerfile server/docker-compose.yml "$HOST:$APP/releases/$R/"
scp -q server/public/index.html "$HOST:$APP/releases/$R/public/index.html"
ssh "$HOST" "set -e; cd $APP; ln -sfn $APP/releases/$R current.new; mv -T current.new current; cd current; docker compose up -d --build; sleep 5; curl -s 127.0.0.1:3100/health; echo"
echo "已发布 releases/$R"
