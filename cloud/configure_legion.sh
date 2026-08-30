#!/usr/bin/env bash
set -euo pipefail

key_file=".radar_legion_key"
if [[ ! -f "$key_file" ]]; then
  api_key="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  printf 'export RADAR_API_KEY=%q\n' "$api_key" > "$key_file"
  chmod 600 "$key_file"
fi

source "$key_file"
echo "素材雷达模型地址：http://localhost:8000"
echo "连接密码：${RADAR_API_KEY}"
echo "请把这两个值填到素材雷达右上角的模型设置中。"
