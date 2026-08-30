import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseImportBuffer, readMultipartFile } from "./import-parser.mjs";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const defaultEndpoint = process.env.WEMM_API_URL || "";
const defaultKey = process.env.WEMM_API_KEY || "";
const defaultMediaEndpoint = process.env.MEDIA_API_URL || "";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 80 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("请求内容过大，单次最多 80MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function resolveEmbedUrl(endpoint) {
  const parsed = new URL(endpoint);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("模型地址必须以 http 或 https 开头");
  if (!parsed.pathname.endsWith("/embed")) parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/embed`;
  return parsed.toString();
}

function resolveModelUrl(endpoint, pathname) {
  const parsed = new URL(endpoint);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("模型地址必须以 http 或 https 开头");
  if (parsed.pathname.endsWith("/embed") || parsed.pathname.endsWith("/health") || parsed.pathname.endsWith("/index-video")) {
    parsed.pathname = parsed.pathname.replace(/\/(embed|health|index-video)$/, "");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${pathname}`;
  return parsed;
}

function resolveMediaUrl(endpoint, pathname) {
  const parsed = new URL(endpoint);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("媒体服务地址必须以 http 或 https 开头");
  if (["/health", "/analyze-video", "/analyze-image", "/task-status", "/analyze-video/start", "/task-result", "/retry-chunk"].some((suffix) => parsed.pathname.endsWith(suffix))) {
    parsed.pathname = parsed.pathname.replace(/\/(health|analyze-video|analyze-image|task-status|task-result|retry-chunk)$/, "").replace(/\/analyze-video\/start$/, "");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${pathname}`;
  return parsed;
}

async function proxyEmbedding(request, response) {
  try {
    const body = await readJson(request);
    const endpoint = String(body.endpoint || defaultEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写 WeMM 服务地址" });
    const target = resolveEmbedUrl(endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({ inputs: body.inputs || [], dimension: body.dimension || 256, priority: body.priority === "background" ? "background" : "interactive" }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "WeMM 服务响应超时" : error.message });
  }
}

async function proxyModelHealth(request, response) {
  try {
    const body = await readJson(request, 64 * 1024);
    const endpoint = String(body.endpoint || defaultEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写 WeMM 服务地址" });
    const target = resolveModelUrl(endpoint, "/health");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(target, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "WeMM 健康检查超时" : error.message });
  }
}

async function proxyVideoIndex(request, response) {
  try {
    const endpoint = String(request.headers["x-radar-endpoint"] || defaultEndpoint).trim();
    const apiKey = String(request.headers["x-radar-api-key"] || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写 WeMM 服务地址" });
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 512 * 1024 * 1024) return json(response, 413, { error: "视频最大支持 512MB" });

    const incoming = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const target = resolveModelUrl(endpoint, "/index-video");
    for (const key of ["dimension", "segment_seconds", "overlap_seconds", "max_segments", "priority"]) {
      if (incoming.searchParams.has(key)) target.searchParams.set(key, incoming.searchParams.get(key));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] || "application/octet-stream",
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: request,
      duplex: "half",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "视频索引超时" : error.message });
  }
}

async function proxyMediaHealth(request, response) {
  try {
    const body = await readJson(request, 64 * 1024);
    const endpoint = String(body.endpoint || defaultMediaEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写媒体分析服务地址" });
    const target = resolveMediaUrl(endpoint, "/health");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const upstream = await fetch(target, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "媒体分析服务健康检查超时" : error.message });
  }
}

async function proxyMediaTaskStatus(request, response) {
  try {
    const body = await readJson(request, 64 * 1024);
    const endpoint = String(body.endpoint || defaultMediaEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写媒体分析服务地址" });
    const target = resolveMediaUrl(endpoint, "/task-status");
    if (body.taskId) target.searchParams.set("task_id", String(body.taskId));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const upstream = await fetch(target, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "媒体任务状态查询超时" : error.message });
  }
}

async function proxyChunkedMediaStart(request, response) {
  try {
    const endpoint = String(request.headers["x-radar-media-endpoint"] || defaultMediaEndpoint).trim();
    const apiKey = String(request.headers["x-radar-api-key"] || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写媒体分析服务地址" });
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 2 * 1024 * 1024 * 1024) return json(response, 413, { error: "长视频最大支持 2GB" });
    const target = resolveMediaUrl(endpoint, "/analyze-video/start");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] || "application/octet-stream",
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: request,
      duplex: "half",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "长视频上传或任务创建超时" : error.message });
  }
}

async function proxyMediaTaskResult(request, response) {
  try {
    const body = await readJson(request, 64 * 1024);
    const endpoint = String(body.endpoint || defaultMediaEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint || !body.taskId || !Number.isInteger(Number(body.chunkIndex))) return json(response, 400, { error: "缺少媒体地址、任务 ID 或分块编号" });
    const target = resolveMediaUrl(endpoint, "/task-result");
    target.searchParams.set("task_id", String(body.taskId)); target.searchParams.set("chunk_index", String(body.chunkIndex));
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    const upstream = await fetch(target, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: controller.signal });
    clearTimeout(timeout); const text = await upstream.text();
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" }); response.end(text);
  } catch (error) { json(response, 502, { error: error.name === "AbortError" ? "分块结果读取超时" : error.message }); }
}

async function proxyMediaChunkRetry(request, response) {
  try {
    const body = await readJson(request, 64 * 1024);
    const endpoint = String(body.endpoint || defaultMediaEndpoint).trim();
    const apiKey = String(body.apiKey || defaultKey).trim();
    if (!endpoint || !body.taskId || !Number.isInteger(Number(body.chunkIndex))) return json(response, 400, { error: "缺少媒体地址、任务 ID 或分块编号" });
    const target = resolveMediaUrl(endpoint, "/retry-chunk");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
    const upstream = await fetch(target, { method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ task_id: body.taskId, chunk_index: Number(body.chunkIndex) }), signal: controller.signal });
    clearTimeout(timeout);
    const text = await upstream.text(); response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" }); response.end(text);
  } catch (error) { json(response, 502, { error: error.name === "AbortError" ? "单块重试请求超时" : error.message }); }
}

async function proxyMediaAnalysis(request, response) {
  try {
    const endpoint = String(request.headers["x-radar-media-endpoint"] || defaultMediaEndpoint).trim();
    const apiKey = String(request.headers["x-radar-api-key"] || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写媒体分析服务地址" });
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 512 * 1024 * 1024) return json(response, 413, { error: "视频最大支持 512MB" });

    const target = resolveMediaUrl(endpoint, "/analyze-video");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60 * 60 * 1000);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] || "application/octet-stream",
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: request,
      duplex: "half",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "媒体分析任务超时" : error.message });
  }
}

async function proxyImageAnalysis(request, response) {
  try {
    const endpoint = String(request.headers["x-radar-media-endpoint"] || defaultMediaEndpoint).trim();
    const apiKey = String(request.headers["x-radar-api-key"] || defaultKey).trim();
    if (!endpoint) return json(response, 400, { error: "还没有填写媒体分析服务地址" });
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 80 * 1024 * 1024) return json(response, 413, { error: "单张图片最大支持 80MB" });
    const target = resolveMediaUrl(endpoint, "/analyze-image");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": request.headers["content-type"] || "application/octet-stream",
        ...(contentLength ? { "content-length": String(contentLength) } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: request,
      duplex: "half",
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(text);
  } catch (error) {
    json(response, 502, { error: error.name === "AbortError" ? "图片文字识别超时" : error.message });
  }
}

async function expandImportFile(request, response) {
  try {
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 512 * 1024 * 1024) return json(response, 413, { error: "单次导入文件最大支持 512MB" });
    const upload = await readMultipartFile(request);
    const result = await parseImportBuffer(upload.buffer, upload.filename);
    return json(response, 200, { ...result, filename: upload.filename, mime: upload.mime });
  } catch (error) {
    const oversized = /最大支持|超过|压缩炸弹/.test(error.message);
    return json(response, oversized ? 413 : 422, { error: error.message });
  }
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const candidate = normalize(join(root, relative));
  if (!candidate.startsWith(root)) return json(response, 403, { error: "禁止访问" });
  try {
    const info = await stat(candidate);
    const file = info.isDirectory() ? join(candidate, "index.html") : candidate;
    const data = await readFile(file);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(data);
  } catch {
    const fallback = await readFile(join(root, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fallback);
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization"
    });
    return response.end();
  }
  if (request.url === "/api/health" && request.method === "GET") {
    return json(response, 200, { ok: true, wemmConfigured: Boolean(defaultEndpoint), mediaConfigured: Boolean(defaultMediaEndpoint) });
  }
  if (request.url === "/api/wemm/embed" && request.method === "POST") {
    return proxyEmbedding(request, response);
  }
  if (request.url === "/api/wemm/health" && request.method === "POST") {
    return proxyModelHealth(request, response);
  }
  if (request.url?.startsWith("/api/wemm/index-video") && request.method === "POST") {
    return proxyVideoIndex(request, response);
  }
  if (request.url === "/api/media/health" && request.method === "POST") {
    return proxyMediaHealth(request, response);
  }
  if (request.url === "/api/media/task-status" && request.method === "POST") {
    return proxyMediaTaskStatus(request, response);
  }
  if (request.url?.startsWith("/api/media/analyze-video/start") && request.method === "POST") {
    return proxyChunkedMediaStart(request, response);
  }
  if (request.url === "/api/media/analyze-video" && request.method === "POST") {
    return proxyMediaAnalysis(request, response);
  }
  if (request.url?.startsWith("/api/media/analyze-image") && request.method === "POST") {
    return proxyImageAnalysis(request, response);
  }
  if (request.url === "/api/media/task-result" && request.method === "POST") {
    return proxyMediaTaskResult(request, response);
  }
  if (request.url === "/api/media/retry-chunk" && request.method === "POST") {
    return proxyMediaChunkRetry(request, response);
  }
  if (request.url === "/api/import/expand" && request.method === "POST") {
    return expandImportFile(request, response);
  }
  return serveStatic(request, response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`素材雷达助手已启动：http://127.0.0.1:${port}`);
});
