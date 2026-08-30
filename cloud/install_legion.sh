#!/usr/bin/env bash
set -euo pipefail

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "没有检测到 nvidia-smi。请先在 Windows 更新 NVIDIA 驱动并执行 wsl --update。"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y python3-venv python3-pip ffmpeg

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install \
  torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 \
  --index-url https://download.pytorch.org/whl/cu128
python -m pip install -r requirements.txt
python verify_gpu.py

echo
echo "环境安装完成。下一步运行：bash start_legion.sh"
