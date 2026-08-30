# 给拯救者 Pi Agent 的完整提示词

请在我这台联想拯救者的 VS Code 中直接完成下面任务。你运行在 Windows 11 的 WSL2 Ubuntu 24.04 中，硬件为 Ryzen 9、32GB 内存、RTX 5060 Laptop 8GB，CUDA 12.8。现有腾讯 `tencent/WeMM-Embedding-2B` 已经能够通过 FastAPI 在 `8000` 端口运行，使用 8 位低显存模式。现有项目大概率在 `~/wemm-radar/cloud`，但不要直接假设路径，先搜索确认。

## 最终目标

在不破坏现有 WeMM 服务的前提下，一次性安装并验证以下能力：

1. PySceneDetect：检测视频镜头和转场，不使用 GPU。
2. SenseVoiceSmall：在 CPU 上识别中文、英文、粤语台词，并尽量返回句子时间码、语言、情绪和声音事件。
3. PaddleOCR：使用 PP-OCRv5 Mobile 的检测与识别模型，在 CPU 上识别关键帧中的中文和英文文字。
4. 建立一个独立的媒体分析服务，供 Mac 上的素材雷达以后调用。

本阶段不要安装 Qwen3-VL-Reranker，也不要更换 WeMM-2B、CUDA 或 PyTorch。Qwen 精排不是本次任务。

## 第一部分：只读检查

先运行只读检查并把结果总结给我：

- `nvidia-smi`
- `python3 --version`
- `df -h`
- `free -h`
- 搜索现有 `start_legion.sh`、`wemm_api.py`、`.radar_legion_key` 和 `.venv`
- 检查 `http://localhost:8000/health`，如果需要 API 密钥，从现有 `.radar_legion_key` 在本机加载，但不要把完整密钥输出到聊天、日志或公开文件
- 记录现有 WeMM 虚拟环境中的 `pip freeze`

确认现有项目路径后再继续。不要把新依赖安装进现有 WeMM 的 `.venv`，因为 WeMM 锁定使用 `transformers==5.2.0`、CUDA 12.8 版 PyTorch 和 bitsandbytes，不能被 FunASR 或 PaddleOCR 改坏。

## 第二部分：备份与目录

在现有 `cloud` 目录旁创建带日期时间的可恢复备份，只备份脚本、Python 文件和 requirements，不复制模型缓存和视频素材。保留：

- `.radar_legion_key`
- WeMM `.venv`
- Hugging Face / ModelScope 模型缓存
- 当前可工作的 `wemm_api.py`、`start_legion.sh` 和配置脚本

严禁使用 `rm -rf`、`git reset --hard` 或覆盖已有可工作文件。任何修改都先生成 `.bak` 或进入新目录。

建议创建：

```text
~/wemm-radar/cloud/media_tools/
  .venv/
  media_api.py
  analyzers/
  tests/
  start_media_tools.sh
  verify_media_tools.sh
  requirements.lock.txt
```

如果 FunASR、PaddlePaddle 和 OpenCV 在同一虚拟环境发生不可解决的依赖冲突，可以拆成 `.venv-asr`、`.venv-ocr`、`.venv-scene`，再由一个轻量 API 服务通过子进程调用。优先保证隔离和可恢复，不要为了少一个虚拟环境破坏 WeMM。

## 第三部分：安装要求

### PySceneDetect

- 安装稳定版 `scenedetect-headless`。
- 使用 `AdaptiveDetector` 作为默认检测方式，并保留调整阈值和最短镜头长度的配置。
- 返回每个镜头的 `start`、`end` 和中间关键帧时间。
- 短视频或检测不到转场时，自动回退到完整视频或原来的 5–8 秒滑动切片。

### SenseVoiceSmall

- 使用官方 `FunAudioLLM/SenseVoiceSmall`。
- 优先使用 CPU / ONNX / 官方轻量运行方式，不与 WeMM 同时占用 RTX 5060 的 8GB 显存。
- 支持长视频时先用 FFmpeg 提取 16kHz 单声道音频。
- 尽量启用 VAD、标点和 CTC 时间对齐；如果当前官方版本的时间对齐接口不同，查阅当前官方文档后实现，不要编造参数。
- 输出句子级 `start`、`end`、`text`；可以获得时再加入 `language`、`emotion`、`event`。
- 没有音轨时返回空数组，不算失败。

### PaddleOCR

- 使用 CPU 版 PaddlePaddle。
- 使用 `PP-OCRv5_mobile_det` 和 `PP-OCRv5_mobile_rec`，关闭不需要的文档矫正和方向模型。
- 只分析镜头的开始、中间或代表性关键帧，不逐帧 OCR。
- 输出 `time`、`text`、`confidence` 和可用时的文字框坐标。
- 对相邻镜头重复出现的字幕进行去重，但保留第一次和最后一次出现的时间。

安装完成后生成锁定版本文件，记录实际安装成功的精确版本。不要仅仅显示 `pip install` 成功，必须运行真实导入和推理测试。

## 第四部分：媒体分析 API

建立独立 FastAPI 服务，默认监听 `0.0.0.0:8001`，不要占用 WeMM 的 `8000` 端口。复用现有 `.radar_legion_key` 中的 `RADAR_API_KEY` 进行 Bearer 鉴权，但不要复制或打印密钥。

至少提供：

```text
GET  /health
POST /analyze-video
```

`GET /health` 返回类似：

```json
{
  "ok": true,
  "scene": true,
  "asr": true,
  "ocr": true,
  "device": {
    "wemm": "cuda",
    "mediaTools": "cpu"
  },
  "models": {
    "asr": "FunAudioLLM/SenseVoiceSmall",
    "ocr": "PP-OCRv5-mobile"
  }
}
```

`POST /analyze-video` 接收原始视频流或 multipart 视频文件，限制最大文件体积，使用临时目录，任务结束或报错后必须删除临时视频、音频和关键帧。返回结构至少包括：

```json
{
  "duration": 0,
  "scenes": [
    {"start": 0, "end": 6.2, "keyframe": 3.1}
  ],
  "transcript": [
    {"start": 0.4, "end": 2.8, "text": "示例台词", "language": "zh"}
  ],
  "ocr": [
    {"time": 3.1, "text": "示例字幕", "confidence": 0.96}
  ],
  "warnings": []
}
```

要求：

- 单机默认只允许一个媒体分析任务并发，避免 32GB 内存被耗尽。
- 任何一个子能力失败时，其他结果仍应返回，并在 `warnings` 中写明，不能让整个视频分析全部失败。
- 所有外部命令使用参数数组调用，检查返回码，不拼接用户文件名到 shell 字符串。
- 文件大小、超时、空视频、无音轨、损坏文件都要有清楚错误信息。
- 不保存原始视频，不上传第三方服务。

## 第五部分：启动脚本

生成：

```text
start_media_tools.sh
verify_media_tools.sh
```

`start_media_tools.sh` 要做到：

- 从现有 `.radar_legion_key` 安全加载 API 密钥。
- 激活媒体工具自己的虚拟环境。
- 限制 OCR、ASR 和 OpenMP 线程，避免 CPU 满载导致 Windows 卡顿。
- 启动 `0.0.0.0:8001`。
- 清楚显示服务地址，但不显示密钥。

`verify_media_tools.sh` 要验证：

- FFmpeg、PySceneDetect、SenseVoice、PaddleOCR 都能导入。
- 使用自动生成或官方小型测试素材分别完成一次镜头检测、语音识别和 OCR。
- `/health` 返回 200。
- 现有 WeMM `/health` 仍然正常。
- `nvidia-smi` 显示 WeMM 仍按原方案运行，没有因为媒体工具额外常驻一个大模型而显存溢出。

## 第六部分：兼容现有素材雷达

现有 Mac 前端仍然依赖：

```text
WeMM：http://拯救者地址:8000
媒体分析：http://拯救者地址:8001
```

不要删除或改变现有 WeMM 的 `/health`、`/embed`、`/index-video` 接口。媒体工具先独立运行，后续再由 Mac 前端接入。

如果 Windows 防火墙只允许 8000，请给出只针对专用网络开放 TCP 8001 的 PowerShell 命令，但不要擅自关闭防火墙、开放所有端口或暴露到公网。若使用 Tailscale，只需允许 Tailscale/专用网络访问。

## 验收标准

只有下面全部满足才算完成：

1. 原 WeMM 8000 服务可正常启动和检索。
2. 媒体分析 8001 服务可独立启动。
3. 测试视频能得到镜头时间段。
4. 有语音的视频能得到带时间码的文字；无音轨视频不会报整体失败。
5. 含中文文字的测试画面能得到 OCR 结果。
6. 运行过程中 RTX 5060 不出现显存溢出。
7. 重启 WSL 后，只需分别运行两个启动脚本即可恢复。

## 工作方式

- 直接执行安装、创建文件和测试，不要只给我教程。
- 每完成一个阶段就简短汇报结果，然后继续。
- 普通依赖错误请自行查日志、查当前官方文档并修复。
- 如果同一个阻塞连续三次仍无法解决，再停下来告诉我准确错误、已尝试方案和下一步需要我做什么。
- 需要 `sudo`、Windows 管理员权限、防火墙确认或大文件下载时，明确告诉我弹窗里要允许什么。
- 不要在结果中展示完整 API 密钥，不要把密钥上传 GitHub。

## 最终必须输出给我的信息

完成后用中文给出：

1. 实际项目路径。
2. 安装成功的组件、版本和模型占用空间。
3. WeMM 启动命令。
4. 媒体分析服务启动命令。
5. 两个健康检查地址。
6. 局域网或 Tailscale 地址。
7. 完整测试结果。
8. 每次 Windows/WSL 重启后的最简启动步骤。
9. 所有新增或修改的文件清单。
10. 如果为了兼容性使用了替代方案，说明与原计划的差异。

现在开始执行，先做只读检查和备份，再安装，不要跳过验收。
