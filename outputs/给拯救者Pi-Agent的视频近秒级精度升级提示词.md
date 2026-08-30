# 给拯救者 Pi Agent 的视频近秒级精度升级提示词

请直接在这台联想拯救者的 WSL2 Ubuntu 中升级现有“素材雷达”媒体分析服务。不要只给教程，要检查、备份、修改、启动并用真实视频验证。现有 WeMM 服务在 8000，媒体分析服务在 8001；不得破坏 8000，也不得打印或提交完整 API 密钥。

## 目标

把目前“每个镜头只看一张代表图”的分析升级为“智能精细”协议：

- 语音仍连续听完整音轨，由 SenseVoice 返回句子级时间码。
- 长镜头继续拆成约 1 至 3 秒的检索单元，默认目标 2 秒。
- 每个镜头至少取开始、中间、结束 3 个候选画面；动作大、转场多时增加采样，静态画面减少采样。
- OCR 默认每秒检查约 2 次，但先做画面变化检测；相邻画面几乎相同则跳过，避免无意义重复识别。
- 使用 FFprobe 检查视频内嵌字幕轨，并用 FFmpeg 提取 SRT、ASS 或 WebVTT 字幕，解析成带开始、结束时间的字幕条目。
- 每个子能力都返回真实执行状态，网页可以确认“到底哪些模型真的用上了”。

## 第一步：只读检查和备份

1. 搜索并确认现有 `media_tools/media_api.py`、分析器、启动脚本、虚拟环境和 `.radar_legion_key` 的真实路径，不要假设目录。
2. 调用 `http://localhost:8000/health`、`http://localhost:8001/health` 和现有 `/task-status`，记录当前可用能力。
3. 备份将要修改的 Python 和 shell 文件，文件名带日期时间。不要复制视频、模型缓存和虚拟环境。
4. 禁止使用 `rm -rf`、`git reset --hard`，禁止覆盖现有密钥。

## 第二步：升级 8001 接口

让 `POST /analyze-video` 除原有 multipart `file` 外，兼容以下可选 Form 字段；字段缺失时保持旧客户端可用：

```text
analysis_protocol=radar-precision-v1
analysis_profile=smart_precision | fast
target_unit_seconds=2
ocr_fps=2
visual_samples_per_scene=3
dynamic_sampling=true
extract_subtitle_tracks=true
```

`smart_precision` 使用精细策略；`fast` 保留当前代表帧策略。所有数值必须做范围保护：目标单元 1 至 8 秒、OCR 频率 0.2 至 4 fps、每镜头候选画面 1 至 7 张。不要允许请求把 CPU 或内存无限拉高。

响应在原字段之外增加：

```json
{
  "analysis_protocol": "radar-precision-v1",
  "analysis_profile": "smart_precision",
  "capabilities": {
    "scene": true,
    "asr": true,
    "ocr": true,
    "subtitles": true,
    "dynamic_sampling": true
  },
  "search_units": [
    {"start": 0.0, "end": 2.0, "keyframe": 1.0}
  ],
  "transcript": [],
  "ocr": [],
  "subtitles": [
    {"start": 1.2, "end": 2.8, "text": "字幕内容", "language": "zh", "source": "embedded"}
  ],
  "analysis_receipt": {
    "protocol": "radar-precision-v1",
    "profile": "smart_precision",
    "sampled_frames": 0,
    "elapsed_ms": 0,
    "components": {
      "scene": {"status": "ready", "engine": "PySceneDetect"},
      "speech": {"status": "ready", "engine": "SenseVoice"},
      "ocr": {"status": "ready", "engine": "PaddleOCR"},
      "subtitles": {"status": "empty", "engine": "FFmpeg subtitle demux"}
    }
  },
  "warnings": []
}
```

组件状态只能使用：`ready`、`empty`、`failed`、`unsupported`、`skipped`。`empty` 表示模型确实检查过但没有内容；不能把“没运行”伪装成空结果。一个组件失败不能让全部结果丢失，错误写入 `warnings` 和对应组件状态。

## 第三步：实现动态视觉采样

1. 继续用 PySceneDetect AdaptiveDetector 找真实镜头边界。
2. `smart_precision` 下，把超过 3 秒的镜头再按 `target_unit_seconds` 拆成连续 `search_units`；不要跨越原镜头边界，最后一小段要合并或合理延长，避免只有零点几秒。
3. 每个镜头生成开始 15%、中间 50%、结束 85% 三个候选时间。额外以低分辨率灰度图计算感知哈希、直方图或 SSIM 差异：变化明显时补采样，变化很小时去重。
4. OCR 候选点以 `ocr_fps` 产生，但先用画面差异门控；静态连续字幕只保留首次、文本发生变化的时刻和结束时刻。
5. 临时帧建议缩放到长边 960 或更低再给 PaddleOCR，原视频不需要解码成全部原尺寸图片。
6. 为每一条 OCR 结果保留 `time`、`text`、`confidence`、可用时的 `box`。相邻相同文本合并时可增加 `end`。

## 第四步：字幕轨

1. 用参数数组调用 `ffprobe` 获取 subtitle streams，不拼接 shell 字符串。
2. 有字幕轨时逐轨提取到临时目录，兼容 SRT、ASS/SSA、WebVTT，保留时间码和语言标签。
3. 清除 ASS 样式控制符并规范空白，但不要改写字幕内容。
4. 没有字幕轨时返回空数组和 `empty`，不是失败。
5. 完成或异常后删除临时视频、音频、字幕与帧文件，不保存用户原片。

## 第五步：任务状态与健康接口

让 `/task-status` 增加可用字段：

```json
{
  "stage": "sampling | subtitles | asr | ocr | done",
  "analysis_profile": "smart_precision",
  "sampled_frames": 0,
  "subtitle_count": 0
}
```

让 `/health` 增加：

```json
{
  "analysis_protocol": "radar-precision-v1",
  "subtitles": true,
  "capabilities": {"dynamic_sampling": true, "subtitles": true}
}
```

继续保持单任务并发限制。进度阶段必须真实推进，刷新网页不能重复启动同一个任务。

## 第六步：验证

至少选择两条真实视频验证，一条有对白和字幕，一条有明显动作和转场。必须给出：

1. `fast` 与 `smart_precision` 的耗时、检索单元数、采样帧数、语音条数、OCR 条数和字幕轨条数。
2. 对一个只出现约 1 秒的动作或文字，确认精细模式能返回对应的 1 至 3 秒时间段。
3. 对没有语音或没有字幕轨的视频，确认状态为 `empty` 而非 `failed`。
4. 8000 的 `/health`、`/embed`、`/index-video` 保持正常，RTX 5060 不出现显存溢出。
5. 重启 8001 后再测一次 `/health`、`/task-status` 和 `/analyze-video`。

完成后只向我汇报：修改文件、备份路径、接口示例、两条视频的对比结果、启动命令和仍存在的限制。不要展示完整密钥。现在开始执行。
