const DB_NAME = "creative-asset-radar";
const DB_VERSION = 1;
const STORE_NAME = "assets";
const CONFIG_KEY = "asset-radar-wemm-config";
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "html", "htm", "srt", "vtt", "xml", "yaml", "yml", "log"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "pptx", "xlsx", "rtf", "odt"]);
const ARCHIVE_EXTENSIONS = new Set(["zip"]);
const VIEW_COPY = {
  radar: { title: "综合雷达", description: "用一句描述、一张参考图或一段视频，同时搜索图片、视频与文字素材。", placeholder: "描述你要找的画面、动作、情绪或文案", referenceLabel: "添加任意参考素材", referenceGuide: "可用图片、视频片段或文字作为参照，一次匹配全部类型素材。", type: "all", label: "全部类型" },
  video: { title: "视频搜索", description: "输入脚本，或上传图片与视频片段，直接定位到最接近的镜头时间。", placeholder: "例如：人物从霓虹灯下走向镜头，镜头缓慢推进", referenceLabel: "添加参考画面或脚本", referenceGuide: "可用图片、视频片段或文字脚本，匹配画面与动作相近的视频镜头。", type: "video", label: "只看视频" },
  image: { title: "图片搜索", description: "用文字、参考图或视频片段，找到构图、主体与语义接近的图片。", placeholder: "例如：暖色人物特写，留出右侧标题空间", referenceLabel: "添加参考画面或描述", referenceGuide: "可用图片、视频片段或文字描述，匹配构图、主体与风格相近的图片。", type: "image", label: "只看图片" },
  text: { title: "文字搜索", description: "用一句话、参考图片或视频片段，定位文案、字幕与脚本片段。", placeholder: "输入概念、台词、卖点或语气", referenceLabel: "添加参考画面或文稿", referenceGuide: "可用图片、视频片段或现有文字，匹配语义相近的文案、字幕与脚本。", type: "text", label: "只看文字" }
};

const state = {
  assets: [], type: "all", ratios: new Set(), query: "", queryVector: null,
  reference: null, selectedId: null, selectedResultKey: null, selectedTime: null, selectedRange: null,
  sort: "relevance", searchScope: "segments", view: "radar", indexing: false,
  scriptResults: [], config: loadConfig(), radarActiveUntil: 0,
  modelHealth: "local", mediaHealth: "local", indexController: null, inspectorExpanded: false,
  mediaTask: { status: "unknown", progress: 0, stage: "", filename: "", message: "" }, mediaTaskUpdatedAt: null
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  fileInput: $("#fileInput"), uploadButton: $("#uploadButton"), emptyUploadButton: $("#emptyUploadButton"),
  assetGrid: $("#assetGrid"), emptyState: $("#emptyState"), noResults: $("#noResults"),
  searchInput: $("#searchInput"), searchButton: $("#searchButton"), referenceInput: $("#referenceInput"),
  referenceButton: $("#referenceButton"), referenceButtonLabel: $("#referenceButtonLabel"), referenceGuide: $("#referenceGuide"), referenceChip: $("#referenceChip"), resultSummary: $("#resultSummary"),
  sortSelect: $("#sortSelect"), searchScopeSelect: $("#searchScopeSelect"), inspector: $("#inspector"),
  assetCount: $("#assetCount"), allCount: $("#allCount"), imageCount: $("#imageCount"),
  videoCount: $("#videoCount"), textCount: $("#textCount"), videoDurationCount: $("#videoDurationCount"),
  segmentCount: $("#segmentCount"), pendingIndexCount: $("#pendingIndexCount"), retryIndexButton: $("#retryIndexButton"),
  indexProgress: $("#indexProgress"), progressBar: $("#progressBar"), progressText: $("#progressText"), cancelIndexButton: $("#cancelIndexButton"),
  dropZone: $("#dropZone"), modeRail: $(".mode-rail"), filterButton: $("#filterButton"), railClose: $(".rail-close"),
  exportButton: $("#exportButton"), modelStatus: $("#modelStatus"), settingsButton: $("#settingsButton"),
  settingsDialog: $("#settingsDialog"), endpointInput: $("#endpointInput"), mediaEndpointInput: $("#mediaEndpointInput"), apiKeyInput: $("#apiKeyInput"),
  dimensionInput: $("#dimensionInput"), segmentSecondsInput: $("#segmentSecondsInput"), segmentSecondsValue: $("#segmentSecondsValue"),
  overlapSecondsInput: $("#overlapSecondsInput"), testConnectionButton: $("#testConnectionButton"),
  testMediaConnectionButton: $("#testMediaConnectionButton"), testAllConnectionsButton: $("#testAllConnectionsButton"),
  saveSettingsButton: $("#saveSettingsButton"), connectionResult: $("#connectionResult"), mediaConnectionResult: $("#mediaConnectionResult"),
  wemmServiceState: $("#wemmServiceState"), mediaServiceState: $("#mediaServiceState"),
  radarCanvas: $("#radarCanvas"), viewTitle: $("#viewTitle"), viewDescription: $("#viewDescription"),
  resultsTitle: $("#resultsTitle"), resultModeLabel: $("#resultModeLabel"), scriptPanel: $("#scriptPanel"),
  scriptInput: $("#scriptInput"), scriptHint: $("#scriptHint"), matchScriptButton: $("#matchScriptButton"),
  scriptResults: $("#scriptResults"), toastStack: $("#toastStack"), inspectorBackdrop: $("#inspectorBackdrop"),
  persistStorageButton: $("#persistStorageButton"), storageUsage: $("#storageUsage"),
  taskCenterButton: $("#taskCenterButton"), taskStatusTitle: $("#taskStatusTitle"), taskStatusSummary: $("#taskStatusSummary"),
  taskDialog: $("#taskDialog"), closeTaskDialogButton: $("#closeTaskDialogButton"), remoteTaskPanel: $("#remoteTaskPanel"),
  localTaskList: $("#localTaskList"), localTaskSummary: $("#localTaskSummary"), taskLastUpdated: $("#taskLastUpdated"), refreshTaskStatusButton: $("#refreshTaskStatusButton")
};

const blobUrls = new WeakMap();
let searchTimer;
let dragDepth = 0;
let mediaTaskPollTimer;
let mediaTaskRequest = null;

function loadConfig() {
  const defaults = { endpoint: "", mediaEndpoint: "", apiKey: "", dimension: 256, segmentSeconds: 6, overlapSeconds: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    if (saved.videoProfile && !saved.segmentSeconds) saved.segmentSeconds = saved.videoProfile === "quick" ? 6 : 8;
    return { ...defaults, ...saved };
  } catch { return defaults; }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbRequest(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
const getAllAssets = () => dbRequest("readonly", (store) => store.getAll());
const putAsset = (asset) => dbRequest("readwrite", (store) => store.put(asset));
const removeAsset = (id) => dbRequest("readwrite", (store) => store.delete(id));

function getBlobUrl(blob) {
  if (!blob) return "";
  if (!blobUrls.has(blob)) blobUrls.set(blob, URL.createObjectURL(blob));
  return blobUrls.get(blob);
}
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[char]); }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
function formatLibraryDuration(seconds) {
  if (!seconds) return "00:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}时${String(minutes).padStart(2, "0")}分` : `${Math.max(1, minutes)}分钟`;
}
function formatTaskTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function normalizeTaskProgress(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, number <= 1 && number > 0 ? number * 100 : number));
}
function normalizeMediaTaskPayload(payload = {}) {
  const task = payload.task || payload.current_task || payload.current || payload.active_task || payload.active || payload;
  const statusValue = String(task.status ?? task.state ?? payload.status ?? payload.state ?? "").toLowerCase();
  const running = Boolean(task.running ?? task.is_running ?? payload.running ?? payload.is_running ?? task.busy ?? payload.busy);
  let status = running ? "running" : statusValue;
  if (["active", "processing", "analyzing", "working", "busy", "started"].includes(status)) status = "running";
  else if (["waiting", "pending"].includes(status)) status = "queued";
  else if (["complete", "completed", "done", "success", "succeeded"].includes(status)) status = "succeeded";
  else if (["failure", "failed", "error", "interrupted"].includes(status)) status = "failed";
  else if (["partial", "warning", "completed_with_warnings"].includes(status)) status = "partial";
  else if (["none", "ready", "free", "idle", ""].includes(status)) status = "idle";
  const defaultProgress = status === "succeeded" ? 100 : 0;
  const progress = normalizeTaskProgress(task.progress ?? task.percent ?? task.percentage ?? task.progress_percent ?? payload.progress, defaultProgress);
  return {
    status,
    progress,
    stage: String(task.stage ?? task.current_stage ?? task.step ?? payload.stage ?? "").toLowerCase(),
    filename: String(task.filename ?? task.file_name ?? task.current_file ?? payload.filename ?? payload.current_file ?? ""),
    message: String(task.message ?? task.detail ?? task.error ?? payload.message ?? ""),
    startedAt: task.started_at ?? task.startedAt ?? payload.started_at ?? null,
    finishedAt: task.finished_at ?? task.finishedAt ?? payload.finished_at ?? null,
    taskId: task.task_id ?? task.id ?? payload.task_id ?? "",
    sceneCount: Number(task.scene_count ?? task.scenes ?? payload.scene_count ?? 0) || 0,
    transcriptCount: Number(task.transcript_count ?? task.asr_count ?? payload.transcript_count ?? 0) || 0,
    ocrCount: Number(task.ocr_count ?? payload.ocr_count ?? 0) || 0,
    queuePosition: Number(task.queue_position ?? payload.queue_position ?? 0) || 0,
    raw: payload
  };
}
function taskStageLabel(stage) {
  return ({ upload: "接收视频", scene: "检测镜头", scenes: "检测镜头", asr: "识别语音", speech: "识别语音", ocr: "识别画面文字", embedding: "写入语义向量", index: "写入语义向量", done: "处理完成", failed: "处理失败", stopped: "已停止" })[stage] || (stage ? stage : "等待任务");
}
function taskStatusLabel(status) {
  return ({ unknown: "正在读取", unavailable: "服务不可达", idle: "当前空闲", queued: "等待处理", running: "正在分析", succeeded: "最近已完成", partial: "部分完成", failed: "分析失败" })[status] || status;
}
function localVideoState(asset) {
  if (asset.indexStatus === "indexing") return { key: "running", label: "分析中", detail: taskStageLabel(asset.analysisStage) };
  if (asset.indexStatus === "error") return { key: "error", label: "失败", detail: asset.indexError || "需要重试" };
  if (asset.indexStatus !== "ready") return { key: "queued", label: "待处理", detail: "尚未建立语义索引" };
  if (asset.mediaAnalysisStatus === "ready") return { key: "complete", label: "完整", detail: `${asset.segments?.length || 0} 镜头 · ${asset.transcript?.length || 0} 语音 · ${asset.ocr?.length || 0} OCR` };
  return { key: "partial", label: "部分", detail: `${asset.segments?.length || 0} 个画面片段，语音/OCR 未完成` };
}
function renderTaskCenter() {
  const task = state.mediaTask;
  const statusClass = task.status === "failed" || task.status === "unavailable" ? "error" : task.status;
  elements.taskCenterButton.className = `task-status-button is-${statusClass}`;
  elements.taskStatusTitle.textContent = task.status === "running" ? `分析中 ${Math.round(task.progress)}%` : taskStatusLabel(task.status);
  elements.taskStatusSummary.textContent = task.status === "running" ? `${taskStageLabel(task.stage)}${task.filename ? ` · ${task.filename}` : ""}` : task.message || (task.status === "idle" ? "可以开始新视频" : "点击查看详情");

  const inactive = task.status === "idle" || task.status === "unknown" || task.status === "unavailable";
  const title = task.filename || (task.status === "idle" ? "拯救者当前没有分析任务" : taskStatusLabel(task.status));
  const description = task.status === "idle" ? "现在可以安全地开始下一个视频，刷新网页也不会再误触发并发任务。" : task.status === "unavailable" ? "网页暂时无法读取 8001 的任务状态，请检查拯救者网络和服务。" : `${taskStageLabel(task.stage)}${task.startedAt ? ` · 开始于 ${formatTaskTime(task.startedAt)}` : ""}`;
  elements.remoteTaskPanel.className = `remote-task-card is-${statusClass}`;
  elements.remoteTaskPanel.innerHTML = `<div class="remote-task-head"><div><p class="remote-task-kicker">LEGION · MEDIA TOOLS</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><span class="task-state-badge">${escapeHtml(taskStatusLabel(task.status))}</span></div>
    <div class="task-progress-track" aria-label="任务进度"><span style="width:${inactive ? 0 : Math.round(task.progress)}%"></span></div>
    <div class="task-progress-meta"><strong>${escapeHtml(taskStageLabel(task.stage))}</strong><span>${inactive ? "—" : `${Math.round(task.progress)}%`}</span></div>
    <div class="task-metrics"><div><span>镜头</span><strong>${task.sceneCount || "—"}</strong></div><div><span>语音</span><strong>${task.transcriptCount || "—"}</strong></div><div><span>OCR</span><strong>${task.ocrCount || "—"}</strong></div><div><span>任务 ID</span><strong>${escapeHtml(String(task.taskId || "—"))}</strong></div></div>
    ${task.message ? `<p class="task-message">${escapeHtml(task.message)}</p>` : ""}`;

  const videos = state.assets.filter((asset) => asset.type === "video").sort((a, b) => b.updatedAt - a.updatedAt);
  const complete = videos.filter((asset) => localVideoState(asset).key === "complete").length;
  const partial = videos.filter((asset) => localVideoState(asset).key === "partial").length;
  elements.localTaskSummary.textContent = `${complete} 完整 · ${partial} 部分 · ${videos.length} 总计`;
  elements.localTaskList.innerHTML = videos.length ? videos.map((asset) => {
    const local = localVideoState(asset);
    return `<div class="local-task-row is-${local.key}"><i></i><div class="local-task-copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(local.detail)}</small></div><span class="local-task-state">${local.label}</span></div>`;
  }).join("") : `<div class="local-task-empty">还没有导入视频素材</div>`;
  elements.taskLastUpdated.textContent = state.mediaTaskUpdatedAt ? `最后更新 ${formatTaskTime(state.mediaTaskUpdatedAt)}` : "尚未读取任务状态";
}
function scheduleMediaTaskPoll(delay) {
  clearTimeout(mediaTaskPollTimer);
  if (!state.config.mediaEndpoint) return;
  mediaTaskPollTimer = setTimeout(() => refreshMediaTaskStatus(true), delay);
}
async function refreshMediaTaskStatus(silent = false) {
  if (!state.config.mediaEndpoint) {
    state.mediaTask = { status: "idle", progress: 0, stage: "", filename: "", message: "媒体分析服务未配置" };
    renderTaskCenter(); return state.mediaTask;
  }
  if (mediaTaskRequest) return mediaTaskRequest;
  if (!silent) { elements.refreshTaskStatusButton.disabled = true; elements.refreshTaskStatusButton.classList.add("is-loading"); }
  mediaTaskRequest = (async () => {
    try {
      const response = await fetch("/api/media/task-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: state.config.mediaEndpoint, apiKey: state.config.apiKey }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.detail || "无法读取媒体任务状态");
      state.mediaTask = normalizeMediaTaskPayload(payload); state.mediaTaskUpdatedAt = Date.now(); renderTaskCenter();
      scheduleMediaTaskPoll(["running", "queued"].includes(state.mediaTask.status) ? 2500 : 10000);
      return state.mediaTask;
    } catch (error) {
      state.mediaTask = { status: "unavailable", progress: 0, stage: "", filename: "", message: error.message };
      state.mediaTaskUpdatedAt = Date.now(); renderTaskCenter(); scheduleMediaTaskPoll(15000);
      if (!silent) toast(`任务状态读取失败：${error.message}`, "error");
      return state.mediaTask;
    } finally {
      mediaTaskRequest = null;
      elements.refreshTaskStatusButton.disabled = false; elements.refreshTaskStatusButton.classList.remove("is-loading");
    }
  })();
  return mediaTaskRequest;
}
function fileFingerprint(file, sourceIdentity = "") { return `${sourceIdentity || file.name}:${file.size}:${file.lastModified || 0}`; }
async function updateStorageStatus() {
  if (!navigator.storage?.estimate) { elements.storageUsage.textContent = "浏览器未提供空间信息"; return; }
  const [{ usage = 0, quota = 0 }, persisted = false] = await Promise.all([
    navigator.storage.estimate(), navigator.storage.persisted?.() ?? false
  ]);
  elements.storageUsage.textContent = `${persisted ? "持久保存" : "点击申请持久保存"} · 已用 ${formatBytes(usage)} / ${formatBytes(quota)}`;
}
async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return toast("当前浏览器不支持持久存储申请", "error");
  const granted = await navigator.storage.persist();
  await updateStorageStatus();
  toast(granted ? "浏览器已尽量避免自动清理素材" : "浏览器未授予持久保存，建议保留原始文件备份", granted ? "normal" : "error");
}
function toast(message, type = "normal") {
  const node = document.createElement("div");
  node.className = `toast${type === "error" ? " is-error" : ""}`;
  node.textContent = message;
  elements.toastStack.append(node);
  setTimeout(() => node.remove(), 3600);
}
function once(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { target.removeEventListener(eventName, success); target.removeEventListener("error", fail); };
    const success = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("媒体文件无法读取")); };
    target.addEventListener(eventName, success, { once: true });
    target.addEventListener("error", fail, { once: true });
  });
}
function normalizeVector(vector) {
  const norm = Math.sqrt((vector || []).reduce((sum, value) => sum + value * value, 0)) || 1;
  return (vector || []).map((value) => value / norm);
}
function cosine(a, b) { return !a?.length || !b?.length || a.length !== b.length ? 0 : a.reduce((sum, value, index) => sum + value * b[index], 0); }
function averageVectors(vectors) {
  const valid = vectors.filter((vector) => vector?.length);
  if (!valid.length) return null;
  const output = Array(valid[0].length).fill(0);
  valid.forEach((vector) => vector.forEach((value, index) => { output[index] += value; }));
  return normalizeVector(output.map((value) => value / valid.length));
}

function createCanvas(source, maxWidth = 960) {
  const width = source.videoWidth || source.naturalWidth || source.width;
  const height = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}
const canvasBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .82));
function visualVectorFromCanvas(canvas) {
  const sample = document.createElement("canvas"); sample.width = 32; sample.height = 32;
  const context = sample.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  const vector = [];
  for (let cy = 0; cy < 4; cy += 1) for (let cx = 0; cx < 4; cx += 1) {
    let r = 0, g = 0, b = 0;
    for (let y = cy * 8; y < cy * 8 + 8; y += 1) for (let x = cx * 8; x < cx * 8 + 8; x += 1) {
      const offset = (y * 32 + x) * 4; r += pixels[offset]; g += pixels[offset + 1]; b += pixels[offset + 2];
    }
    vector.push(r / 16320, g / 16320, b / 16320);
  }
  return normalizeVector(vector);
}
function classifyRatio(width, height) { const ratio = width / height; return ratio > 1.16 ? "landscape" : ratio < .86 ? "portrait" : "square"; }
function ratioLabel(value) { return ({ portrait: "竖屏", landscape: "横屏", square: "方形", document: "文档" })[value] || value; }
function tagsFromFilename(name) { return name.replace(/\.[^.]+$/, "").split(/[\s_\-()[\]【】]+/).map((tag) => tag.trim()).filter((tag) => tag.length > 1).slice(0, 6); }
function colorTags(vector) {
  if (!vector?.length) return [];
  const sums = [0, 0, 0];
  for (let index = 0; index < vector.length; index += 3) { sums[0] += vector[index] || 0; sums[1] += vector[index + 1] || 0; sums[2] += vector[index + 2] || 0; }
  const max = Math.max(...sums) || 1; const [r, g, b] = sums.map((value) => value / max);
  if (Math.max(r, g, b) - Math.min(r, g, b) < .12) return ["中性色"];
  if (b > r * 1.12 && b > g * 1.05) return ["冷色", "蓝色", "科技感"];
  if (r > b * 1.12) return ["暖色"];
  if (g > r * 1.08 && g > b * 1.08) return ["绿色", "自然"];
  return ["多彩"];
}
function fileKind(file) {
  const extension = file.name.split(".").pop().toLowerCase();
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

async function processImage(file) {
  const image = new Image(); image.src = getBlobUrl(file); await once(image, "load");
  const canvas = createCanvas(image); const visualVector = visualVectorFromCanvas(canvas);
  return { width: image.naturalWidth, height: image.naturalHeight, duration: null, thumbnail: await canvasBlob(canvas), visualVector, moments: [], content: "", ratio: classifyRatio(image.naturalWidth, image.naturalHeight), tags: [...new Set([...tagsFromFilename(file.name), ...colorTags(visualVector), "图片"])] };
}
async function captureVideoFrame(video, time) {
  const safe = Math.min(Math.max(time, .05), Math.max(.05, video.duration - .05));
  if (Math.abs(video.currentTime - safe) > .02) { video.currentTime = safe; await once(video, "seeked"); }
  const canvas = createCanvas(video);
  return { time: safe, thumbnail: await canvasBlob(canvas), visualVector: visualVectorFromCanvas(canvas) };
}
async function processVideo(file) {
  const video = document.createElement("video"); video.preload = "metadata"; video.muted = true; video.playsInline = true; video.src = getBlobUrl(file);
  await once(video, "loadedmetadata");
  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const moments = [];
  for (const ratio of duration > 1 ? [.12, .5, .88] : [.1]) moments.push(await captureVideoFrame(video, duration * ratio));
  const main = moments[Math.floor(moments.length / 2)];
  return { width: video.videoWidth, height: video.videoHeight, duration, thumbnail: main.thumbnail, visualVector: main.visualVector, moments, content: "", ratio: classifyRatio(video.videoWidth, video.videoHeight), tags: [...new Set([...tagsFromFilename(file.name), ...colorTags(main.visualVector), "视频"])] };
}
async function processText(file) {
  const content = (await file.text()).replace(/\u0000/g, "").trim();
  if (!content) throw new Error("文本文件为空");
  return { width: 960, height: 600, duration: null, thumbnail: null, visualVector: null, moments: [], content, excerpt: content.slice(0, 260), ratio: "document", tags: [...new Set([...tagsFromFilename(file.name), "文字", file.name.split(".").pop().toUpperCase()]) ] };
}
function processDocument(file, document = {}) {
  const extension = file.name.split(".").pop().toUpperCase();
  const warning = String(document.warning || document.parseWarning || "").trim();
  const content = String(document.content || document.extractedText || "").replace(/\u0000/g, "").trim() || `${file.name}\n${warning || "文档暂未提取到可搜索文字"}`;
  const documentType = document.documentType || extension;
  return { width: 960, height: 600, duration: null, thumbnail: null, visualVector: null, moments: [], content, excerpt: content.slice(0, 260), ratio: "document", documentType, pageCount: document.pageCount || null, parseWarning: warning, tags: [...new Set([...tagsFromFilename(file.name), "文档", "文字", documentType])] };
}
async function requestImportExpansion(file) {
  const form = new FormData(); form.append("file", file, file.name);
  const response = await fetch("/api/import/expand", { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "文件解析失败");
  return payload;
}
function blobFromBase64(data, mime) {
  const binary = atob(data); const chunks = []; const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize); const bytes = new Uint8Array(slice.length);
    for (let index = 0; index < slice.length; index += 1) bytes[index] = slice.charCodeAt(index);
    chunks.push(bytes);
  }
  return new Blob(chunks, { type: mime || "application/octet-stream" });
}
async function prepareImportItems(fileList) {
  const selected = [...fileList]; const items = []; const reports = []; let rejected = 0;
  for (const file of selected) {
    const kind = fileKind(file);
    if (!kind) { rejected += 1; continue; }
    if (kind !== "archive") { items.push({ file }); continue; }
    elements.progressText.textContent = `正在安全拆分 ${file.name}`;
    const payload = await requestImportExpansion(file);
    for (const entry of payload.entries || []) {
      const blob = blobFromBase64(entry.data, entry.mime);
      const extracted = new File([blob], entry.name, { type: entry.mime || blob.type, lastModified: file.lastModified || Date.now() });
      items.push({ file: extracted, sourceContainer: file.name, sourcePath: entry.sourcePath, extractedText: entry.extractedText, documentType: entry.documentType, pageCount: entry.pageCount, parseWarning: entry.parseWarning });
    }
    reports.push({ name: file.name, imported: payload.entries?.length || 0, skipped: payload.skipped?.length || 0 });
  }
  return { items, reports, rejected };
}
async function processFile(file, importMeta = {}) {
  const inputType = fileKind(file);
  if (!inputType || inputType === "archive") throw new Error("不支持这个文件格式");
  let media;
  if (inputType === "image") media = await processImage(file);
  else if (inputType === "video") media = await processVideo(file);
  else if (inputType === "document") {
    const document = importMeta.extractedText !== undefined ? importMeta : (await requestImportExpansion(file)).document;
    media = processDocument(file, document);
  } else media = await processText(file);
  const type = inputType === "document" ? "text" : inputType;
  const sourceIdentity = importMeta.sourcePath ? `${importMeta.sourceContainer}/${importMeta.sourcePath}` : "";
  if (importMeta.sourceContainer) media.tags = [...new Set([...(media.tags || []), "ZIP", importMeta.sourceContainer.replace(/\.zip$/i, "")])];
  return { id: crypto.randomUUID(), name: file.name, type, mime: file.type || (type === "text" ? "text/plain" : "application/octet-stream"), size: file.size, sourceModifiedAt: file.lastModified || 0, fingerprint: fileFingerprint(file, sourceIdentity), sourceContainer: importMeta.sourceContainer || null, sourcePath: importMeta.sourcePath || null, blob: file, createdAt: Date.now(), updatedAt: Date.now(), uses: 0, lastUsedAt: null, wemmVector: null, segments: [], indexStatus: "pending", indexMode: null, indexedSignature: null, indexError: null, ...media };
}

async function importFiles(fileList) {
  if (![...fileList].some(fileKind)) return toast("请选择图片、视频、文档、文字或 ZIP 压缩包", "error");
  elements.indexProgress.hidden = false; elements.cancelIndexButton.hidden = true; state.indexing = true; radarPulse(4000);
  let imported = 0; let skipped = 0; let prepared;
  try { prepared = await prepareImportItems(fileList); }
  catch (error) { state.indexing = false; elements.indexProgress.hidden = true; return toast(`文件拆分失败：${error.message}`, "error"); }
  const files = prepared.items;
  if (!files.length) { state.indexing = false; elements.indexProgress.hidden = true; return toast("压缩包内没有可识别素材", "error"); }
  for (let index = 0; index < files.length; index += 1) {
    const item = files[index]; const file = item.file; const sourceIdentity = item.sourcePath ? `${item.sourceContainer}/${item.sourcePath}` : "";
    elements.progressBar.style.width = `${Math.round(index / files.length * 100)}%`;
    elements.progressText.textContent = `${item.sourceContainer ? `正在从 ${item.sourceContainer} 导入` : "正在读取"} ${file.name}，${index + 1}/${files.length}`;
    const fingerprint = fileFingerprint(file, sourceIdentity);
    const duplicate = state.assets.some((asset) => asset.fingerprint === fingerprint || (!asset.fingerprint && asset.name === file.name && asset.size === file.size));
    if (duplicate) { skipped += 1; continue; }
    try { const asset = await processFile(file, item); await putAsset(asset); state.assets.unshift(asset); imported += 1; }
    catch (error) { toast(`${file.name} 导入失败：${error.message}`, "error"); }
    renderAll();
  }
  const archiveSkipped = prepared.reports.reduce((sum, report) => sum + report.skipped, 0); skipped += archiveSkipped + prepared.rejected;
  elements.progressBar.style.width = "100%"; elements.progressText.textContent = `已导入 ${imported} 个素材${skipped ? `，跳过 ${skipped} 个重复或不支持文件` : ""}`;
  state.indexing = false; setTimeout(() => { elements.indexProgress.hidden = true; }, 1200);
  const archiveCount = prepared.reports.length; toast(`${archiveCount ? `已拆分 ${archiveCount} 个压缩包，` : ""}已导入 ${imported} 个素材${skipped ? `，跳过 ${skipped} 个文件` : ""}`);
  updateStorageStatus();
  if (state.config.endpoint && imported) await indexMissingWithWemm();
}

function expandQuery(query) {
  const map = { 暖色: ["暖色", "红色", "黄色", "日落"], 冷色: ["冷色", "蓝色", "科技感"], 科技: ["科技", "蓝色", "冷色"], 自然: ["自然", "绿色", "户外"], 竖屏: ["竖屏", "portrait"], 横屏: ["横屏", "landscape"], 视频: ["视频", "video"], 图片: ["图片", "image"], 文字: ["文字", "文案", "字幕", "text"] };
  return [...new Set(query.trim().toLowerCase().split(/[\s,，。;；]+/).filter(Boolean).flatMap((term) => map[term] || [term]))];
}
function localTextScore(asset, query) {
  if (!query.trim()) return 0;
  const mediaText = [...(asset.transcript || []).map((item) => item.text), ...(asset.ocr || []).map((item) => item.text), ...(asset.segments || []).map((item) => item.content || "")].join(" ");
  const haystack = `${asset.name} ${(asset.tags || []).join(" ")} ${asset.content || ""} ${mediaText} ${ratioLabel(asset.ratio)} ${asset.type}`.toLowerCase();
  const terms = expandQuery(query); const hits = terms.filter((term) => haystack.includes(term)).length;
  return terms.length ? hits / Math.min(terms.length, 5) : 0;
}
function localSegmentTextScore(segment, query) {
  if (!query.trim()) return 0;
  const haystack = String(segment.content || "").toLowerCase();
  const terms = expandQuery(query); const hits = terms.filter((term) => haystack.includes(term)).length;
  return terms.length ? hits / Math.min(terms.length, 5) : 0;
}
function scoreSegment(segment) {
  const scores = [];
  const semanticQuery = state.queryVector || state.reference?.wemmVector;
  if (semanticQuery && segment.wemmVector) scores.push(Math.max(0, cosine(semanticQuery, segment.wemmVector)));
  if (state.query) { const local = localSegmentTextScore(segment, state.query); if (local) scores.push(Math.min(1, local)); }
  if (state.reference?.content) { const local = localSegmentTextScore(segment, state.reference.content.slice(0, 300)); if (local) scores.push(Math.min(1, local)); }
  if (state.reference?.visualVector && segment.visualVector) scores.push(Math.max(0, cosine(state.reference.visualVector, segment.visualVector)));
  return scores.length ? Math.max(...scores) : 0;
}
function resultKeyForSegment(asset, segment, index = 0) {
  return `shot:${asset.id}:${segment.order ?? index}:${Number(segment.start ?? segment.time ?? 0).toFixed(3)}:${Number(segment.end ?? segment.time ?? 0).toFixed(3)}`;
}
function scoreAsset(asset) {
  const scores = []; let bestSegment = null;
  const semanticQuery = state.queryVector || state.reference?.wemmVector;
  if (semanticQuery && asset.wemmVector) scores.push(Math.max(0, cosine(semanticQuery, asset.wemmVector)));
  if (semanticQuery && asset.segments?.length && state.searchScope === "segments") {
    const ranked = asset.segments.map((segment) => ({ ...segment, score: Math.max(0, cosine(semanticQuery, segment.wemmVector)) })).sort((a, b) => b.score - a.score);
    bestSegment = ranked[0] || null; if (bestSegment) scores.push(bestSegment.score);
  }
  if (state.query) { const local = localTextScore(asset, state.query); if (local) scores.push(Math.min(1, local)); }
  if (state.reference?.content) { const local = localTextScore(asset, state.reference.content.slice(0, 300)); if (local) scores.push(Math.min(1, local)); }
  if (state.reference?.visualVector && asset.visualVector) scores.push(Math.max(0, cosine(state.reference.visualVector, asset.visualVector)));
  return { score: scores.length ? Math.max(...scores) : 0, bestSegment };
}
function currentViewType() { return VIEW_COPY[state.view]?.type || "all"; }
function filteredAssets() {
  const viewType = currentViewType(); const hasSearch = Boolean(state.query || state.reference);
  const sourceAssets = state.assets.filter((asset) => {
    if (viewType !== "all" && asset.type !== viewType) return false;
    if (state.type !== "all" && asset.type !== state.type) return false;
    if (state.ratios.size && asset.type !== "text" && !state.ratios.has(asset.ratio)) return false;
    return true;
  });
  let assets;
  if (hasSearch && state.searchScope === "segments") {
    assets = sourceAssets.flatMap((asset) => {
      if (asset.type !== "video" || !asset.segments?.length) {
        const scored = scoreAsset(asset);
        return [{ ...asset, resultKey: `asset:${asset.id}`, searchScore: scored.score, bestSegment: scored.bestSegment, isShotResult: false }];
      }
      return asset.segments.map((segment, index) => {
        const score = scoreSegment(segment);
        return { ...asset, resultKey: resultKeyForSegment(asset, segment, index), searchScore: score, bestSegment: { ...segment, score }, isShotResult: true };
      });
    });
  } else {
    assets = sourceAssets.map((asset) => {
      const scored = scoreAsset(asset);
      return { ...asset, resultKey: `asset:${asset.id}`, searchScore: scored.score, bestSegment: scored.bestSegment, isShotResult: false };
    });
  }
  if (hasSearch) assets = assets.filter((asset) => asset.searchScore > 0);
  assets.sort((a, b) => state.sort === "newest" ? b.createdAt - a.createdAt : state.sort === "used" ? b.uses - a.uses || b.createdAt - a.createdAt : b.searchScore - a.searchScore || b.createdAt - a.createdAt);
  return assets;
}

function renderCounts() {
  const count = (type) => state.assets.filter((asset) => asset.type === type).length;
  elements.assetCount.textContent = state.assets.length; elements.allCount.textContent = state.assets.length;
  elements.imageCount.textContent = count("image"); elements.videoCount.textContent = count("video"); elements.textCount.textContent = count("text");
  elements.videoDurationCount.textContent = formatLibraryDuration(state.assets.reduce((sum, asset) => sum + (asset.duration || 0), 0));
  elements.segmentCount.textContent = state.assets.reduce((sum, asset) => sum + (asset.segments?.length || 0), 0);
  elements.pendingIndexCount.textContent = state.assets.filter((asset) => asset.indexStatus !== "ready").length;
}
function iconForType(type) { return type === "video" ? "i-video" : type === "image" ? "i-image" : "i-text"; }
function typeLabel(type) { return type === "video" ? "VIDEO" : type === "image" ? "IMAGE" : "TEXT"; }
function assetKindLabel(asset) { return asset.documentType || typeLabel(asset.type); }
function indexStatusLabel(asset) { return asset.indexStatus === "ready" ? "INDEXED" : asset.indexStatus === "error" ? "RETRY" : asset.indexStatus === "indexing" ? "ANALYZING" : "PENDING"; }
function previewMarkup(asset) {
  if (asset.type === "text") return `<div class="text-preview${asset.documentType ? " is-document" : ""}" data-document-type="${escapeHtml(asset.documentType || "TXT")}">${escapeHtml(asset.bestSegment?.content || asset.excerpt || asset.content?.slice(0, 220) || "文字素材")}</div>`;
  const preview = asset.bestSegment?.thumbnail || asset.thumbnail;
  return `<img src="${getBlobUrl(preview)}" alt="${escapeHtml(asset.name)} 的缩略图"/>${asset.type === "video" ? `<span class="play-marker"><svg><use href="#i-play"/></svg></span>` : ""}`;
}
function renderAssets() {
  const assets = filteredAssets(); const empty = state.assets.length === 0;
  elements.emptyState.hidden = !empty; elements.assetGrid.hidden = empty || assets.length === 0; elements.noResults.hidden = empty || assets.length > 0;
  const isSearching = Boolean(state.query || state.reference);
  const shotCount = assets.filter((asset) => asset.isShotResult).length;
  const sourceCount = new Set(assets.map((asset) => asset.id)).size;
  const resultUnit = isSearching && state.searchScope === "segments" && shotCount
    ? `命中 ${shotCount} 个视频镜头${assets.length > shotCount ? `和 ${assets.length - shotCount} 个其他素材` : ""}，来自 ${sourceCount} 个素材`
    : `${isSearching ? "命中" : "显示"} ${assets.length} 个素材`;
  elements.resultSummary.textContent = empty ? "导入素材后即可开始搜索" : `${resultUnit}${isSearching && state.queryVector ? "，已按语义相关度排列" : ""}`;
  if (empty) { elements.assetGrid.innerHTML = ""; return; }
  elements.assetGrid.innerHTML = assets.map((asset, index) => {
    const match = isSearching && asset.searchScore > 0 ? `<span class="asset-score">${Math.round(asset.searchScore * 100)}%</span>` : "";
    const range = asset.bestSegment ? asset.type === "video" ? `${formatDuration(asset.bestSegment.start)}–${formatDuration(asset.bestSegment.end)}` : `段落 ${Number(asset.bestSegment.order || 0) + 1}` : null;
    const detail = asset.isShotResult ? `${formatDuration(Math.max(0, asset.bestSegment.end - asset.bestSegment.start))} 镜头 · 原片 ${formatDuration(asset.duration)}` : asset.type === "video" ? `${formatDuration(asset.duration)} · ${asset.segments?.length || 0} 段` : asset.type === "image" ? `${asset.width}×${asset.height}` : `${(asset.content || "").length} 字`;
    const excerpt = asset.type === "text" ? asset.bestSegment?.content || asset.excerpt : asset.isShotResult && asset.bestSegment?.content ? asset.bestSegment.content : range ? `${asset.isShotResult ? "命中镜头" : "优先命中"} ${range}` : `${(asset.tags || []).slice(0, 3).join(" · ") || "等待语义索引"}`;
    const selected = state.selectedResultKey === asset.resultKey || (!state.selectedResultKey && state.selectedId === asset.id);
    const typeLine = `${asset.isShotResult ? "VIDEO SHOT" : assetKindLabel(asset)}${asset.sourceContainer ? " · ZIP" : ""}`;
    return `<article class="asset-card is-entering${selected ? " is-selected" : ""}" data-id="${asset.id}" data-result-key="${escapeHtml(asset.resultKey)}" style="animation-delay:${Math.min(index, 8) * 35}ms">
      <button class="asset-preview" data-action="select" aria-label="查看 ${escapeHtml(asset.name)}">${previewMarkup(asset)}<span class="asset-badge"><svg><use href="#${iconForType(asset.type)}"/></svg>${range || assetKindLabel(asset)}</span>${match}</button>
      <div class="asset-body"><div class="asset-type-line"><span>${typeLine} · ${indexStatusLabel(asset)}</span>${range ? `<em>${range}</em>` : ""}</div><h3 title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</h3><p>${escapeHtml(excerpt || "")}</p><div class="asset-meta"><span>${detail}</span><span>${formatBytes(asset.size)}</span><div class="asset-actions"><button data-action="download" aria-label="下载原文件"><svg><use href="#i-download"/></svg></button><button data-action="delete" aria-label="删除素材"><svg><use href="#i-trash"/></svg></button></div></div></div>
    </article>`;
  }).join("");
  radar.setBlips(assets);
}
function renderReference() {
  elements.referenceChip.hidden = !state.reference;
  if (!state.reference) { elements.referenceChip.innerHTML = ""; return; }
  const media = state.reference.thumbnail ? `<img src="${getBlobUrl(state.reference.thumbnail)}" alt="参考文件"/>` : `<span class="reference-file-icon"><svg><use href="#${iconForType(state.reference.type)}"/></svg></span>`;
  elements.referenceChip.innerHTML = `${media}<span>${escapeHtml(state.reference.name)}</span><button aria-label="移除参考文件"><svg><use href="#i-close"/></svg></button>`;
  elements.referenceChip.querySelector("button").addEventListener("click", () => { state.reference = null; renderAll(); });
}
function renderView() {
  const copy = VIEW_COPY[state.view] || VIEW_COPY.radar;
  elements.viewTitle.textContent = copy.title; elements.viewDescription.textContent = copy.description;
  elements.searchInput.placeholder = copy.placeholder; elements.referenceButtonLabel.textContent = copy.referenceLabel; elements.referenceGuide.textContent = copy.referenceGuide; elements.resultModeLabel.textContent = copy.label;
  elements.resultsTitle.textContent = state.view === "radar" ? "雷达结果" : `${copy.title}结果`;
  elements.scriptPanel.hidden = state.view !== "video";
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === state.view));
  document.querySelectorAll('input[name="type"]').forEach((input) => { input.disabled = copy.type !== "all"; if (copy.type !== "all") input.checked = input.value === "all"; });
  if (copy.type !== "all") state.type = "all";
  renderAssets();
}

function inspectorMedia(asset) {
  if (asset.type === "video") return `<video id="inspectorVideo" src="${getBlobUrl(asset.blob)}" poster="${getBlobUrl(asset.bestSegment?.thumbnail || asset.thumbnail)}" controls preload="metadata"></video>${state.selectedRange ? `<span class="match-range">命中 ${formatDuration(state.selectedRange.start)}–${formatDuration(state.selectedRange.end)}</span>` : ""}`;
  if (asset.type === "image") return `<img src="${getBlobUrl(asset.thumbnail)}" alt="${escapeHtml(asset.name)}"/>`;
  return `<div class="inspector-text">${escapeHtml(asset.content)}</div>`;
}
function setInspectorExpanded(expanded) {
  state.inspectorExpanded = Boolean(expanded && state.selectedId);
  elements.inspector.classList.toggle("is-expanded", state.inspectorExpanded);
  elements.inspectorBackdrop.hidden = !state.inspectorExpanded;
  elements.inspector.setAttribute("aria-modal", String(state.inspectorExpanded));
}
function renderInspector() {
  const asset = state.assets.find((item) => item.id === state.selectedId);
  elements.inspector.classList.toggle("is-open", Boolean(asset));
  if (!asset) { setInspectorExpanded(false); elements.inspector.innerHTML = `<div class="inspector-empty"><span class="empty-cross"></span><p>选择一个结果，查看命中时间、原文件与索引信息。</p></div>`; return; }
  setInspectorExpanded(state.inspectorExpanded);
  const timeline = asset.segments || [];
  const segments = timeline.length ? `<div class="inspector-section"><div class="section-heading-inline"><h3>${asset.type === "text" ? "文字分段" : "可检索片段"}</h3><span>${timeline.length} 段</span></div><div class="moment-strip">${timeline.map((segment) => {
    const score = (state.queryVector || state.reference?.wemmVector) && segment.wemmVector ? Math.max(0, cosine(state.queryVector || state.reference.wemmVector, segment.wemmVector)) : null;
    if (asset.type === "text") return `<button class="moment-button" data-order="${segment.order || 0}"><span>${escapeHtml((segment.content || "").slice(0, 100))}</span>${score !== null ? `<em>${Math.round(score * 100)}%</em>` : ""}</button>`;
    return `<button class="moment-button" data-time="${segment.time}" data-start="${segment.start ?? segment.time}" data-end="${segment.end ?? segment.time}"><img src="${getBlobUrl(segment.thumbnail || asset.thumbnail)}" alt="${formatDuration(segment.time)} 的画面"/><span>${formatDuration(segment.start ?? segment.time)}–${formatDuration(segment.end ?? segment.time)}</span>${segment.content ? `<small>${escapeHtml(segment.content.slice(0, 64))}</small>` : ""}${score !== null ? `<em>${Math.round(score * 100)}%</em>` : ""}</button>`;
  }).join("")}</div></div>` : "";
  const insightItems = [
    ...(asset.transcript || []).slice(0, 6).map((item) => ({ type: "语音", time: item.start, text: item.text })),
    ...(asset.ocr || []).slice(0, 6).map((item) => ({ type: "画面文字", time: item.time, text: item.text }))
  ].sort((a, b) => a.time - b.time);
  const warningText = (asset.analysisWarnings || []).length ? `<p class="analysis-warning">${escapeHtml(asset.analysisWarnings.join("；"))}</p>` : "";
  const mediaInsights = asset.type === "video" && (insightItems.length || warningText) ? `<div class="inspector-section"><div class="section-heading-inline"><h3>语音与画面文字</h3><span>${(asset.transcript || []).length + (asset.ocr || []).length} 条</span></div>${insightItems.length ? `<div class="analysis-list">${insightItems.map((item) => `<button data-time="${item.time}" data-start="${item.time}" data-end="${item.time}"><b>${item.type} · ${formatDuration(item.time)}</b><span>${escapeHtml(item.text)}</span></button>`).join("")}</div>` : ""}${warningText}</div>` : "";
  const sizeInfo = asset.type === "text" ? `${(asset.content || "").length} 字` : `${asset.width} × ${asset.height}`;
  const sourceMeta = asset.sourceContainer ? `<div><span>压缩包来源</span><strong>${escapeHtml(asset.sourceContainer)}</strong></div><div><span>包内路径</span><strong>${escapeHtml(asset.sourcePath || asset.name)}</strong></div>` : "";
  const documentMeta = asset.documentType ? `<div><span>文档格式</span><strong>${escapeHtml(asset.documentType)}</strong></div>${asset.pageCount ? `<div><span>页数</span><strong>${asset.pageCount} 页</strong></div>` : ""}` : "";
  const parseWarning = asset.parseWarning ? `<p class="analysis-warning">${escapeHtml(asset.parseWarning)}</p>` : "";
  const expandButton = asset.type === "video" ? `<button class="icon-button" data-action="expand" aria-label="${state.inspectorExpanded ? "退出大窗口审片" : "打开大窗口审片"}"><svg><use href="#i-expand"/></svg></button>` : "";
  const reindexButton = asset.type === "video" ? `<button class="secondary-button" data-action="reindex-one"><svg><use href="#i-refresh"/></svg>重新分析</button>` : "";
  const recovery = asset.indexError ? `<div class="error-recovery"><p>${escapeHtml(asset.indexError)}</p><button class="secondary-button" data-action="retry-index"><svg><use href="#i-refresh"/></svg>重试这个素材</button></div>` : "";
  elements.inspector.innerHTML = `<div class="inspector-content"><div class="inspector-media">${inspectorMedia(asset)}</div><div class="inspector-head"><div><h2>${escapeHtml(asset.name)}</h2><p>${asset.type === "video" ? "视频" : asset.type === "image" ? "图片" : asset.documentType ? `${asset.documentType} 文档` : "文字"} · ${formatBytes(asset.size)}</p></div><div class="inspector-head-actions">${expandButton}<button class="icon-button" data-action="download" aria-label="下载原文件"><svg><use href="#i-download"/></svg></button><button class="icon-button" data-action="close" aria-label="关闭详情"><svg><use href="#i-close"/></svg></button></div></div><div class="inspector-section"><h3>素材信息</h3><div class="meta-grid"><div><span>规格</span><strong>${sizeInfo}</strong></div><div><span>使用次数</span><strong>${asset.uses} 次</strong></div><div><span>索引方式</span><strong>${asset.indexMode || "本地"}</strong></div><div><span>检索单元</span><strong>${asset.segments?.length || 1} 个</strong></div>${documentMeta}${sourceMeta}</div>${parseWarning}${recovery}</div>${segments}${mediaInsights}<div class="inspector-section"><h3>检索标签</h3><div class="tag-list">${(asset.tags || []).map((tag) => `<button data-remove-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}</div><div class="tag-editor"><input id="tagInput" placeholder="添加检索标签" aria-label="新标签"/><button class="secondary-button" data-action="add-tag">添加</button></div></div><div class="inspector-actions">${reindexButton}<button class="primary-button" data-action="use"><svg><use href="#i-check"/></svg>标记已使用</button><button class="danger-button" data-action="delete" aria-label="删除素材"><svg><use href="#i-trash"/></svg></button></div></div>`;
  if (asset.type === "video" && Number.isFinite(state.selectedTime)) {
    const video = $("#inspectorVideo"); const seek = () => { video.currentTime = Math.min(state.selectedTime, Math.max(0, asset.duration - .05)); video.play().catch(() => {}); };
    video.readyState >= 1 ? seek() : video.addEventListener("loadedmetadata", seek, { once: true });
  }
}
function renderModelStatus() {
  const bothOnline = state.modelHealth === "online" && state.mediaHealth === "online";
  const anyOffline = state.modelHealth === "offline" || (state.config.mediaEndpoint && state.mediaHealth === "offline");
  const checking = state.modelHealth === "checking" || state.mediaHealth === "checking";
  elements.modelStatus.classList.toggle("is-online", bothOnline || (state.modelHealth === "online" && !state.config.mediaEndpoint));
  elements.modelStatus.classList.toggle("is-offline", Boolean(anyOffline));
  const label = checking ? "正在连接" : bothOnline ? "双服务在线" : state.modelHealth === "online" ? "WeMM 在线" : anyOffline ? "服务离线" : "本地检索";
  elements.modelStatus.querySelector("span").textContent = label;
}
function renderAll() { renderCounts(); renderReference(); renderView(); renderInspector(); renderModelStatus(); renderTaskCenter(); }

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer(); let binary = ""; const bytes = new Uint8Array(buffer); const chunk = 32768;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}
async function requestEmbedding(inputs, config = state.config, signal) {
  const response = await fetch("/api/wemm/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey, dimension: Number(config.dimension), inputs }), signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "WeMM 请求失败");
  return payload.embeddings;
}
async function probeModelHealth(config) {
  const response = await fetch("/api/wemm/health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || payload.detail || "模型尚未就绪");
  return payload;
}
async function probeMediaHealth(config) {
  const response = await fetch("/api/media/health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: config.mediaEndpoint, apiKey: config.apiKey }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error || payload.detail || "媒体分析服务尚未就绪");
  return payload;
}
async function checkModelHealth(config = state.config) {
  if (!config.endpoint) { state.modelHealth = "local"; renderModelStatus(); return null; }
  state.modelHealth = "checking"; renderModelStatus();
  try {
    const payload = await probeModelHealth(config);
    state.modelHealth = "online"; renderModelStatus(); return payload;
  } catch (error) {
    state.modelHealth = "offline"; renderModelStatus(); throw error;
  }
}
async function checkMediaHealth(config = state.config) {
  if (!config.mediaEndpoint) { state.mediaHealth = "local"; renderModelStatus(); return null; }
  state.mediaHealth = "checking"; renderModelStatus();
  try {
    const payload = await probeMediaHealth(config);
    state.mediaHealth = "online"; renderModelStatus(); return payload;
  } catch (error) {
    state.mediaHealth = "offline"; renderModelStatus(); throw error;
  }
}
function deriveMediaEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!/^https?:\/\//i.test(value)) return "";
  return value.replace(/:8000(?=\/|$)/, ":8001").replace(/\/$/, "");
}
function segmentSignature() { return `${Number(state.config.segmentSeconds)}:${Number(state.config.overlapSeconds)}:${state.config.mediaEndpoint ? "media-v2" : "fixed-v2"}`; }
function planLocalSegments(duration) {
  const length = Number(state.config.segmentSeconds) || 6; const overlap = Math.min(Number(state.config.overlapSeconds) || 0, length - 1);
  if (!duration || duration <= length) return [{ start: 0, end: duration, time: duration / 2 }];
  const segments = []; const step = Math.max(1, length - overlap); let start = 0;
  while (start < duration) { const safeStart = Math.min(start, Math.max(0, duration - length)); const end = Math.min(duration, safeStart + length); segments.push({ start: safeStart, end, time: (safeStart + end) / 2 }); if (end >= duration) break; start += step; }
  return segments.filter((segment, index, list) => index === 0 || segment.start !== list[index - 1].start);
}
async function requestVideoSegments(asset, signal) {
  const params = new URLSearchParams({ dimension: state.config.dimension, segment_seconds: state.config.segmentSeconds, overlap_seconds: state.config.overlapSeconds, max_segments: "0" });
  const form = new FormData();
  form.append("file", asset.blob, asset.name);
  const response = await fetch(`/api/wemm/index-video?${params}`, { method: "POST", headers: { "x-radar-endpoint": state.config.endpoint, "x-radar-api-key": state.config.apiKey }, body: form, signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "视频切片索引失败");
  const expected = planLocalSegments(asset.duration).length;
  if (expected > 1 && (payload.segments?.length || 0) < expected) {
    throw new Error(`模型服务只返回 ${payload.segments?.length || 0}/${expected} 段，请更新拯救者上的 cloud/wemm_api.py 后重启服务`);
  }
  return payload.segments.map((segment) => ({ start: segment.start, end: segment.end, time: segment.time, wemmVector: normalizeVector(segment.embedding) }));
}
function numberFrom(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function normalizeTranscript(payload, duration) {
  const items = payload.transcript || payload.asr || payload.speech || [];
  return items.map((item) => {
    const start = Math.max(0, numberFrom(item.start ?? item.start_time, 0));
    const end = Math.min(duration, Math.max(start, numberFrom(item.end ?? item.end_time, start)));
    return { start, end, text: String(item.text || item.content || "").trim(), language: item.language || item.lang || null, emotion: item.emotion || null, event: item.event || null };
  }).filter((item) => item.text);
}
function normalizeOcr(payload, duration) {
  const items = payload.ocr || payload.texts || [];
  return items.map((item) => ({
    time: Math.min(duration, Math.max(0, numberFrom(item.time ?? item.timestamp ?? item.start, 0))),
    text: String(item.text || item.content || "").trim(),
    confidence: Number.isFinite(Number(item.confidence ?? item.score)) ? Number(item.confidence ?? item.score) : null,
    box: item.box || item.bbox || null
  })).filter((item) => item.text);
}
function normalizeScenes(payload, duration, fallback) {
  const items = payload.scenes || payload.shots || [];
  const scenes = items.map((item) => {
    const start = Math.min(duration, Math.max(0, numberFrom(item.start ?? item.start_time, 0)));
    const end = Math.min(duration, Math.max(start, numberFrom(item.end ?? item.end_time, start)));
    const keyframe = Math.min(end, Math.max(start, numberFrom(item.keyframe ?? item.keyframe_time ?? item.time, (start + end) / 2)));
    return { start, end, time: keyframe };
  }).filter((item) => item.end - item.start > .05).sort((a, b) => a.start - b.start);
  return scenes.length ? scenes : fallback.map((item) => ({ start: item.start, end: item.end, time: item.time }));
}
function overlapsRange(item, start, end) { return numberFrom(item.end, item.start) >= start && numberFrom(item.start, item.time) <= end; }
async function requestMediaAnalysis(asset, signal) {
  const form = new FormData();
  form.append("file", asset.blob, asset.name);
  scheduleMediaTaskPoll(500);
  try {
    const response = await fetch("/api/media/analyze-video", {
      method: "POST",
      headers: { "x-radar-media-endpoint": state.config.mediaEndpoint, "x-radar-api-key": state.config.apiKey },
      body: form,
      signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.detail || "媒体分析失败");
    return payload;
  } finally { refreshMediaTaskStatus(true); }
}
async function analyzeVideoMedia(asset, signal) {
  const payload = await requestMediaAnalysis(asset, signal);
  const duration = numberFrom(payload.duration, asset.duration) || asset.duration;
  const transcript = normalizeTranscript(payload, duration);
  const ocr = normalizeOcr(payload, duration);
  const scenes = normalizeScenes(payload, duration, planLocalSegments(duration));
  return { duration, scenes, transcript, ocr, warnings: (payload.warnings || []).map(String).filter(Boolean) };
}
function textForScene(scene, analysis) {
  if (!analysis) return "";
  const speech = analysis.transcript.filter((item) => overlapsRange(item, scene.start, scene.end)).map((item) => item.text);
  const frameText = analysis.ocr.filter((item) => item.time >= scene.start && item.time <= scene.end).map((item) => item.text);
  return [...new Set([...speech, ...frameText])].join(" ");
}
async function embedSceneTexts(scenes, analysis, signal) {
  const sceneText = scenes.map((scene) => textForScene(scene, analysis));
  const textInputs = sceneText.map((text, index) => ({ text, index })).filter((item) => item.text);
  const textVectors = textInputs.length ? await embedInBatches(textInputs.map((item) => ({ kind: "text", text: item.text })), signal) : [];
  return { sceneText, textVectorByScene: new Map(textInputs.map((item, index) => [item.index, textVectors[index]])) };
}
async function enrichVideoSegments(videoSegments, analysis, signal) {
  if (!analysis) return videoSegments;
  const scenes = analysis.scenes;
  const { sceneText, textVectorByScene } = await embedSceneTexts(scenes, analysis, signal);
  return scenes.map((scene, index) => {
    let visualMatches = videoSegments.filter((segment) => overlapsRange(segment, scene.start, scene.end));
    if (!visualMatches.length && videoSegments.length) visualMatches = [videoSegments.reduce((best, item) => Math.abs(item.time - scene.time) < Math.abs(best.time - scene.time) ? item : best)];
    const vectors = [...visualMatches.map((item) => item.wemmVector), textVectorByScene.get(index)].filter(Boolean);
    return { ...scene, content: sceneText[index], wemmVector: averageVectors(vectors) };
  });
}
async function buildKeyframeSegments(asset, analysis, signal) {
  const scenes = analysis?.scenes?.length ? analysis.scenes : planLocalSegments(asset.duration);
  const segments = await addSegmentThumbnails(asset, scenes.map((scene) => ({ ...scene })), signal);
  const imageInputs = [];
  for (const segment of segments) {
    if (signal?.aborted) throw new DOMException("任务已停止", "AbortError");
    imageInputs.push({ kind: "image", mime: "image/webp", data: await blobToBase64(segment.thumbnail) });
  }
  const imageVectors = await embedInBatches(imageInputs, signal);
  const { sceneText, textVectorByScene } = await embedSceneTexts(segments, analysis, signal);
  return segments.map((segment, index) => ({
    ...segment,
    content: sceneText[index],
    wemmVector: averageVectors([imageVectors[index], textVectorByScene.get(index)])
  }));
}
async function addSegmentThumbnails(asset, segments, signal) {
  const video = document.createElement("video"); video.preload = "metadata"; video.muted = true; video.src = getBlobUrl(asset.blob); await once(video, "loadedmetadata");
  for (const segment of segments) { if (signal?.aborted) throw new DOMException("任务已停止", "AbortError"); const frame = await captureVideoFrame(video, segment.time); segment.thumbnail = frame.thumbnail; segment.visualVector = frame.visualVector; }
  return segments;
}
function chunkText(content, size = 800) {
  const paragraphs = content.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean); const chunks = []; let current = "";
  for (const paragraph of paragraphs.length ? paragraphs : [content]) {
    if (current && current.length + paragraph.length > size) { chunks.push(current); current = ""; }
    if (paragraph.length > size) { for (let i = 0; i < paragraph.length; i += size) chunks.push(paragraph.slice(i, i + size)); }
    else current += `${current ? "\n\n" : ""}${paragraph}`;
  }
  if (current) chunks.push(current); return chunks;
}
async function embedInBatches(inputs, signal) {
  const vectors = [];
  for (let index = 0; index < inputs.length; index += 16) { if (signal?.aborted) throw new DOMException("任务已停止", "AbortError"); vectors.push(...await requestEmbedding(inputs.slice(index, index + 16), state.config, signal)); }
  return vectors.map(normalizeVector);
}
async function indexOneAsset(asset, signal) {
  if (asset.type === "video") {
    asset.indexStatus = "indexing"; asset.analysisStage = state.config.mediaEndpoint ? "scene" : "embedding"; asset.analysisProgress = 5; asset.indexError = null; await putAsset(asset); renderTaskCenter();
    let analysis = null; let mediaError = null; let visualSegments = null; let videoEndpointError = null;
    if (state.config.mediaEndpoint) {
      try { analysis = await analyzeVideoMedia(asset, signal); asset.mediaAnalysisStatus = "ready"; }
      catch (error) {
        if (error.name === "AbortError") throw error;
        mediaError = error; asset.mediaAnalysisStatus = "error";
      }
    } else asset.mediaAnalysisStatus = "disabled";
    asset.analysisStage = "embedding"; asset.analysisProgress = 58; await putAsset(asset); renderTaskCenter();
    try { visualSegments = await requestVideoSegments(asset, signal); }
    catch (error) { if (error.name === "AbortError") throw error; videoEndpointError = error; }

    let segments;
    if (visualSegments?.length) {
      const semanticSegments = analysis ? await enrichVideoSegments(visualSegments, analysis, signal) : visualSegments;
      segments = await addSegmentThumbnails(asset, semanticSegments, signal);
      asset.indexMode = analysis ? "WeMM 视频 + 镜头/语音/OCR" : "WeMM 视频";
    } else {
      segments = await buildKeyframeSegments(asset, analysis, signal);
      asset.indexMode = analysis ? "镜头关键帧 + 语音/OCR" : "关键帧兼容";
    }
    const warnings = [...(analysis?.warnings || [])];
    if (mediaError) warnings.push(`媒体分析暂不可用：${mediaError.message}`);
    if (videoEndpointError) warnings.push("拯救者 WeMM 暂无完整视频接口，已自动使用镜头关键帧融合索引");
    asset.transcript = analysis?.transcript || [];
    asset.ocr = analysis?.ocr || [];
    asset.analysisWarnings = [...new Set(warnings)];
    asset.segments = segments; asset.wemmVector = averageVectors(segments.map((item) => item.wemmVector)); asset.indexedSignature = segmentSignature(); asset.analysisStage = "done"; asset.analysisProgress = 100;
  } else if (asset.type === "image") {
    const [vector] = await requestEmbedding([{ kind: "image", mime: "image/webp", data: await blobToBase64(asset.thumbnail) }], state.config, signal);
    asset.wemmVector = normalizeVector(vector); asset.segments = []; asset.indexMode = "WeMM 图片";
  } else {
    const chunks = chunkText(asset.content); const vectors = await embedInBatches(chunks.map((text) => ({ kind: "text", text })), signal);
    asset.segments = chunks.map((content, order) => ({ order, content, wemmVector: vectors[order] })); asset.wemmVector = averageVectors(vectors); asset.indexMode = "WeMM 文字";
  }
  asset.indexStatus = "ready"; asset.indexError = null; asset.updatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
}
async function indexMissingWithWemm(force = false) {
  if (!state.config.endpoint || state.indexing) return;
  if (state.modelHealth !== "online") {
    try { await checkModelHealth(); }
    catch (error) { toast(`模型暂不可用：${error.message}`, "error"); return; }
  }
  if (state.config.mediaEndpoint) {
    const remoteTask = await refreshMediaTaskStatus(true);
    if (["running", "queued"].includes(remoteTask.status)) {
      toast(`拯救者正在${taskStageLabel(remoteTask.stage)}，请等待当前视频完成后再补齐索引`, "error");
      elements.taskDialog.showModal(); return;
    }
  }
  const pending = state.assets.filter((asset) => force || asset.indexStatus !== "ready" || (asset.type === "video" && asset.indexedSignature !== segmentSignature()));
  if (!pending.length) return toast("语义索引已经是最新状态");
  state.indexing = true; state.indexController = new AbortController(); elements.indexProgress.hidden = false; elements.cancelIndexButton.hidden = false; radarPulse(10000);
  try {
    for (let index = 0; index < pending.length; index += 1) {
      if (state.indexController.signal.aborted) throw new DOMException("任务已停止", "AbortError");
      const asset = pending[index]; const planned = asset.type === "video" ? planLocalSegments(asset.duration).length : null;
      elements.progressBar.style.width = `${Math.round(index / pending.length * 100)}%`;
      elements.progressText.textContent = asset.type === "video" ? `正在完整分析 ${asset.name}，预计 ${planned} 段` : `正在建立 ${asset.name} 的语义索引`;
      try { await indexOneAsset(asset, state.indexController.signal); }
      catch (error) {
        if (error.name === "AbortError") throw error;
        asset.indexStatus = "error"; asset.indexError = error.message; asset.analysisStage = "failed"; await putAsset(asset); toast(`${asset.name}：${error.message}`, "error");
      }
      renderAll();
    }
    elements.progressBar.style.width = "100%"; elements.progressText.textContent = "语义索引已完成";
  } catch (error) {
    if (error.name === "AbortError") {
      for (const asset of state.assets.filter((item) => item.indexStatus === "indexing")) { asset.indexStatus = "pending"; asset.analysisStage = "stopped"; await putAsset(asset); }
      elements.progressText.textContent = "任务已停止，未完成的素材仍保留在待处理列表"; toast("已停止语义索引");
    }
    else toast(error.message, "error");
  } finally {
    state.indexing = false; state.indexController = null; elements.cancelIndexButton.hidden = true; setTimeout(() => { elements.indexProgress.hidden = true; }, 1800); renderAll();
  }
}
async function retryAssetIndex(asset) {
  if (!state.config.endpoint) return toast("请先连接 WeMM 模型", "error");
  if (state.indexing) return toast("已有分析任务正在运行", "error");
  try {
    await checkModelHealth();
    if (state.config.mediaEndpoint) {
      const remoteTask = await refreshMediaTaskStatus(true);
      if (["running", "queued"].includes(remoteTask.status)) { elements.taskDialog.showModal(); return toast("拯救者仍有视频分析任务，请等待完成后再试", "error"); }
    }
    state.indexing = true; state.indexController = new AbortController(); elements.indexProgress.hidden = false; elements.cancelIndexButton.hidden = false;
    elements.progressBar.style.width = "18%"; elements.progressText.textContent = `正在重试 ${asset.name}`;
    await indexOneAsset(asset, state.indexController.signal);
    elements.progressBar.style.width = "100%"; elements.progressText.textContent = "素材索引已恢复"; toast("素材索引已恢复");
  } catch (error) {
    if (error.name === "AbortError") { asset.indexStatus = "pending"; asset.analysisStage = "stopped"; await putAsset(asset); }
    else { asset.indexStatus = "error"; asset.indexError = error.message; asset.analysisStage = "failed"; await putAsset(asset); toast(error.message, "error"); }
  } finally {
    state.indexing = false; state.indexController = null; elements.cancelIndexButton.hidden = true; setTimeout(() => { elements.indexProgress.hidden = true; }, 1600); renderAll();
  }
}

async function updateSearchVector() {
  state.query = elements.searchInput.value.trim();
  if (!state.query || !state.config.endpoint) { state.queryVector = null; renderAssets(); return; }
  try { radarPulse(1700); const [vector] = await requestEmbedding([{ kind: "text", text: state.query }]); state.queryVector = normalizeVector(vector); renderAssets(); }
  catch (error) { state.queryVector = null; toast(`语义搜索暂不可用：${error.message}`, "error"); renderAssets(); }
}
async function setReference(file) {
  try {
    const inputType = fileKind(file); if (!inputType || inputType === "archive") throw new Error("压缩包不能直接作为搜索参考，请先导入后选择其中素材");
    const document = inputType === "document" ? (await requestImportExpansion(file)).document : null;
    const type = inputType === "document" ? "text" : inputType;
    const media = type === "image" ? await processImage(file) : type === "video" ? await processVideo(file) : document ? processDocument(file, document) : await processText(file);
    state.reference = { name: file.name, type, blob: file, ...media, wemmVector: null };
    renderAll(); radarPulse(1800);
    if (state.config.endpoint) {
      let input;
      if (type === "text") input = { kind: "text", text: media.content.slice(0, 8000) };
      else if (type === "video" && file.size <= 45 * 1024 * 1024) input = { kind: "video", mime: file.type, data: await blobToBase64(file) };
      else input = { kind: "image", mime: "image/webp", data: await blobToBase64(media.thumbnail) };
      const [vector] = await requestEmbedding([input]); state.reference.wemmVector = normalizeVector(vector); renderAssets();
    }
  } catch (error) { toast(`参考文件读取失败：${error.message}`, "error"); }
}

function searchableVideoClips() {
  return state.assets.filter((asset) => asset.type === "video").flatMap((asset) => (asset.segments || []).map((segment) => ({ asset, segment, vector: segment.wemmVector || asset.wemmVector })));
}
async function matchScript() {
  const lines = elements.scriptInput.value.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 10);
  if (!lines.length) return toast("请先输入脚本镜头", "error");
  if (!state.config.endpoint) return toast("脚本配镜需要先连接 WeMM", "error");
  const clips = searchableVideoClips().filter((clip) => clip.vector?.length);
  if (!clips.length) return toast("请先为视频补齐语义索引", "error");
  elements.matchScriptButton.disabled = true; elements.matchScriptButton.textContent = "正在匹配"; radarPulse(4000);
  try {
    const vectors = await embedInBatches(lines.map((text) => ({ kind: "text", text })));
    state.scriptResults = lines.map((line, lineIndex) => ({ line, candidates: clips.map((clip) => ({ ...clip, score: Math.max(0, cosine(vectors[lineIndex], clip.vector)) })).sort((a, b) => b.score - a.score).slice(0, 3) }));
    renderScriptResults();
  } catch (error) { toast(error.message, "error"); }
  finally { elements.matchScriptButton.disabled = false; elements.matchScriptButton.textContent = "匹配整段脚本"; }
}
function renderScriptResults() {
  elements.scriptResults.innerHTML = state.scriptResults.map((result) => `<div class="script-result"><strong>${escapeHtml(result.line)}</strong><div class="script-candidates">${result.candidates.map(({ asset, segment, score }) => `<button class="script-candidate" data-select="${asset.id}" data-time="${segment.time}" data-start="${segment.start}" data-end="${segment.end}"><img src="${getBlobUrl(segment.thumbnail || asset.thumbnail)}" alt="候选镜头"/><span><b>${escapeHtml(asset.name)}</b><small>${formatDuration(segment.start)}–${formatDuration(segment.end)} · ${Math.round(score * 100)}%</small></span></button>`).join("")}</div></div>`).join("");
}

async function updateSelectedAsset(mutator) { const asset = state.assets.find((item) => item.id === state.selectedId); if (!asset) return; mutator(asset); asset.updatedAt = Date.now(); await putAsset(asset); renderAll(); }
function downloadBlob(blob, name) { const link = document.createElement("a"); link.href = getBlobUrl(blob); link.download = name; link.click(); }
async function deleteAsset(asset) {
  if (!window.confirm(`确定从当前浏览器删除“${asset.name}”吗？`)) return;
  await removeAsset(asset.id); state.assets = state.assets.filter((item) => item.id !== asset.id); if (state.selectedId === asset.id) { state.selectedId = null; state.selectedResultKey = null; state.selectedTime = null; state.selectedRange = null; setInspectorExpanded(false); } renderAll(); updateStorageStatus(); toast("素材已删除");
}
function exportIndex() {
  const payload = state.assets.map(({ blob, thumbnail, moments, segments, visualVector, wemmVector, content, ...asset }) => ({ ...asset, textCharacters: content?.length || 0, wemmDimensions: wemmVector?.length || 0, segments: (segments || []).map(({ start, end, time, order, content: segmentText, wemmVector: vector }) => ({ start, end, time, order, excerpt: segmentText?.slice(0, 100), wemmDimensions: vector?.length || 0 })) }));
  downloadBlob(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), assets: payload }, null, 2)], { type: "application/json" }), `素材雷达索引-${new Date().toISOString().slice(0, 10)}.json`);
}

class RadarEngine {
  constructor(canvas) {
    this.canvas = canvas; this.context = canvas.getContext("2d"); this.angle = -Math.PI / 2; this.blips = []; this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resize = this.resize.bind(this); new ResizeObserver(this.resize).observe(canvas); this.resize(); requestAnimationFrame((time) => this.draw(time));
  }
  resize() { const rect = this.canvas.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio || 1, 2); this.canvas.width = Math.max(1, Math.round(rect.width * dpr)); this.canvas.height = Math.max(1, Math.round(rect.height * dpr)); this.context.setTransform(dpr, 0, 0, dpr, 0, 0); this.width = rect.width; this.height = rect.height; }
  setBlips(assets) { this.blips = assets.slice(0, 24).map((asset, index) => ({ angle: ((index * 137.5) % 360) * Math.PI / 180, radius: .19 + ((index * 29) % 66) / 100, strength: asset.searchScore || .18, type: asset.type })); }
  draw(time) {
    const ctx = this.context; const w = this.width || 1; const h = this.height || 1; const cx = w / 2; const cy = h / 2; const radius = Math.min(w, h) * .43;
    ctx.clearRect(0, 0, w, h); ctx.save();
    ctx.strokeStyle = "rgba(182,224,24,.18)"; ctx.lineWidth = 1;
    for (let ring = 1; ring <= 4; ring += 1) { ctx.beginPath(); ctx.arc(cx, cy, radius * ring / 4, 0, Math.PI * 2); ctx.stroke(); }
    const active = state.indexing || performance.now() < state.radarActiveUntil; const speed = active ? .00115 : .00022;
    if (!this.reduced) this.angle = time * speed - Math.PI / 2;
    const gradient = ctx.createConicGradient(this.angle - .65, cx, cy); gradient.addColorStop(0, "rgba(182,224,24,0)"); gradient.addColorStop(.1, "rgba(182,224,24,.18)"); gradient.addColorStop(.16, "rgba(182,224,24,0)"); gradient.addColorStop(1, "rgba(182,224,24,0)");
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(182,224,24,.78)"; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(this.angle) * radius, cy + Math.sin(this.angle) * radius); ctx.stroke();
    this.blips.forEach((blip, index) => { const x = cx + Math.cos(blip.angle) * radius * blip.radius; const y = cy + Math.sin(blip.angle) * radius * blip.radius; const delta = Math.abs(Math.atan2(Math.sin(this.angle - blip.angle), Math.cos(this.angle - blip.angle))); const pulse = active && delta < .18 ? 5 : 2.5; ctx.fillStyle = blip.type === "text" ? "rgba(238,241,233,.82)" : "rgba(182,224,24,.9)"; ctx.beginPath(); ctx.arc(x, y, pulse + Math.min(.9, blip.strength) * 2, 0, Math.PI * 2); ctx.fill(); if (delta < .18) { ctx.strokeStyle = "rgba(182,224,24,.25)"; ctx.beginPath(); ctx.arc(x, y, 10 + index % 3, 0, Math.PI * 2); ctx.stroke(); } });
    ctx.restore(); requestAnimationFrame((next) => this.draw(next));
  }
}
const radar = new RadarEngine(elements.radarCanvas);
function radarPulse(duration = 1600) { state.radarActiveUntil = performance.now() + duration; }

function viewFromLocation() { const view = location.hash.replace("#", ""); return VIEW_COPY[view] ? view : "radar"; }
function navigateToView(view) { state.view = VIEW_COPY[view] ? view : "radar"; history.pushState(null, "", `#${state.view}`); elements.modeRail.classList.remove("is-open"); renderView(); radarPulse(900); }

elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
elements.emptyUploadButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", async () => { await importFiles(elements.fileInput.files); elements.fileInput.value = ""; });
elements.referenceButton.addEventListener("click", () => elements.referenceInput.click());
elements.referenceInput.addEventListener("change", async () => { if (elements.referenceInput.files[0]) await setReference(elements.referenceInput.files[0]); elements.referenceInput.value = ""; });
elements.searchInput.addEventListener("input", () => { state.query = elements.searchInput.value.trim(); state.queryVector = null; clearTimeout(searchTimer); renderAssets(); searchTimer = setTimeout(updateSearchVector, 420); });
elements.searchButton.addEventListener("click", () => { clearTimeout(searchTimer); updateSearchVector(); radarPulse(1800); });
elements.sortSelect.addEventListener("change", () => { state.sort = elements.sortSelect.value; renderAssets(); });
elements.searchScopeSelect.addEventListener("change", () => { state.searchScope = elements.searchScopeSelect.value; renderAssets(); });
elements.retryIndexButton.addEventListener("click", () => indexMissingWithWemm(true));
elements.cancelIndexButton.addEventListener("click", () => state.indexController?.abort());
elements.persistStorageButton.addEventListener("click", requestPersistentStorage);
document.querySelectorAll('input[name="type"]').forEach((input) => input.addEventListener("change", () => { state.type = document.querySelector('input[name="type"]:checked').value; renderAssets(); }));
document.querySelectorAll('input[name="ratio"]').forEach((input) => input.addEventListener("change", () => { input.checked ? state.ratios.add(input.value) : state.ratios.delete(input.value); renderAssets(); }));
document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => navigateToView(button.dataset.view)));
elements.filterButton.addEventListener("click", () => elements.modeRail.classList.add("is-open")); elements.railClose.addEventListener("click", () => elements.modeRail.classList.remove("is-open"));
elements.exportButton.addEventListener("click", exportIndex);
elements.assetGrid.addEventListener("click", async (event) => {
  const card = event.target.closest(".asset-card"); if (!card) return; const asset = state.assets.find((item) => item.id === card.dataset.id); if (!asset) return;
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "download") return downloadBlob(asset.blob, asset.name); if (action === "delete") return deleteAsset(asset);
  const scored = filteredAssets().find((item) => item.resultKey === card.dataset.resultKey); state.selectedId = asset.id; state.selectedResultKey = scored?.resultKey || `asset:${asset.id}`; state.selectedTime = scored?.bestSegment?.start ?? scored?.bestSegment?.time ?? null; state.selectedRange = scored?.bestSegment || null; renderAll();
});
elements.inspector.addEventListener("click", async (event) => {
  const asset = state.assets.find((item) => item.id === state.selectedId); if (!asset) return; const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close") { state.selectedId = null; state.selectedResultKey = null; state.selectedTime = null; state.selectedRange = null; setInspectorExpanded(false); return renderAll(); }
  if (action === "expand") { setInspectorExpanded(!state.inspectorExpanded); const button = event.target.closest("[data-action]"); button?.setAttribute("aria-label", state.inspectorExpanded ? "退出大窗口审片" : "打开大窗口审片"); return; }
  if (action === "download") downloadBlob(asset.blob, asset.name);
  if (action === "delete") return deleteAsset(asset);
  if (action === "retry-index") return retryAssetIndex(asset);
  if (action === "reindex-one") return retryAssetIndex(asset);
  if (action === "use") { await updateSelectedAsset((item) => { item.uses += 1; item.lastUsedAt = Date.now(); }); toast("已记录一次素材使用"); }
  if (action === "add-tag") { const input = $("#tagInput"); const tag = input.value.trim(); if (tag && !asset.tags.includes(tag)) await updateSelectedAsset((item) => item.tags.push(tag)); }
  const tagButton = event.target.closest("[data-remove-tag]"); if (tagButton) await updateSelectedAsset((item) => { item.tags = item.tags.filter((tag) => tag !== tagButton.dataset.removeTag); });
  const moment = event.target.closest("[data-time]"); if (moment) { const video = $("#inspectorVideo"); if (video) { state.selectedTime = Number(moment.dataset.start || moment.dataset.time); state.selectedRange = { start: Number(moment.dataset.start), end: Number(moment.dataset.end) }; video.currentTime = state.selectedTime; video.play().catch(() => {}); } }
});
elements.inspectorBackdrop.addEventListener("click", () => setInspectorExpanded(false));
elements.scriptInput.addEventListener("input", () => { const count = elements.scriptInput.value.split(/\n+/).map((line) => line.trim()).filter(Boolean).length; elements.scriptHint.textContent = `${Math.min(count, 10)} / 10 个镜头意图`; });
elements.matchScriptButton.addEventListener("click", matchScript);
elements.scriptResults.addEventListener("click", (event) => { const candidate = event.target.closest("[data-select]"); if (!candidate) return; const asset = state.assets.find((item) => item.id === candidate.dataset.select); const start = Number(candidate.dataset.start || candidate.dataset.time); const end = Number(candidate.dataset.end); const segment = asset?.segments?.find((item) => Math.abs(Number(item.start) - start) < .01 && Math.abs(Number(item.end) - end) < .01); state.selectedId = candidate.dataset.select; state.selectedResultKey = segment && asset ? resultKeyForSegment(asset, segment, asset.segments.indexOf(segment)) : null; state.selectedTime = start; state.selectedRange = { start, end }; renderAll(); });
function settingsDraft() {
  return {
    endpoint: elements.endpointInput.value.trim(), mediaEndpoint: elements.mediaEndpointInput.value.trim(), apiKey: elements.apiKeyInput.value.trim(),
    dimension: Number(elements.dimensionInput.value), segmentSeconds: Number(elements.segmentSecondsInput.value), overlapSeconds: Number(elements.overlapSecondsInput.value)
  };
}
function setServiceFeedback(kind, status, message) {
  const isMedia = kind === "media";
  const result = isMedia ? elements.mediaConnectionResult : elements.connectionResult;
  const badge = isMedia ? elements.mediaServiceState : elements.wemmServiceState;
  const input = isMedia ? elements.mediaEndpointInput : elements.endpointInput;
  result.className = `connection-result${status ? ` is-${status}` : ""}`; result.textContent = message;
  badge.className = `service-state${status ? ` is-${status}` : ""}`;
  badge.textContent = status === "success" ? "在线" : status === "error" ? "不可用" : status === "loading" ? "连接中" : "待测试";
  input.classList.toggle("is-success", status === "success"); input.classList.toggle("is-error", status === "error");
}
function setTesting(button, loading, idleLabel) {
  button.disabled = loading; button.classList.toggle("is-loading", loading); button.textContent = loading ? "正在测试" : idleLabel;
}
async function testWemmConnection(config = settingsDraft()) {
  setTesting(elements.testConnectionButton, true, "测试 WeMM"); setServiceFeedback("wemm", "loading", "正在检查 WeMM 服务");
  try {
    const health = await probeModelHealth(config); setServiceFeedback("wemm", "success", `连接成功 · ${health.model || "WeMM"}${health.gpu ? ` · ${health.gpu}` : ""}`); return health;
  } catch (error) { setServiceFeedback("wemm", "error", error.message); throw error; }
  finally { setTesting(elements.testConnectionButton, false, "测试 WeMM"); }
}
async function testMediaConnection(config = settingsDraft()) {
  setTesting(elements.testMediaConnectionButton, true, "测试媒体服务"); setServiceFeedback("media", "loading", "正在检查切镜、语音与 OCR");
  try {
    const health = await probeMediaHealth(config);
    const capabilities = [health.scene && "切镜", health.asr && "语音", health.ocr && "OCR"].filter(Boolean).join(" · ");
    setServiceFeedback("media", "success", `连接成功${capabilities ? ` · ${capabilities}` : ""}`); return health;
  } catch (error) { setServiceFeedback("media", "error", error.message); throw error; }
  finally { setTesting(elements.testMediaConnectionButton, false, "测试媒体服务"); }
}
function openSettingsDialog() {
  elements.endpointInput.value = state.config.endpoint; elements.mediaEndpointInput.value = state.config.mediaEndpoint || deriveMediaEndpoint(state.config.endpoint); elements.apiKeyInput.value = state.config.apiKey;
  elements.dimensionInput.value = state.config.dimension; elements.segmentSecondsInput.value = state.config.segmentSeconds; elements.segmentSecondsValue.textContent = `${state.config.segmentSeconds} 秒`; elements.overlapSecondsInput.value = state.config.overlapSeconds;
  setServiceFeedback("wemm", state.modelHealth === "online" ? "success" : "", state.modelHealth === "online" ? "当前 WeMM 连接正常" : "尚未确认 WeMM 连接");
  setServiceFeedback("media", state.mediaHealth === "online" ? "success" : "", state.mediaHealth === "online" ? "当前媒体分析连接正常" : "尚未确认媒体服务连接");
  elements.settingsDialog.showModal();
}
elements.settingsButton.addEventListener("click", openSettingsDialog);
elements.modelStatus.addEventListener("click", openSettingsDialog);
elements.taskCenterButton.addEventListener("click", () => { renderTaskCenter(); elements.taskDialog.showModal(); refreshMediaTaskStatus(true); });
elements.closeTaskDialogButton.addEventListener("click", () => elements.taskDialog.close());
elements.refreshTaskStatusButton.addEventListener("click", () => refreshMediaTaskStatus(false));
elements.segmentSecondsInput.addEventListener("input", () => { elements.segmentSecondsValue.textContent = `${elements.segmentSecondsInput.value} 秒`; });
elements.endpointInput.addEventListener("change", () => { if (!elements.mediaEndpointInput.value.trim()) elements.mediaEndpointInput.value = deriveMediaEndpoint(elements.endpointInput.value.trim()); });
elements.testConnectionButton.addEventListener("click", () => testWemmConnection().catch(() => {}));
elements.testMediaConnectionButton.addEventListener("click", () => testMediaConnection().catch(() => {}));
elements.testAllConnectionsButton.addEventListener("click", async () => {
  const draft = settingsDraft(); elements.testAllConnectionsButton.disabled = true; elements.testAllConnectionsButton.textContent = "正在测试全部";
  await Promise.allSettled([testWemmConnection(draft), testMediaConnection(draft)]);
  elements.testAllConnectionsButton.disabled = false; elements.testAllConnectionsButton.textContent = "测试全部服务";
});
elements.saveSettingsButton.addEventListener("click", async (event) => {
  event.preventDefault(); state.config = settingsDraft(); localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config)); elements.settingsDialog.close();
  if (!state.config.endpoint) { state.modelHealth = "local"; state.mediaHealth = "local"; renderModelStatus(); refreshMediaTaskStatus(true); return toast("已切换为本地检索"); }
  const checks = await Promise.allSettled([checkModelHealth(), state.config.mediaEndpoint ? checkMediaHealth() : Promise.resolve(null)]);
  if (checks[0].status === "fulfilled") { toast(state.config.mediaEndpoint && checks[1].status === "fulfilled" ? "两项服务已连接，视频将启用智能分析" : "WeMM 已连接，媒体分析暂未启用"); indexMissingWithWemm(); }
  else toast(`设置已保存，但 WeMM 当前不可用：${checks[0].reason.message}`, "error");
  if (state.config.mediaEndpoint && checks[1].status === "rejected") toast(`媒体分析暂不可用：${checks[1].reason.message}`, "error");
  refreshMediaTaskStatus(true);
});
window.addEventListener("dragenter", (event) => { event.preventDefault(); dragDepth += 1; elements.dropZone.hidden = false; }); window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; elements.dropZone.hidden = true; } });
window.addEventListener("drop", async (event) => { event.preventDefault(); dragDepth = 0; elements.dropZone.hidden = true; await importFiles(event.dataTransfer.files); });
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); elements.searchInput.focus(); }
  if (event.key === "Escape" && state.inspectorExpanded) setInspectorExpanded(false);
});
window.addEventListener("hashchange", () => { state.view = viewFromLocation(); renderView(); });

async function initialize() {
  state.view = viewFromLocation(); if (!location.hash) history.replaceState(null, "", "#radar");
  try { state.assets = (await getAllAssets()).map((asset) => ({ ...asset, segments: asset.segments || [], transcript: asset.transcript || [], ocr: asset.ocr || [], analysisWarnings: asset.analysisWarnings || [], tags: asset.tags || [], content: asset.content || "", indexStatus: asset.indexStatus || (asset.wemmVector ? "ready" : "pending") })).sort((a, b) => b.createdAt - a.createdAt); }
  catch (error) { toast(`本地素材库打开失败：${error.message}`, "error"); }
  renderAll(); radar.setBlips(filteredAssets()); updateStorageStatus();
  if (state.config.endpoint) {
    Promise.allSettled([checkModelHealth(), state.config.mediaEndpoint ? checkMediaHealth() : Promise.resolve(null)]).then(async (results) => { if (state.config.mediaEndpoint) await refreshMediaTaskStatus(true); if (results[0].status === "fulfilled") indexMissingWithWemm(); });
  } else renderTaskCenter();
}
initialize();
