#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .venv/bin/activate ]]; then
  echo "还没有安装环境，请先运行：bash install_legion.sh"
  exit 1
fi

source .venv/bin/activate
if [[ -f .radar_legion_key ]]; then
  source .radar_legion_key
fi
export WEMM_MODEL="${WEMM_MODEL:-tencent/WeMM-Embedding-2B}"
export WEMM_LOW_VRAM="${WEMM_LOW_VRAM:-1}"
export WEMM_IMAGE_MAX_PIXELS="${WEMM_IMAGE_MAX_PIXELS:-262144}"
export WEMM_VIDEO_MAX_PIXELS="${WEMM_VIDEO_MAX_PIXELS:-147456}"
export WEMM_VIDEO_MAX_FRAMES="${WEMM_VIDEO_MAX_FRAMES:-24}"
export WEMM_VIDEO_FPS="${WEMM_VIDEO_FPS:-1.0}"

if [[ -z "${RADAR_API_KEY:-}" ]]; then
  echo "还没有生成连接密码，请先运行：bash configure_legion.sh"
  exit 1
fi

echo "正在加载 ${WEMM_MODEL}，第一次会下载数 GB 模型文件，请耐心等待。"
python -m uvicorn wemm_api:app --host 0.0.0.0 --port 8000
