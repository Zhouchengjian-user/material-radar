"""HTTP adapter for Tencent WeMM-Embedding.

The service accepts text, image, and video inputs, follows Tencent's official
Transformers preprocessing path, and returns normalized Matryoshka vectors.
Low-VRAM mode uses 8-bit weights and conservative image/video sampling so the
2B model has a practical chance of running on an 8 GB laptop GPU.
"""

from __future__ import annotations

import base64
import binascii
import asyncio
import json
import os
import subprocess
import tempfile
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from threading import Condition
from typing import Iterator, Literal

import torch
import torch.nn.functional as F
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from qwen_vl_utils import process_vision_info
from transformers import AutoModel, AutoProcessor, BitsAndBytesConfig


MODEL_ID = os.getenv("WEMM_MODEL", "tencent/WeMM-Embedding-2B")
LOW_VRAM = os.getenv("WEMM_LOW_VRAM", "0") == "1"
IMAGE_MAX_PIXELS = int(os.getenv("WEMM_IMAGE_MAX_PIXELS", str(512 * 512)))
VIDEO_MAX_PIXELS = int(os.getenv("WEMM_VIDEO_MAX_PIXELS", str(384 * 384)))
VIDEO_MAX_FRAMES = int(os.getenv("WEMM_VIDEO_MAX_FRAMES", "24"))
VIDEO_FPS = float(os.getenv("WEMM_VIDEO_FPS", "1.0"))
MAX_VIDEO_BYTES = int(os.getenv("WEMM_MAX_VIDEO_MB", "512")) * 1024 * 1024
API_KEY = os.getenv("RADAR_API_KEY", "")

model = None
processor = None


class PriorityInferenceGate:
    """Serialize GPU work while letting interactive searches jump the queue."""

    def __init__(self) -> None:
        self._condition = Condition()
        self._active = False
        self._interactive_waiting = 0

    @contextmanager
    def slot(self, priority: str) -> Iterator[None]:
        interactive = priority == "interactive"
        with self._condition:
            if interactive:
                self._interactive_waiting += 1
            try:
                while self._active or (not interactive and self._interactive_waiting > 0):
                    self._condition.wait()
                self._active = True
            finally:
                if interactive:
                    self._interactive_waiting -= 1
        try:
            yield
        finally:
            with self._condition:
                self._active = False
                self._condition.notify_all()


inference_gate = PriorityInferenceGate()


class EmbedInput(BaseModel):
    kind: Literal["text", "image", "video"]
    text: str | None = None
    data: str | None = None
    mime: str | None = None


class EmbedRequest(BaseModel):
    inputs: list[EmbedInput] = Field(min_length=1, max_length=16)
    dimension: int = 256
    priority: Literal["interactive", "background"] = "interactive"


def require_key(authorization: str | None = Header(default=None)) -> None:
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="API key is invalid")


def suffix_for(mime: str | None, kind: str) -> str:
    known = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
    }
    return known.get(mime or "", ".mp4" if kind == "video" else ".bin")


def input_device() -> torch.device:
    if model is None:
        return torch.device("cuda")
    for parameter in model.parameters():
        if parameter.device.type not in {"meta", "cpu"}:
            return parameter.device
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def build_messages(kind: str, value: str) -> list[dict[str, object]]:
    if kind == "text":
        content = {"type": "text", "text": value}
    elif kind == "image":
        content = {
            "type": "image",
            "image": value,
            "max_pixels": IMAGE_MAX_PIXELS,
        }
    else:
        content = {
            "type": "video",
            "video": value,
            "fps": VIDEO_FPS,
            "min_frames": 4,
            "max_frames": VIDEO_MAX_FRAMES,
            "max_pixels": VIDEO_MAX_PIXELS,
            "total_pixels": VIDEO_MAX_FRAMES * VIDEO_MAX_PIXELS,
        }
    return [{"role": "user", "content": [content]}]


def encode_one(kind: str, value: str, dimension: int) -> list[float]:
    assert model is not None and processor is not None
    messages = build_messages(kind, value)
    prompt = processor.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    images, videos, video_kwargs = process_vision_info(
        messages,
        image_patch_size=16,
        return_video_kwargs=True,
        return_video_metadata=True,
    )
    if videos is not None:
        videos, video_metadata = zip(*videos)
        videos, video_metadata = list(videos), list(video_metadata)
    else:
        video_metadata = None

    inputs = processor(
        text=prompt,
        images=images,
        videos=videos,
        video_metadata=video_metadata,
        return_tensors="pt",
        **video_kwargs,
    ).to(input_device())
    with torch.inference_mode():
        embedding = model.embedding(**inputs)
        embedding = F.normalize(embedding[..., :dimension], dim=-1)
    return embedding[0].detach().float().cpu().tolist()


def encode_with_priority(
    kind: str, value: str, dimension: int, priority: str
) -> list[float]:
    with inference_gate.slot(priority):
        return encode_one(kind, value, dimension)


def probe_video_duration(path: Path) -> float:
    command = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "json", str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if not duration or duration <= 0:
        raise ValueError("Video duration is unavailable")
    return duration


def plan_video_segments(
    duration: float, segment_seconds: float, overlap_seconds: float, max_segments: int
) -> list[tuple[float, float]]:
    segment_seconds = min(max(segment_seconds, 2.0), 30.0)
    overlap_seconds = min(max(overlap_seconds, 0.0), segment_seconds / 2)
    if duration <= segment_seconds:
        return [(0.0, duration)]

    step = max(1.0, segment_seconds - overlap_seconds)
    natural_starts: list[float] = []
    cursor = 0.0
    while cursor < duration:
        natural_starts.append(min(cursor, max(0.0, duration - segment_seconds)))
        if natural_starts[-1] + segment_seconds >= duration:
            break
        cursor += step
    # max_segments=0 means full coverage. Positive values remain available for
    # clients that deliberately want an evenly sampled preview index.
    max_segments = min(max(max_segments, 0), 2000)
    if max_segments == 0 or len(natural_starts) <= max_segments:
        starts = natural_starts
    elif max_segments == 1:
        starts = [max(0.0, (duration - segment_seconds) / 2)]
    else:
        span = max(0.0, duration - segment_seconds)
        starts = [(span * index) / (max_segments - 1) for index in range(max_segments)]

    unique_starts = list(dict.fromkeys(round(start, 3) for start in starts))
    return [(start, min(duration, start + segment_seconds)) for start in unique_starts]


def transcode_video_segment(source: Path, target: Path, start: float, end: float) -> None:
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{start:.3f}", "-i", str(source),
        "-t", f"{max(0.2, end - start):.3f}",
        "-map", "0:v:0", "-an", "-sn",
        "-vf", "scale='min(768,iw)':-2,fps=4",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target),
    ]
    subprocess.run(command, capture_output=True, text=True, check=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model, processor
    if not torch.cuda.is_available():
        raise RuntimeError(
            "CUDA is unavailable. In WSL, run nvidia-smi and verify the NVIDIA Windows driver first."
        )

    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    load_kwargs: dict[str, object] = {
        "trust_remote_code": True,
        "device_map": "auto",
        "dtype": torch.float16 if LOW_VRAM else torch.bfloat16,
    }
    if LOW_VRAM:
        load_kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)
    model = AutoModel.from_pretrained(MODEL_ID, **load_kwargs).eval()
    yield
    model = None
    processor = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


app = FastAPI(title="素材雷达 WeMM API", version="0.4.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health", dependencies=[Depends(require_key)])
def health() -> dict[str, object]:
    gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    return {
        "ok": model is not None,
        "model": MODEL_ID,
        "device": str(input_device()),
        "gpu": gpu,
        "lowVram": LOW_VRAM,
        "videoMaxFrames": VIDEO_MAX_FRAMES,
        "priorityScheduling": True,
    }


@app.post("/embed", dependencies=[Depends(require_key)])
def embed(request: EmbedRequest) -> dict[str, object]:
    if model is None:
        raise HTTPException(status_code=503, detail="Model is still loading")

    supported = getattr(model.config, "matryoshka_dimensions", None)
    if supported is not None and request.dimension not in supported:
        raise HTTPException(status_code=400, detail=f"Supported dimensions: {supported}")

    temporary_paths: list[Path] = []
    samples: list[tuple[str, str]] = []
    try:
        for item in request.inputs:
            if item.kind == "text":
                if not item.text or not item.text.strip():
                    raise HTTPException(status_code=400, detail="Text input is empty")
                samples.append((item.kind, item.text.strip()))
                continue

            if not item.data:
                raise HTTPException(status_code=400, detail=f"{item.kind} input has no data")
            try:
                raw = base64.b64decode(item.data, validate=True)
            except (ValueError, binascii.Error) as error:
                raise HTTPException(status_code=400, detail="Media data is not valid base64") from error
            with tempfile.NamedTemporaryFile(
                delete=False, suffix=suffix_for(item.mime, item.kind)
            ) as handle:
                handle.write(raw)
                path = Path(handle.name)
            temporary_paths.append(path)
            samples.append((item.kind, str(path)))

        with inference_gate.slot(request.priority):
            embeddings = [
                encode_one(kind, value, request.dimension) for kind, value in samples
            ]
        return {
            "model": MODEL_ID,
            "dimension": request.dimension,
            "embeddings": embeddings,
        }
    except torch.cuda.OutOfMemoryError as error:
        raise HTTPException(
            status_code=507,
            detail=(
                "GPU memory is insufficient. Reduce WEMM_VIDEO_MAX_FRAMES or use a larger GPU."
            ),
        ) from error
    finally:
        for path in temporary_paths:
            path.unlink(missing_ok=True)
        if LOW_VRAM and torch.cuda.is_available():
            torch.cuda.empty_cache()


@app.post("/index-video", dependencies=[Depends(require_key)])
async def index_video(
    request: Request,
    dimension: int = 256,
    segment_seconds: float = 6.0,
    overlap_seconds: float = 1.0,
    max_segments: int = 0,
    priority: Literal["interactive", "background"] = "background",
) -> dict[str, object]:
    if model is None:
        raise HTTPException(status_code=503, detail="Model is still loading")
    supported = getattr(model.config, "matryoshka_dimensions", None)
    if supported is not None and dimension not in supported:
        raise HTTPException(status_code=400, detail=f"Supported dimensions: {supported}")

    suffix = suffix_for(request.headers.get("content-type"), "video")
    source_path: Path | None = None
    segment_paths: list[Path] = []
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
            source_path = Path(handle.name)
            received = 0
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_VIDEO_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Video exceeds the {MAX_VIDEO_BYTES // 1024 // 1024} MB limit",
                    )
                handle.write(chunk)
        if not source_path.stat().st_size:
            raise HTTPException(status_code=400, detail="Video body is empty")

        duration = probe_video_duration(source_path)
        plan = plan_video_segments(duration, segment_seconds, overlap_seconds, max_segments)
        segments: list[dict[str, object]] = []
        for start, end in plan:
            if await request.is_disconnected():
                raise HTTPException(status_code=499, detail="Client cancelled video indexing")
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as handle:
                segment_path = Path(handle.name)
            segment_paths.append(segment_path)
            await asyncio.to_thread(
                transcode_video_segment, source_path, segment_path, start, end
            )
            vector = await asyncio.to_thread(
                encode_with_priority,
                "video",
                str(segment_path),
                dimension,
                priority,
            )
            segments.append({
                "start": start,
                "end": end,
                "time": (start + end) / 2,
                "embedding": vector,
            })
            segment_path.unlink(missing_ok=True)
            segment_paths.remove(segment_path)
            # Give the event loop a chance to accept an interactive /embed request.
            await asyncio.sleep(0)

        return {
            "model": MODEL_ID,
            "dimension": dimension,
            "duration": duration,
            "segments": segments,
            "sampling": {
                "segmentSeconds": segment_seconds,
                "overlapSeconds": overlap_seconds,
                "maxSegments": max_segments,
                "videoMaxFramesPerSegment": VIDEO_MAX_FRAMES,
                "priority": priority,
            },
        }
    except HTTPException:
        raise
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "ffmpeg failed").strip()[-1200:]
        raise HTTPException(status_code=422, detail=f"Video decoding failed: {detail}") from error
    except torch.cuda.OutOfMemoryError as error:
        raise HTTPException(
            status_code=507,
            detail="GPU memory is insufficient for video segment indexing",
        ) from error
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        if source_path is not None:
            source_path.unlink(missing_ok=True)
        for path in segment_paths:
            path.unlink(missing_ok=True)
        if LOW_VRAM and torch.cuda.is_available():
            torch.cuda.empty_cache()
