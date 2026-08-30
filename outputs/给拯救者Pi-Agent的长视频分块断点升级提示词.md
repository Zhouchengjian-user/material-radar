# 给拯救者 Pi Agent 的完整提示词

请直接在这台联想拯救者的 WSL2 Ubuntu 中升级现有“素材雷达”服务。不要只写教程，要先检查和备份，再修改、启动并做真实验收。WeMM 在 8000，媒体分析服务在 8001。不得打印、复制、上传或提交完整 API 密钥，不得破坏现有素材和模型环境。

## 目标

解决十几分钟到一小时视频容易在最后阶段超时、失败后整条重做的问题：

1. 先恢复并确认 8000 WeMM `/health` 正常。
2. 长视频上传到 8001 一次后，按 150 秒一块在后台处理。允许 120–180 秒配置，默认 150 秒。
3. 每块独立完成切镜、语音识别、动态 OCR、字幕轨提取，并立即持久化结果。
4. 某块失败只重试这一块，已经成功的块绝不重算。
5. 8001 或 WSL 重启后能从持久化任务继续，不能只把状态放在 Python 内存。
6. 8000 暂时不可用不能影响 8001 保存媒体分析结果。8000 恢复后由 Mac 网页补写向量，不得重跑语音和 OCR。
7. 长视频 OCR 使用动态采样，不再固定每秒检查两张画面。

## 第一步：检查、备份和恢复 8000

1. 确认 8000、8001 分别由哪个目录、虚拟环境和启动脚本提供：检查 `ss -ltnp`、进程命令、systemd 或现有启动脚本。不要猜路径。
2. 备份 8001 当前服务源码和启动脚本到带日期的备份目录。不要覆盖或删除旧版。
3. 读取现有 `.radar_legion_key` 或启动环境中的密钥，但日志和最终回复只显示“已读取”，不要输出密钥值。
4. 使用现有 8000 启动方式重启 WeMM，然后验证：
   - `GET http://127.0.0.1:8000/health` 返回 HTTP 200、`ok: true`。
   - 做一次最小文字向量请求，确认不是空响应。
   - 记录 GPU、模型名、向量维度和错误日志摘要。
5. 不要为了升级 8001 修改 WeMM 的虚拟环境、PyTorch、CUDA、transformers 或 bitsandbytes。

## 第二步：把 8001 改成持久化分块任务服务

保留现有 `/analyze-video`、`/analyze-image`、`/task-status` 的兼容行为，同时新增下面的接口。所有接口继续使用现有 Bearer 鉴权。

### 健康接口

`GET /health` 至少增加：

```json
{
  "ok": true,
  "analysis_protocol": "radar-long-video-v1",
  "chunked_analysis": true,
  "dynamic_ocr": true,
  "image_ocr": true,
  "capabilities": {
    "chunked_analysis": true,
    "dynamic_sampling": true,
    "asr": true,
    "ocr": true,
    "subtitles": true,
    "image_ocr": true
  }
}
```

### 创建长视频任务

新增 `POST /analyze-video/start`，multipart 接收：

- `file`：原视频，只上传一次。
- `asset_key`、`client_asset_id`：客户端素材标识。
- `generation_id`：本轮分析标识，防止旧任务结果覆盖新任务。
- `chunk_seconds`：默认 150，限制在 120–180。
- 原有 `analysis_profile`、`target_unit_seconds`、`visual_samples_per_scene` 等字段。
- `ocr_strategy=dynamic`。
- `ocr_fps=0.35`，只作为动态策略的低频基线。
- `ocr_max_frames_per_chunk=75`，建议限制 60–90。

要求：

1. 请求只负责把视频安全保存到任务目录、读取时长、规划分块并入队，随后尽快返回 HTTP 202。不要在这次 HTTP 请求内分析完整视频。
2. 对 `asset_key + generation_id` 做幂等处理。重复请求不能重复创建和重复上传同一任务。
3. 返回：

```json
{
  "task_id": "...",
  "duration": 901.4,
  "chunk_seconds": 150,
  "status": "queued",
  "chunks": [
    {"index": 0, "start": 0, "end": 150, "status": "queued", "stage": "queued", "progress": 0}
  ]
}
```

### 查询任务状态

升级 `GET /task-status?task_id=...`。返回任务总状态，并返回每一块的真实状态：

```json
{
  "task_id": "...",
  "status": "running",
  "progress": 36,
  "current_chunk": 2,
  "total_chunks": 7,
  "chunks": [
    {
      "index": 1,
      "start": 150,
      "end": 300,
      "status": "running",
      "stage": "ocr",
      "progress": 74,
      "attempts": 1,
      "scene_count": 31,
      "transcript_count": 18,
      "ocr_count": 12,
      "error": null,
      "components": {
        "scene": {"status": "ready", "progress": 100, "count": 31},
        "speech": {"status": "ready", "progress": 100, "count": 18},
        "ocr": {"status": "running", "progress": 62, "count": 12}
      }
    }
  ]
}
```

`ready` 表示这一块的媒体结果已经写入磁盘。即使语音或 OCR 识别到 0 条，也必须把对应组件标为 `ready`，不能一直显示 `pending`。

### 读取单块结果

新增 `GET /task-result?task_id=...&chunk_index=...`：

- 完成后 HTTP 200，幂等返回这一块的 `scenes` 或 `search_units`、`transcript`、`ocr`、`subtitles`、分析回执、校验值。
- 时间码可以使用块内相对时间，但必须明确返回 `timebase: "relative"`；如果返回全片时间则标记 `timebase: "global"`。
- 未完成返回 HTTP 202，并说明当前阶段。
- 不存在或已过期返回 HTTP 404，不能返回伪造的空成功。

### 只重试失败块

新增 `POST /retry-chunk`：

```json
{"task_id": "...", "chunk_index": 2}
```

只把指定失败块重新排队。已经 ready 或正在 running 时按幂等方式返回当前状态。不得重新上传原视频，不得删除或重算其他成功块。

## 第三步：分块处理与断点保存

1. 后台任务默认串行处理分块，避免 CPU、内存和磁盘瞬时拉满。短任务健康检查和状态查询不能被长分析阻塞。
2. 每一块按 `切镜 -> 语音 -> OCR -> 字幕 -> 保存结果` 执行。每完成一个阶段都更新状态；每完成一块立即原子写入任务文件。
3. 任务元数据与分块结果必须持久化。可以使用 SQLite，或“临时文件写完后原子 rename”的 JSON 文件。至少保存任务、分块、attempts、error、各组件进度和结果文件路径。
4. 服务启动时扫描未完成任务：ready 块保持 ready，running 块恢复为 queued，只继续未完成块。
5. 任务目录使用不可预测的服务端 task ID，校验所有路径，禁止目录穿越。原文件和结果设合理保留期，例如 7 天；清理时不要动仍在运行的任务。
6. 每块最多自动重试 3 次，指数退避。超过次数标为 failed，等待 `/retry-chunk` 人工重试。
7. 分块边界可留 1–2 秒分析重叠，合并结果时按时间和文本去重，不能产生重复字幕或重复镜头。
8. 自动重试的唯一执行者是 8001 队列；`/retry-chunk` 必须幂等。同一个 `task_id + chunk_index` 即使被重复调用，也只能存在一个 queued/running 作业。
9. `/task-result` 的读取失败只是结果传输失败，不能把 ready 块改回 failed，更不能因此重跑切镜、语音或 OCR。

## 第四步：动态 OCR

不要把 150 秒块机械地按 2 FPS 抽成 300 张图。改为：

1. PySceneDetect 找到的每个镜头至少取开头、中间、结尾候选帧。
2. 以约 0.35 FPS 做低频兜底；检测到画面变化、字幕出现或文字区域变化时临时加采样。
3. 用 pHash、SSIM 或等价方法去除近重复画面；OCR 文本再按时间邻近和相似文本去重。
4. 默认每个 150 秒块最多 75 张 OCR 候选帧，可配置在 60–90 之间。
5. PaddleOCR 前把画面缩放到合理尺寸，例如长边 960，避免保存大量原尺寸帧；临时帧完成后删除。
6. 状态里返回实际采样帧数和 OCR 结果数，让网页能显示真实进度。

## 第五步：服务隔离与启动

1. 8001 继续使用自己现有的媒体分析虚拟环境，不安装依赖到 8000 WeMM 环境。
2. 分块队列、OCR、ASR 发生异常时不能让 FastAPI 主进程退出，也不能留下永久 running 锁。
3. 保持监听 `0.0.0.0:8001` 和现有 Windows/WSL 端口转发，不新增公网暴露，不关闭防火墙。
4. 更新现有启动脚本，使 8000、8001 重启后都能工作。不要创建第二套互相冲突的服务。

## 第六步：必须完成的验收

请实际运行自动测试和最小真实测试，不能只看代码：

1. 601 秒视频按 150 秒规划为 5 块，最后一块允许短于 120 秒。
2. 上传一次后 `/analyze-video/start` 快速返回 task ID；后续状态和结果请求不再上传视频。
3. 第 1 块完成后，结果文件马上存在；第 2 块失败不会删除第 1 块。
4. 只调用 `retry-chunk` 重试第 2 块，确认第 1、3 块的文件修改时间和结果不变。
5. 分析中途重启 8001，确认服务恢复后从未完成块继续。
6. 暂停 8000 WeMM 时，8001 仍能完成并保存镜头、语音、OCR；恢复 8000 后两个 `/health` 都正常。
7. 用一条至少 10 分钟、含人声和画面文字的视频做端到端测试。记录总耗时、每块耗时、峰值内存和失败块，不要输出视频隐私内容。
8. 验证旧 `/analyze-video` 和 `/analyze-image` 没有被破坏。

## 最终回复格式

完成后只汇报：

- 8000、8001 是否正常。
- 备份位置和修改过的文件。
- `/health` 的能力字段，不含密钥。
- 真实长视频共多少块，成功/失败多少块，各阶段耗时。
- 重启恢复和单块重试是否通过。
- 如果有未完成项，给出准确错误日志摘要和下一步，不要用“应该可以”。
