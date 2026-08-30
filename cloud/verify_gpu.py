import torch


print(f"PyTorch: {torch.__version__}")
print(f"CUDA runtime: {torch.version.cuda}")
print(f"CUDA available: {torch.cuda.is_available()}")

if not torch.cuda.is_available():
    raise SystemExit("没有检测到 CUDA，请检查 Windows NVIDIA 驱动和 WSL。")

properties = torch.cuda.get_device_properties(0)
print(f"GPU: {properties.name}")
print(f"显存: {properties.total_memory / 1024**3:.1f} GB")
x = torch.ones((1024, 1024), device="cuda")
print(f"GPU 计算测试: {float((x @ x).mean()):.1f}")
print("GPU 环境正常。")
