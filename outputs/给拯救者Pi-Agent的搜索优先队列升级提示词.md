# 给拯救者 Pi Agent 的搜索优先队列升级提示词

请直接升级这台拯救者 WSL2 中现有的素材雷达 WeMM 8000 服务。目标是“后台上传和视频入库不再长时间占住语义搜索”。不要只给教程，要检查、备份、修改、重启和验证。

## 先检查

1. 找到实际运行的 `~/wemm-radar/cloud/wemm_api.py` 和 `start_legion.sh`，不要假设路径。
2. 检查 `http://localhost:8000/health`、当前进程和 `.radar_legion_key`。不要输出完整密钥。
3. 给将修改的文件创建带日期时间的备份。禁止删除模型缓存、虚拟环境和素材。

## 要实现的调度规则

- GPU 同一时间仍只执行一次 WeMM 推理，避免 RTX 5060 8GB 显存溢出。
- `/embed` 接受 `priority: interactive | background`，缺省为 `interactive`。
- `/index-video` 接受查询参数 `priority=background`。
- 使用线程安全的 `Condition` 实现优先门：已经开始的单次推理不强杀；完成当前片段后，只要有交互搜索等待，后台任务必须先让搜索进入。
- 视频索引必须每个片段分别申请和释放 GPU，不能在整个视频期间一直持锁。
- FFmpeg 转码和单片段推理放入 `asyncio.to_thread`，不能阻塞 FastAPI 事件循环。
- 每处理完一个视频片段执行一次 `await asyncio.sleep(0)`，让服务接收新的搜索请求。
- 每段开始前检查 `await request.is_disconnected()`；Mac 已取消任务时停止后续片段并清理临时文件。
- `/health` 增加 `priorityScheduling: true`。

当前 Mac 项目中的最新版参考实现位于 `cloud/wemm_api.py`，版本号应为 `0.4.0`。如果拯救者项目和它结构一致，优先完整对比后同步这份实现；如果已有后续修复，保留后续能力，只移植优先门和异步让路逻辑，不要盲目覆盖。

## 验证

1. 重启 8000，确认 `/health` 返回 `priorityScheduling: true`。
2. 启动一条至少 5 分钟的视频 `/index-video?priority=background`。
3. 视频仍在入库时，另发一条文字 `/embed`，请求体带 `priority: interactive`。
4. 文字搜索应该在当前视频小片段完成后立刻返回，不能等整条视频处理完。
5. 搜索结束后，视频索引从下一片段继续，结果片段数完整。
6. 连续发 5 次文字搜索，确认没有 CUDA OOM、死锁、临时文件残留或后台任务永久饥饿。
7. 确认原有 `/embed`、`/index-video` 和鉴权继续兼容旧客户端。

最终告诉我：修改文件、备份路径、健康接口结果、并发验证中搜索等待时间、后台视频是否恢复、显存峰值和启动命令。不要显示完整 API 密钥。
