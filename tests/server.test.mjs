import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { after, before, test } from "node:test";
import yazl from "yazl";

const port = 43179;
let child;

function createZipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile(); const chunks = [];
    archive.outputStream.on("data", (chunk) => chunks.push(chunk));
    archive.outputStream.on("error", reject);
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    entries.forEach((entry) => archive.addBuffer(Buffer.from(entry.content), entry.name));
    archive.end();
  });
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not start");
}

before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });
  await waitForServer();
});

after(() => child?.kill());

test("serves the product and health endpoint", async () => {
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true, wemmConfigured: false, mediaConfigured: false });

  const pageResponse = await fetch(`http://127.0.0.1:${port}/`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /素材雷达/);
  assert.match(page, /app\.js/);
  assert.match(page, /综合雷达/);
  assert.match(page, /视频搜索/);
  assert.match(page, /图片搜索/);
  assert.match(page, /文字搜索/);
  assert.match(page, /\.txt/);
  assert.match(page, /persistStorageButton/);
  assert.match(page, /cancelIndexButton/);
  assert.match(page, /referenceGuide/);
  assert.match(page, /参考匹配/);
  assert.match(page, /mediaEndpointInput/);
  assert.match(page, /测试媒体服务/);
  assert.match(page, /taskCenterButton/);
  assert.match(page, /视频分析任务/);
  assert.match(page, /智能精细/);
  assert.match(page, /analysisProfile/);
  assert.match(page, /localTaskList/);
  assert.match(page, /\.pdf/);
  assert.match(page, /\.docx/);
  assert.match(page, /\.zip/);

  const cssResponse = await fetch(`http://127.0.0.1:${port}/styles.css`);
  const css = await cssResponse.text();
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.match(css, /\.drop-zone[\s\S]*?pointer-events:\s*none;/);

  const appResponse = await fetch(`http://127.0.0.1:${port}/app.js`);
  const app = await appResponse.text();
  assert.match(app, /max_segments:\s*"0"/);
  assert.match(app, /TEXT_EXTENSIONS/);
  assert.match(app, /segmentSeconds:\s*6/);
  assert.match(app, /requestMediaAnalysis/);
  assert.match(app, /new FormData\(\)/);
  assert.match(app, /media-v4-/);
  assert.match(app, /analysisRequestFields/);
  assert.match(app, /scheduleIndexResume/);
  assert.match(app, /indexStarting/);
  assert.match(app, /BroadcastChannel/);
  assert.match(app, /priority = "interactive"/);
  assert.match(app, /imageRegions/);
  assert.match(app, /analyze-image/);
  assert.match(app, /data-retry-asset/);

  const taskQueueResponse = await fetch(`http://127.0.0.1:${port}/task-queue.js`);
  const taskQueue = await taskQueueResponse.text();
  assert.equal(taskQueueResponse.status, 200);
  assert.match(taskQueue, /MEDIA_AUTO_RETRY_LIMIT/);
  assert.match(taskQueue, /assetNeedsIndex/);
  assert.match(app, /关键帧 ·.*多路索引/);
  assert.match(app, /已自动使用镜头关键帧融合索引/);
  assert.match(app, /api\/media\/task-status/);
  assert.match(app, /normalizeMediaTaskPayload/);
  assert.match(app, /resultKeyForSegment/);
  assert.match(app, /isShotResult/);
  assert.match(app, /个视频镜头/);
  assert.match(app, /prepareImportItems/);
  assert.match(app, /sourceContainer/);
  assert.match(app, /evaluateVideoSegment/);
  assert.match(app, /normalizeAnalysisReceipt/);

  const mediaAnalysisResponse = await fetch(`http://127.0.0.1:${port}/media-analysis.js`);
  const mediaAnalysis = await mediaAnalysisResponse.text();
  assert.equal(mediaAnalysisResponse.status, 200);
  assert.match(mediaAnalysis, /radar-precision-v1/);
  assert.match(mediaAnalysis, /ocr_fps/);

  const retrievalResponse = await fetch(`http://127.0.0.1:${port}/retrieval.js`);
  const retrieval = await retrievalResponse.text();
  assert.equal(retrievalResponse.status, 200);
  assert.match(retrieval, /inferQueryIntent/);
  assert.match(retrieval, /calibrateAndDedupe/);

  const imageIndexResponse = await fetch(`http://127.0.0.1:${port}/image-indexing.js`);
  const imageIndex = await imageIndexResponse.text();
  assert.equal(imageIndexResponse.status, 200);
  assert.match(imageIndex, /image-v2-global-regions-ocr/);
});

test("rejects an embedding request without an endpoint", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/wemm/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputs: [{ kind: "text", text: "test" }] })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /服务地址/);
});

test("proxies an embedding response and forwards the API key", async () => {
  const upstreamPort = 43180;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.url, "/embed");
    assert.equal(request.headers.authorization, "Bearer test-key");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.dimension, 256);
    assert.equal(body.priority, "interactive");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ embeddings: [[0.6, 0.8]], dimension: 2 }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/wemm/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: `http://127.0.0.1:${upstreamPort}`,
        apiKey: "test-key",
        dimension: 256,
        inputs: [{ kind: "text", text: "暖色人物" }]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).embeddings, [[0.6, 0.8]]);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("checks the configured WeMM health endpoint", async () => {
  const upstreamPort = 43182;
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/health");
    assert.equal(request.headers.authorization, "Bearer health-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, model: "tencent/WeMM-Embedding-2B", gpu: "RTX 5060" }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/wemm/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${upstreamPort}/embed`, apiKey: "health-key" })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).gpu, "RTX 5060");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streams a multipart video file to the segment indexing endpoint", async () => {
  const upstreamPort = 43181;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.url, "/index-video?dimension=256&segment_seconds=6&overlap_seconds=1&max_segments=0&priority=background");
    assert.equal(request.headers.authorization, "Bearer video-key");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    assert.match(body, /name="file"/);
    assert.match(body, /filename="test-video\.mp4"/);
    assert.match(body, /fake-video/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ duration: 8, segments: [{ start: 0, end: 8, time: 4, embedding: [0.6, 0.8] }] }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const form = new FormData();
    form.append("file", new Blob(["fake-video"], { type: "video/mp4" }), "test-video.mp4");
    const response = await fetch(`http://127.0.0.1:${port}/api/wemm/index-video?dimension=256&segment_seconds=6&overlap_seconds=1&max_segments=0&priority=background`, {
      method: "POST",
      headers: {
        "x-radar-endpoint": `http://127.0.0.1:${upstreamPort}/embed`,
        "x-radar-api-key": "video-key"
      },
      body: form
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).segments[0].time, 4);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("checks the configured media analysis health endpoint", async () => {
  const upstreamPort = 43183;
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/health");
    assert.equal(request.headers.authorization, "Bearer media-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, scene: true, asr: true, ocr: true }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/media/health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${upstreamPort}`, apiKey: "media-key" })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ocr, true);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("reads the authenticated media task status", async () => {
  const upstreamPort = 43185;
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/task-status?task_id=task-123");
    assert.equal(request.headers.authorization, "Bearer media-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task_id: "task-123", status: "running", stage: "ocr", progress: 62, filename: "sample.mp4", scene_count: 18 }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/media/task-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: `http://127.0.0.1:${upstreamPort}/analyze-video`, apiKey: "media-key", taskId: "task-123" })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.task_id, "task-123");
    assert.equal(payload.stage, "ocr");
    assert.equal(payload.progress, 62);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("uploads a long video once to the chunked media task starter", async () => {
  const upstreamPort = 43187;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/analyze-video/start");
    assert.equal(request.headers.authorization, "Bearer chunk-key");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    assert.match(body, /name="file"/);
    assert.match(body, /filename="long-video\.mp4"/);
    assert.match(body, /fake-long-video/);
    assert.match(body, /name="asset_key"/);
    assert.match(body, /asset-long-001/);
    assert.match(body, /name="chunk_seconds"/);
    assert.match(body, /150/);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ task_id: "task-long-001", status: "queued", total_chunks: 5 }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const form = new FormData();
    form.append("file", new Blob(["fake-long-video"], { type: "video/mp4" }), "long-video.mp4");
    form.append("asset_key", "asset-long-001");
    form.append("chunk_seconds", "150");
    const response = await fetch(`http://127.0.0.1:${port}/api/media/analyze-video/start`, {
      method: "POST",
      headers: {
        "x-radar-media-endpoint": `http://127.0.0.1:${upstreamPort}/analyze-video`,
        "x-radar-api-key": "chunk-key"
      },
      body: form
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { task_id: "task-long-001", status: "queued", total_chunks: 5 });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("reads one persisted chunk result from the media service", async () => {
  const upstreamPort = 43188;
  const upstream = http.createServer((request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.url, "/task-result?task_id=task-long-001&chunk_index=3");
    assert.equal(request.headers.authorization, "Bearer chunk-key");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task_id: "task-long-001", chunk_index: 3, timebase: "relative", scenes: [{ start: 1, end: 4 }] }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/media/task-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: `http://127.0.0.1:${upstreamPort}/analyze-video`,
        apiKey: "chunk-key",
        taskId: "task-long-001",
        chunkIndex: 3
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.chunk_index, 3);
    assert.deepEqual(payload.scenes[0], { start: 1, end: 4 });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("retries only the requested failed media chunk", async () => {
  const upstreamPort = 43189;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/retry-chunk");
    assert.equal(request.headers.authorization, "Bearer chunk-key");
    assert.equal(request.headers["content-type"], "application/json");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
      task_id: "task-long-001",
      chunk_index: 3
    });
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ task_id: "task-long-001", chunk_index: 3, status: "queued", attempts: 2 }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/media/retry-chunk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: `http://127.0.0.1:${upstreamPort}/analyze-video`,
        apiKey: "chunk-key",
        taskId: "task-long-001",
        chunkIndex: 3
      })
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { task_id: "task-long-001", chunk_index: 3, status: "queued", attempts: 2 });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streams a multipart video file to the media analysis endpoint", async () => {
  const upstreamPort = 43184;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.url, "/analyze-video");
    assert.equal(request.headers.authorization, "Bearer media-key");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    assert.match(body, /name="file"/);
    assert.match(body, /filename="test-video\.mp4"/);
    assert.match(body, /fake-media-video/);
    assert.match(body, /name="analysis_profile"/);
    assert.match(body, /smart_precision/);
    assert.match(body, /name="ocr_fps"/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ duration: 9, scenes: [{ start: 0, end: 9, keyframe: 4.5 }], transcript: [], ocr: [], warnings: [] }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const form = new FormData();
    form.append("file", new Blob(["fake-media-video"], { type: "video/mp4" }), "test-video.mp4");
    form.append("analysis_profile", "smart_precision");
    form.append("ocr_fps", "2");
    const response = await fetch(`http://127.0.0.1:${port}/api/media/analyze-video`, {
      method: "POST",
      headers: { "x-radar-media-endpoint": `http://127.0.0.1:${upstreamPort}`, "x-radar-api-key": "media-key" },
      body: form
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scenes[0].keyframe, 4.5);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("streams a standalone image to the authenticated OCR endpoint", async () => {
  const upstreamPort = 43186;
  const upstream = http.createServer(async (request, response) => {
    assert.equal(request.url, "/analyze-image");
    assert.equal(request.headers.authorization, "Bearer media-key");
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    assert.match(body, /filename="poster\.png"/);
    assert.match(body, /fake-poster-image/);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ocr: [{ text: "限时优惠", confidence: .98 }] }));
  });
  await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));
  try {
    const form = new FormData();
    form.append("file", new Blob(["fake-poster-image"], { type: "image/png" }), "poster.png");
    const response = await fetch(`http://127.0.0.1:${port}/api/media/analyze-image`, {
      method: "POST",
      headers: { "x-radar-media-endpoint": `http://127.0.0.1:${upstreamPort}`, "x-radar-api-key": "media-key" },
      body: form
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ocr[0].text, "限时优惠");
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("extracts searchable text from an uploaded RTF document", async () => {
  const form = new FormData();
  form.append("file", new Blob([String.raw`{\rtf1\ansi Product launch notes\par Sunset campaign script}`], { type: "application/rtf" }), "campaign.rtf");
  const response = await fetch(`http://127.0.0.1:${port}/api/import/expand`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.kind, "document");
  assert.equal(payload.document.documentType, "RTF");
  assert.match(payload.document.content, /Sunset campaign script/);
});

test("expands supported ZIP entries into separate importable assets", async () => {
  const archive = await createZipBuffer([
    { name: "copy/launch-notes.txt", content: "sunset product launch" },
    { name: "metadata/tags.json", content: JSON.stringify({ mood: "warm" }) },
    { name: "ignored/tool.exe", content: "not-an-asset" }
  ]);
  const form = new FormData();
  form.append("file", new Blob([archive], { type: "application/zip" }), "campaign-pack.zip");
  const response = await fetch(`http://127.0.0.1:${port}/api/import/expand`, { method: "POST", body: form });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.kind, "archive");
  assert.equal(payload.entries.length, 2);
  assert.equal(payload.skipped.length, 1);
  assert.deepEqual(payload.entries.map((entry) => entry.sourcePath).sort(), ["copy/launch-notes.txt", "metadata/tags.json"]);
  assert.equal(Buffer.from(payload.entries[0].data, "base64").toString("utf8"), "sunset product launch");
});
