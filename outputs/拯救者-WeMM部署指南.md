# 拯救者部署 WeMM-Embedding 2B

适用机器：Windows 11、NVIDIA RTX 5060 Laptop 8GB、32GB 内存。

这套配置采用 WSL2（Windows 内的 Ubuntu）、PyTorch CUDA 12.8、WeMM-Embedding 2B 8 位加载。视频每次最多抽取 24 帧，优先保证 8GB 显存能稳定完成图片和短视频检索。

## 第 1 步：安装 WSL2

先在 Windows 更新 NVIDIA 显卡驱动。然后右键“开始”，选择“终端（管理员）”或“PowerShell（管理员）”，依次运行：

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
```

完成后重启电脑。第一次打开 Ubuntu 时，按提示创建 Linux 用户名和密码。输入密码时屏幕不显示字符属于正常现象。

在 Ubuntu 窗口运行：

```bash
nvidia-smi
```

如果能看到 `NVIDIA GeForce RTX 5060 Laptop GPU`，说明显卡已经交给 WSL 使用。不要在 Ubuntu 内另装 NVIDIA Linux 显卡驱动。

## 第 2 步：把部署包放进 Ubuntu

在 Ubuntu 窗口运行：

```bash
cd ~
explorer.exe .
```

Windows 文件资源管理器会打开 Ubuntu 的用户目录。把 `Legion-WeMM.zip` 拖进这个目录。

回到 Ubuntu 运行：

```bash
sudo apt-get update
sudo apt-get install -y unzip
unzip Legion-WeMM.zip -d wemm-radar
cd ~/wemm-radar/cloud
bash install_legion.sh
```

安装需要下载 PyTorch 和依赖，时间取决于网速。最后看到“GPU 环境正常”才算完成。

## 第 3 步：启动模型

生成素材雷达的连接密码：

```bash
cd ~/wemm-radar/cloud
bash configure_legion.sh
```

记下它显示的模型地址和连接密码，然后启动：

```bash
bash start_legion.sh
```

第一次启动会从 Hugging Face 下载数 GB 的模型文件。看到类似下面的文字表示服务已就绪：

```text
Uvicorn running on http://0.0.0.0:8000
Application startup complete
```

保持这个 Ubuntu 窗口打开。按 `Ctrl+C` 可停止模型。

## 第 4 步：连接素材雷达

如果素材雷达也运行在这台拯救者上，打开右上角模型设置，填写：

- 模型地址：`http://localhost:8000`
- API 密钥：`bash configure_legion.sh` 显示的连接密码
- 向量维度：`256`

先点“测试连接”，成功后保存，再对素材重新建立 WeMM 索引。

## 每次关机后

模型文件、Python 环境和连接密码都不会丢。重新开机后只需打开 Ubuntu 并运行：

```bash
cd ~/wemm-radar/cloud
bash start_legion.sh
```

## 常见问题

### `nvidia-smi` 不存在

回到 Windows 更新 NVIDIA 驱动，在管理员 PowerShell 运行 `wsl --update`，重启后再试。

### 下载 Hugging Face 模型失败

先不要反复重装。保留终端最后 30 行报错并发给 Codex，根据网络错误配置镜像或代理。

### 显示 CUDA out of memory

把视频帧数进一步降到 12：

```bash
export WEMM_VIDEO_MAX_FRAMES=12
bash start_legion.sh
```

### 服务启动了但素材雷达连接失败

先确认素材雷达和模型是否在同一台拯救者上。若素材雷达运行在另一台电脑，`localhost` 指向的是那台电脑本身，需要再配置局域网访问或安全隧道。

## 说明

- 2B、256 维是当前机器最合理的首发配置。腾讯公布的数据中，2B 的 256 维在 MMEB-v2 上保留了完整维度 98.7% 的图像和视频效果。
- 8 位加载与 24 帧限制是为 8GB 显存做的工程适配，不是腾讯官方给出的显存承诺；需要在你的真机上完成第一次验证。
- WeMM 支持文字、图片、视频、视觉文档和图文混排，不支持音频。
