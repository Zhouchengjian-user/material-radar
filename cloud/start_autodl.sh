#!/usr/bin/env bash
set -euo pipefail

export WEMM_MODEL="${WEMM_MODEL:-tencent/WeMM-Embedding-2B}"
export WEMM_DEVICE="${WEMM_DEVICE:-cuda}"

python -m uvicorn wemm_api:app --host 0.0.0.0 --port 8000

