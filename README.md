# 素材雷达助手

这是一个面向短视频与设计团队的本地优先素材库。图片、视频、文字和索引数据默认保存在浏览器 IndexedDB 中；腾讯 WeMM-Embedding 作为可选的语义检索服务。

## 现在可以做什么

- 批量导入图片、视频、PDF、Word、TXT、Markdown、JSON、CSV、HTML、SRT、VTT 和 ZIP 压缩包；压缩包内的素材会拆分后分别识别。
- 在综合、视频、图片、文字四个工作台中，用文字、图片或视频片段跨模态检索。
- 连接 WeMM 后，默认按 6 秒、重叠 1 秒覆盖完整视频，用自然语言直接找到镜头。
- 粘贴分镜脚本，一次为最多 10 个镜头意图推荐首选与备选素材。
- 命中视频后从匹配时间开始预览；右侧审片器可展开为大窗口，同时保留完整原文件下载。
- 编辑标签、记录使用次数、删除素材、下载原文件和导出 JSON 索引。
- 自动跳过重复文件，长视频索引可停止，失败素材可单独重试。
- 显示模型真实在线状态、本地存储占用，并可向浏览器申请持久保存。

## 本地启动

需要 Node.js 20 或更高版本。首次运行先安装依赖：

```bash
npm install
npm start
```

浏览器打开 `http://127.0.0.1:4173`。

## AutoDL 部署 WeMM

推荐先使用 `tencent/WeMM-Embedding-2B` 和 256 维向量。把 `cloud` 目录上传到 AutoDL 实例后执行：

```bash
cd cloud
pip install -r requirements.txt
export WEMM_MODEL=tencent/WeMM-Embedding-2B
export RADAR_API_KEY=换成你自己的一段随机密码
bash start_autodl.sh
```

然后在 AutoDL 控制台把实例端口 `8000` 映射成公网地址。在素材雷达右上角打开模型设置，填写公网地址与同一段 API 密钥，先测试连接，再保存。

首次启动会下载并加载模型，耗时取决于网络与显卡。AutoDL 关机不会影响本地素材；再次开机后重新启动服务即可恢复自然语言检索。

## 拯救者本地部署 WeMM

RTX 5060 Laptop 8GB 使用 `cloud/install_legion.sh` 安装 CUDA 12.8 版 PyTorch 与 ffmpeg，并通过 `cloud/start_legion.sh` 以 8 位权重和每个片段最多 24 帧的视频配置启动 2B 模型：

```bash
cd cloud
bash install_legion.sh
bash configure_legion.sh
bash start_legion.sh
```

完整的 WSL2 安装与故障处理见 `outputs/拯救者-WeMM部署指南.md`。这里的 24 帧是单个 5 至 8 秒片段内部的采样上限，不是整条视频最多切 24 段。8GB 属于低显存适配方案，真机若仍出现显存不足，可将 `WEMM_VIDEO_MAX_FRAMES` 降到 12。

## 数据说明

- 原始素材保存在当前浏览器，不会自动上传到项目服务器。
- 连接 WeMM 后，建立索引时会向你填写的服务发送缩略图或视频文件。视频由模型服务临时切段，完成后会删除临时文件。
- 清理浏览器站点数据会删除本地素材库。正式团队版应增加服务器对象存储和登录权限。
- 当前版本适合作为单人本地 Beta；对公网开放前还需要账号权限、对象存储、任务队列、备份与监控。

## 模型接口

云端服务提供：

- `GET /health`
- `POST /embed`
- `POST /index-video`，接收原始视频流并返回带起止时间码的片段向量

请求示例：

```json
{
  "dimension": 256,
  "inputs": [
    { "kind": "text", "text": "暖色人物特写" }
  ]
}
```
