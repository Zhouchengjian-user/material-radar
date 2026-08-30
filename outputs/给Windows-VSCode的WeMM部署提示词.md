# 给 Windows VS Code AI 助手的任务提示词

把本文“提示词开始”到“提示词结束”的全部内容复制到 Windows 电脑上 VS Code 里的 Codex 或其他具备终端操作能力的 AI 编程助手中。

同时把 `Legion-WeMM.zip` 放到 Windows 的“下载”文件夹，或者与当前 VS Code 工作区放在一起。

---

## 提示词开始

你现在要协助我在一台联想拯救者 Windows 11 笔记本上部署腾讯开源模型 `tencent/WeMM-Embedding-2B`，并启动一个供“素材雷达”调用的本地 HTTP API。

机器配置：

- Windows 11 64 位
- AMD Ryzen 9 8945HX
- 32GB 内存
- NVIDIA GeForce RTX 5060 Laptop GPU，8GB 显存
- 模型部署包文件名：`Legion-WeMM.zip`

最终目标：

1. 使用 WSL2 和 Ubuntu 24.04。
2. 在 Ubuntu 中使用 PyTorch CUDA 12.8。
3. 部署 WeMM-Embedding 2B，不要安装 4B 或 9B。
4. 使用部署包中的低显存配置：8 位加载、256 维、视频最多抽取 24 帧。
5. 在 `http://localhost:8000` 启动 API。
6. 完成显卡、健康接口和一次文字向量生成测试。
7. 告诉我如何把模型地址和 API 密钥填入素材雷达。

工作规则：

- 一步一步执行并向我解释当前阶段，不要一次性把命令全部丢给我。
- 可以主动执行只读检查和当前任务所需的普通安装命令。
- 遇到管理员授权、Windows 重启、修改防火墙或需要公开网络端口时，必须暂停并明确告诉我需要做什么。
- 不要运行会删除用户文件、重置系统或注销 WSL 发行版的命令。
- 不要在 WSL 中安装 NVIDIA Linux 显卡驱动。WSL 使用 Windows NVIDIA 驱动映射出的 GPU。
- 不要单独安装完整 CUDA Toolkit，优先使用 PyTorch CUDA 12.8 wheel 自带的 CUDA 运行时。
- 不要把服务暴露到公网，不要关闭 Windows 防火墙。
- 不要静默改用 CPU、4B、9B 或云服务器；如果 8GB 显存仍不足，先报告实际错误。
- 如果当前 VS Code 不是管理员权限，只在确实需要时让我手动打开管理员 PowerShell。
- 每个阶段结束都要显示检查结果。失败时保留并解释最后 30 行报错，不要反复重装。

请按以下阶段执行。

### 阶段一：只读检查 Windows 环境

在 PowerShell 中检查：

```powershell
nvidia-smi
wsl --status
wsl -l -v
```

确认是否能识别 RTX 5060 Laptop、WSL 是否安装、Ubuntu 是否存在以及 VERSION 是否为 2。先总结检查结果。

如果没有 WSL 或 Ubuntu 24.04，请让我在管理员 PowerShell 执行：

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
```

需要重启时暂停任务，明确说“现在请重启 Windows，回来后继续本任务”。重启后重新运行检查。若 Ubuntu 的 VERSION 是 1，先根据 `wsl -l -v` 中的准确发行版名称转换到 WSL2，不要猜名称。

### 阶段二：初始化 Ubuntu 和检查 WSL GPU

如果 Ubuntu 尚未创建 Linux 用户，让我打开 Ubuntu 24.04，按提示设置英文用户名和密码。提醒我输入 Linux 密码时屏幕不显示字符是正常现象。

然后在 Ubuntu 中运行：

```bash
nvidia-smi
```

如果命令不在 PATH，再检查：

```bash
/usr/lib/wsl/lib/nvidia-smi
```

必须确认输出包含 `NVIDIA GeForce RTX 5060 Laptop GPU`。若失败，停止模型安装，优先检查 Windows NVIDIA 驱动和 `wsl --update`，不要在 Ubuntu 安装 Linux 显卡驱动。

### 阶段三：寻找并解压部署包

在 Windows“下载”目录和当前 VS Code 工作区中寻找 `Legion-WeMM.zip`。如果找不到，停止并让我把文件放到下载目录。

找到后，通过 `/mnt/c/` 对应路径将它复制到 Ubuntu 用户主目录。路径中可能有空格或中文，必须正确引用，不要猜 Windows 用户名。最终目录应为：

```text
~/wemm-radar/cloud
```

需要的基本操作为：安装 `unzip`、解压 `Legion-WeMM.zip` 到 `~/wemm-radar`，然后确认以下文件存在：

```text
~/wemm-radar/cloud/install_legion.sh
~/wemm-radar/cloud/configure_legion.sh
~/wemm-radar/cloud/start_legion.sh
~/wemm-radar/cloud/wemm_api.py
```

如果解压形成了重复目录层级，先通过只读列表确认，再调整到上述结构。不要删除原始 ZIP。

### 阶段四：安装 Python 和 GPU 环境

进入：

```bash
cd ~/wemm-radar/cloud
```

执行：

```bash
bash install_legion.sh
```

此脚本会创建 `.venv`，安装 PyTorch 2.11.0、torchvision 0.26.0、CUDA 12.8 wheel、Transformers 5.2.0、qwen-vl-utils、bitsandbytes 和 API 依赖。

安装完成后必须展示 `verify_gpu.py` 的结果，至少确认：

- `CUDA available: True`
- GPU 名称为 RTX 5060 Laptop
- GPU 计算测试通过

### 阶段五：生成连接密码并启动模型

运行：

```bash
cd ~/wemm-radar/cloud
bash configure_legion.sh
```

记录脚本显示的模型地址和连接密码。密码存储在权限受限的 `.radar_legion_key` 文件中，不要把它上传到 GitHub 或公开聊天。

然后在一个需要持续保持运行的 Ubuntu/VS Code 终端中执行：

```bash
bash start_legion.sh
```

第一次启动会从 Hugging Face 下载数 GB 的模型文件。持续观察启动输出，直到明确出现：

```text
Application startup complete
```

如果下载或加载仍在进行，不要误判为卡死。定期给我简短进度。

### 阶段六：验证 API

不要关闭模型终端。另开一个 Ubuntu 终端，进入同一目录并加载连接密码：

```bash
cd ~/wemm-radar/cloud
source .radar_legion_key
```

先验证健康接口：

```bash
curl -s -H "Authorization: Bearer $RADAR_API_KEY" http://localhost:8000/health
```

返回结果应包含：

- `"ok": true`
- `"model": "tencent/WeMM-Embedding-2B"`
- `"lowVram": true`
- RTX 5060 GPU 信息

然后提交一次文字向量请求，确认 HTTP 状态成功、返回一个向量，并检查向量长度为 256。不要在最终报告中打印完整的 256 个数字。

### 阶段七：处理显存不足

如果出现 `CUDA out of memory`，先停止服务，在同一个启动终端执行：

```bash
export WEMM_VIDEO_MAX_FRAMES=12
bash start_legion.sh
```

再次测试。若文字或图片请求在 8 位加载下仍无法运行，停止并把完整的显存占用、模型加载错误和最后 30 行日志告诉我，不要擅自更换模型或卸载环境。

### 阶段八：交付信息

全部成功后，用中文告诉我：

1. 模型是否成功运行在 RTX 5060 Laptop 上。
2. 当前模型、量化模式、向量维度和视频帧数。
3. 素材雷达应填写的模型地址 `http://localhost:8000`。
4. 如何再次查看 API 密钥：`bash configure_legion.sh`。
5. 每次 Windows 关机后如何重新启动：

```bash
cd ~/wemm-radar/cloud
bash start_legion.sh
```

6. 模型服务终端必须保持运行，按 `Ctrl+C` 停止。

如果素材雷达实际运行在另一台 Mac 上，不要把 `localhost` 当成拯救者地址，也不要直接开放公网端口。先完成拯救者本机验证，然后告诉我需要另行配置局域网访问或安全隧道。

现在从“阶段一：只读检查 Windows 环境”开始执行。

## 提示词结束

---

## 使用方法

1. 把本文件和 `Legion-WeMM.zip` 传到拯救者。
2. 在拯救者上打开 VS Code。
3. 打开一个空文件夹作为工作区。
4. 打开 VS Code 中的 Codex 或其他能运行终端命令的 AI 助手。
5. 复制上面的完整提示词发送给它。
6. 遇到 Windows 重启后，重新打开同一个 VS Code 工作区和对话，发送：“继续，从重启后的环境检查开始。”

如果 AI 助手没有终端执行权限，它仍可以一步步给出命令，但需要你手动复制到 PowerShell 或 Ubuntu 中运行。
