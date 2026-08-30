import { calibrateAndDedupe, evaluateAsset, evaluateVideoSegment, matchLevel, rerankImageCandidates } from "./retrieval.js";
import { assetNeedsIndex, earliestRetryDelay, isRemoteTaskBusy, MEDIA_AUTO_RETRY_LIMIT, retryDelayForAttempt } from "./task-queue.js";
import { ANALYSIS_PROFILES, ANALYSIS_PROTOCOL, analysisRequestFields, normalizeAnalysisProfile, normalizeAnalysisReceipt, receiptStatusLabel } from "./media-analysis.js";
import { IMAGE_REGION_SPECS, imageIndexSignature, normalizeImageOcr } from "./image-indexing.js";
import { CHUNK_RESULT_PARSER_VERSION, DEFAULT_ANALYSIS_CHUNK_SECONDS, LONG_VIDEO_THRESHOLD_SECONDS, mergeChunkState, normalizeChunkResult, payloadItemsFor, planAnalysisChunks, recoverChunkResultParserFailure, subtitleTracksFromPayload, summarizeChunkProgress } from "./long-video.js";

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
  sort: "relevance", searchScope: "segments", view: "radar", indexing: false, indexStarting: false,
  scriptResults: [], config: loadConfig(), radarActiveUntil: 0,
  modelHealth: "local", mediaHealth: "local", mediaCapabilities: null, indexController: null, inspectorExpanded: false,
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
  analysisProfileInputs: [...document.querySelectorAll('input[name="analysisProfile"]')], analysisProfileHint: $("#analysisProfileHint"),
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
let indexResumeTimer;
const retryingChunkKeys = new Set();
const taskDetailOpenState = new Map();
const PLAYBACK_CHANNEL = "asset-radar-exclusive-playback";
const playbackSessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const playbackChannel = "BroadcastChannel" in window ? new BroadcastChannel(PLAYBACK_CHANNEL) : null;

function pauseOtherVideos(except = null) {
  document.querySelectorAll("video").forEach((video) => { if (video !== except && !video.paused) video.pause(); });
}
function announceVideoPlayback() {
  const message = { type: "video-play", sender: playbackSessionId, at: Date.now() };
  if (playbackChannel) playbackChannel.postMessage(message);
  else localStorage.setItem(PLAYBACK_CHANNEL, JSON.stringify(message));
}
document.addEventListener("play", (event) => {
  if (!(event.target instanceof HTMLVideoElement)) return;
  pauseOtherVideos(event.target); announceVideoPlayback();
}, true);
if (playbackChannel) playbackChannel.addEventListener("message", (event) => { if (event.data?.type === "video-play" && event.data.sender !== playbackSessionId) pauseOtherVideos(); });
window.addEventListener("storage", (event) => { if (event.key === PLAYBACK_CHANNEL && event.newValue) pauseOtherVideos(); });

function loadConfig() {
  const defaults = { endpoint: "", mediaEndpoint: "", apiKey: "", dimension: 256, segmentSeconds: 6, overlapSeconds: 1, analysisProfile: "smart_precision" };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
    if (saved.videoProfile && !saved.segmentSeconds) saved.segmentSeconds = saved.videoProfile === "quick" ? 6 : 8;
    return { ...defaults, ...saved, analysisProfile: normalizeAnalysisProfile(saved.analysisProfile) };
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
  const taskProfile = task.analysis_profile ?? payload.analysis_profile;
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
    subtitleCount: Number(task.subtitle_count ?? payload.subtitle_count ?? 0) || 0,
    sampledFrames: Number(task.sampled_frames ?? payload.sampled_frames ?? 0) || 0,
    analysisProfile: taskProfile ? normalizeAnalysisProfile(taskProfile) : null,
    queuePosition: Number(task.queue_position ?? payload.queue_position ?? 0) || 0,
    raw: payload
  };
}
function taskStageLabel(stage) {
  return ({ queued: "等待处理", upload: "接收视频", "chunk-uploaded": "视频已上传，等待分块", chunks: "分块分析中", "media-saved": "媒体结果已保存", scene: "检测镜头", scenes: "检测镜头", sampling: "动态抽帧", asr: "识别语音", speech: "识别语音", subtitles: "提取字幕轨", ocr: "识别画面文字", embedding: "写入语义向量", index: "写入语义向量", done: "处理完成", failed: "处理失败", partial: "部分完成", stopped: "已停止" })[stage] || (stage ? stage : "等待任务");
}
function taskStatusLabel(status) {
  return ({ unknown: "正在读取", unavailable: "服务不可达", idle: "当前空闲", queued: "等待处理", running: "正在分析", succeeded: "最近已完成", partial: "部分完成", failed: "分析失败" })[status] || status;
}
function localVideoState(asset) {
  if (asset.analysisChunks?.length) {
    const summary = summarizeChunkProgress(asset.analysisChunks);
    const detail = `${summary.ready}/${summary.total} 块媒体 · 镜头 ${summary.sceneCount} · 语音 ${summary.transcriptCount} · OCR ${summary.ocrCount} · 向量 ${summary.vectorsReady}/${summary.total} 块`;
    const hasFailures = asset.analysisChunks.some((chunk) => (!chunk.resultSaved && ["error", "failed"].includes(chunk.status)) || chunk.vectorStatus === "error" || chunkResultFetchExhausted(chunk));
    const isRunning = asset.indexStatus === "indexing" || asset.analysisChunks.some((chunk) => ["queued", "running", "processing", "analyzing"].includes(chunk.status) || chunk.vectorStatus === "running");
    if (summary.total && summary.ready === summary.total && summary.vectorsReady === summary.total && !hasFailures) return { key: "complete", label: "完整", detail };
    if (isRunning) return { key: "running", label: "分析中", detail };
    if (summary.ready || summary.vectorsReady) return { key: "partial", label: hasFailures ? "部分失败" : summary.vectorsReady || asset.segments?.length ? "部分可检索" : "媒体已保存", detail };
    if (hasFailures || asset.indexStatus === "error") return { key: "error", label: "失败", detail };
    return { key: "queued", label: "待处理", detail };
  }
  if (asset.indexStatus === "indexing") return { key: "running", label: "分析中", detail: taskStageLabel(asset.analysisStage) };
  if (asset.indexStatus === "error") return { key: "error", label: "失败", detail: asset.indexError || "需要重试" };
  if (asset.indexStatus === "partial") return { key: "partial", label: "部分", detail: `${asset.segments?.length || 0} 个画面片段，${asset.indexError || "语音/OCR 未完成"}` };
  if (asset.indexStatus !== "ready") return { key: "queued", label: "待处理", detail: "尚未建立语义索引" };
  if (asset.mediaAnalysisStatus === "ready") {
    const precision = asset.analysisReceipt?.precisionActive ? "近秒级" : "兼容模式";
    return { key: "complete", label: "完整", detail: `${precision} · ${asset.segments?.length || 0} 片段 · ${asset.transcript?.length || 0} 语音 · ${asset.ocr?.length || 0} OCR · ${asset.subtitles?.length || 0} 字幕` };
  }
  return { key: "partial", label: "部分", detail: `${asset.segments?.length || 0} 个画面片段，语音/OCR 未完成` };
}
function chunkComponentSnapshot(chunk, channel) {
  const countKey = { scene: "sceneCount", speech: "transcriptCount", ocr: "ocrCount", vector: "vectorCount" }[channel];
  const component = chunk.components?.[channel] || {};
  const status = channel === "vector"
    ? chunk.vectorStatus || component.status || "pending"
    : chunkResultFetchExhausted(chunk)
      ? "error"
    : chunk.resultSaved
      ? "ready"
      : component.status || "pending";
  const progress = ["ready", "complete"].includes(status)
    ? 100
    : Math.max(0, Math.min(100, Number(component.progress || 0)));
  return { status, progress, count: Number(component.count ?? chunk[countKey] ?? 0) || 0 };
}
function chunkStatusLabel(status) {
  return ({ pending: "等待", queued: "排队", running: "进行中", processing: "进行中", analyzing: "进行中", ready: "完成", complete: "完成", error: "失败", failed: "失败", unsupported: "不支持" })[status] || status;
}
function aggregateChunkChannel(chunks, channel) {
  if (!chunks.length) return 0;
  return Math.round(chunks.reduce((sum, chunk) => sum + chunkComponentSnapshot(chunk, channel).progress, 0) / chunks.length);
}
function renderChunkChannel(chunk, channel, label) {
  const snapshot = chunkComponentSnapshot(chunk, channel);
  const unit = ({ scene: "个", speech: "条", ocr: "条", vector: "段" })[channel];
  return `<div class="chunk-channel is-${escapeHtml(snapshot.status)}"><div><span>${escapeHtml(label)}</span><strong>${snapshot.count} ${unit}</strong></div><div class="chunk-mini-track" role="progressbar" aria-label="${escapeHtml(label)}进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${snapshot.progress}"><i style="width:${snapshot.progress}%"></i></div><small>${escapeHtml(chunkStatusLabel(snapshot.status))} · ${snapshot.progress}%</small></div>`;
}
function renderChunkRow(asset, chunk) {
  const mediaFailed = !chunk.resultSaved && ["error", "failed"].includes(chunk.status);
  const vectorFailed = chunk.vectorStatus === "error";
  const resultFetchFailed = chunkResultFetchExhausted(chunk);
  const failed = mediaFailed || vectorFailed || resultFetchFailed;
  const status = failed ? "error" : chunk.vectorStatus === "ready" && chunk.resultSaved ? "complete" : chunk.resultSaved ? "partial" : ["running", "processing", "analyzing"].includes(chunk.status) ? "running" : "queued";
  const retryKey = `${asset.id}:${chunk.index}`;
  const retryBusy = retryingChunkKeys.has(retryKey) || asset.indexStatus === "indexing";
  const retryLabel = resultFetchFailed ? "重新读取结果" : vectorFailed && chunk.resultSaved ? "只补向量" : "重试此块";
  const retry = failed ? `<button class="chunk-retry" type="button" data-retry-chunk-asset="${asset.id}" data-retry-chunk-index="${chunk.index}" ${retryBusy ? "disabled" : ""}>${retryBusy ? "处理中" : retryLabel}</button>` : "";
  const error = chunk.resultFetchError || chunk.vectorError || chunk.error;
  return `<article class="local-chunk-row is-${status}"><div class="local-chunk-head"><div><strong>第 ${String(chunk.index + 1).padStart(2, "0")} 块</strong><span>${formatDuration(chunk.start)}–${formatDuration(chunk.end)}</span></div><div><span class="local-task-state">${escapeHtml(status === "complete" ? "可检索" : status === "partial" ? "媒体已保存" : status === "running" ? taskStageLabel(chunk.stage) : status === "error" ? "需要处理" : "等待")}</span>${retry}</div></div><div class="chunk-channel-grid">${renderChunkChannel(chunk, "scene", "镜头")}${renderChunkChannel(chunk, "speech", "语音")}${renderChunkChannel(chunk, "ocr", "OCR")}${renderChunkChannel(chunk, "vector", "向量")}</div>${error ? `<p class="chunk-error">${escapeHtml(error)}</p>` : ""}</article>`;
}
function renderLocalVideoTask(asset) {
  const local = localVideoState(asset);
  const chunks = asset.analysisChunks || [];
  if (!chunks.length) {
    const retry = ["partial", "error", "queued"].includes(local.key) ? `<button class="local-task-retry" type="button" data-retry-asset="${asset.id}">${local.key === "queued" ? "立即处理" : "重新解析"}</button>` : "";
    return `<div class="local-task-row is-${local.key}"><i></i><div class="local-task-copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(local.detail)}</small></div><span class="local-task-state">${local.label}</span>${retry}</div>`;
  }
  const summary = summarizeChunkProgress(chunks);
  const needsAttention = chunks.some((chunk) => (!chunk.resultSaved && ["error", "failed"].includes(chunk.status)) || chunk.vectorStatus === "error" || chunkResultFetchExhausted(chunk));
  const resume = local.key !== "complete" && !state.indexing && !needsAttention ? `<button class="local-task-retry" type="button" data-resume-asset="${asset.id}">继续任务</button>` : "";
  const channelBars = [["scene", "镜头"], ["speech", "语音"], ["ocr", "OCR"], ["vector", "向量"]].map(([channel, label]) => {
    const progress = aggregateChunkChannel(chunks, channel);
    return `<div><span>${label}</span><i role="progressbar" aria-label="${label}总进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><b style="width:${progress}%"></b></i><strong>${progress}%</strong></div>`;
  }).join("");
  const detailsOpen = taskDetailOpenState.has(asset.id) ? taskDetailOpenState.get(asset.id) : local.key !== "complete" || needsAttention;
  return `<section class="local-task-card is-${local.key}"><div class="local-task-row is-${local.key}"><i></i><div class="local-task-copy"><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(local.detail)}</small></div><span class="local-task-state">${local.label}</span>${resume}</div><div class="local-channel-summary">${channelBars}</div><details class="local-chunk-details" data-chunk-details-asset="${asset.id}" ${detailsOpen ? "open" : ""}><summary><span>分块明细</span><strong>${summary.ready}/${summary.total} 块媒体 · ${summary.vectorsReady}/${summary.total} 块向量</strong></summary><div class="local-chunk-list">${chunks.map((chunk) => renderChunkRow(asset, chunk)).join("")}</div></details></section>`;
}
function renderTaskCenter() {
  const task = state.mediaTask;
  const videos = state.assets.filter((asset) => asset.type === "video").sort((a, b) => b.updatedAt - a.updatedAt);
  const localRunning = videos.filter((asset) => localVideoState(asset).key === "running");
  const topStatus = localRunning.length && !["running", "queued"].includes(task.status) ? "running" : task.status;
  const topStatusClass = topStatus === "succeeded" ? "success" : topStatus === "failed" || topStatus === "unavailable" ? "error" : topStatus;
  const remoteStatusClass = task.status === "succeeded" ? "success" : task.status === "failed" || task.status === "unavailable" ? "error" : task.status;
  elements.taskCenterButton.className = `task-status-button is-${topStatusClass}`;
  elements.taskStatusTitle.textContent = localRunning.length && !["running", "queued"].includes(task.status) ? `本地处理中 ${localRunning.length}` : task.status === "running" ? `分析中 ${Math.round(task.progress)}%` : taskStatusLabel(task.status);
  elements.taskStatusSummary.textContent = localRunning.length && !["running", "queued"].includes(task.status) ? `${taskStageLabel(localRunning[0].analysisStage)} · ${localRunning[0].name}` : task.status === "running" ? `${taskStageLabel(task.stage)}${task.filename ? ` · ${task.filename}` : ""}` : task.message || (task.status === "idle" ? "可以开始新视频" : "点击查看详情");

  const inactive = task.status === "idle" || task.status === "unknown" || task.status === "unavailable";
  const title = task.filename || (task.status === "idle" ? "拯救者当前没有分析任务" : taskStatusLabel(task.status));
  const description = task.status === "idle" ? "现在可以安全地开始下一个视频，刷新网页也不会再误触发并发任务。" : task.status === "unavailable" ? "网页暂时无法读取 8001 的任务状态，请检查拯救者网络和服务。" : `${taskStageLabel(task.stage)} · ${ANALYSIS_PROFILES[task.analysisProfile]?.label || "媒体分析"}${task.startedAt ? ` · 开始于 ${formatTaskTime(task.startedAt)}` : ""}`;
  elements.remoteTaskPanel.className = `remote-task-card is-${remoteStatusClass}`;
  elements.remoteTaskPanel.innerHTML = `<div class="remote-task-head"><div><p class="remote-task-kicker">LEGION · MEDIA TOOLS</p><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><span class="task-state-badge">${escapeHtml(taskStatusLabel(task.status))}</span></div>
    <div class="task-progress-track" aria-label="任务进度"><span style="width:${inactive ? 0 : Math.round(task.progress)}%"></span></div>
    <div class="task-progress-meta"><strong>${escapeHtml(taskStageLabel(task.stage))}</strong><span>${inactive ? "—" : `${Math.round(task.progress)}%`}</span></div>
    <div class="task-metrics"><div><span>检索片段</span><strong>${task.sceneCount || "—"}</strong></div><div><span>采样帧</span><strong>${task.sampledFrames || "—"}</strong></div><div><span>语音</span><strong>${task.transcriptCount || "—"}</strong></div><div><span>OCR</span><strong>${task.ocrCount || "—"}</strong></div><div><span>字幕轨</span><strong>${task.subtitleCount || "—"}</strong></div><div><span>任务 ID</span><strong>${escapeHtml(String(task.taskId || "—"))}</strong></div></div>
    ${task.message ? `<p class="task-message">${escapeHtml(task.message)}</p>` : ""}`;

  const complete = videos.filter((asset) => localVideoState(asset).key === "complete").length;
  const partial = videos.filter((asset) => localVideoState(asset).key === "partial").length;
  const waiting = videos.filter((asset) => ["queued", "running", "error"].includes(localVideoState(asset).key)).length;
  elements.localTaskSummary.textContent = `${complete} 完整 · ${partial} 部分 · ${waiting} 待处理 · ${videos.length} 总计`;
  elements.localTaskList.innerHTML = videos.length ? videos.map(renderLocalVideoTask).join("") : `<div class="local-task-empty">还没有导入视频素材</div>`;
  elements.taskLastUpdated.textContent = state.mediaTaskUpdatedAt ? `最后更新 ${formatTaskTime(state.mediaTaskUpdatedAt)}` : "尚未读取任务状态";
}
function scheduleMediaTaskPoll(delay) {
  clearTimeout(mediaTaskPollTimer);
  if (!state.config.mediaEndpoint) return;
  mediaTaskPollTimer = setTimeout(() => refreshMediaTaskStatus(true), delay);
}
function queueCandidates({ force = false, includeFailed = false } = {}) {
  const signature = segmentSignature();
  const imageSignature = currentImageIndexSignature();
  return state.assets.filter((asset) => assetNeedsIndex(asset, {
    force, includeFailed, signature, imageSignature, mediaEnabled: Boolean(state.config.mediaEndpoint)
  }));
}
function assetNeedsChunkMedia(asset) {
  if (asset.type !== "video" || asset.duration < LONG_VIDEO_THRESHOLD_SECONDS || !state.config.mediaEndpoint || !chunkedAnalysisAvailable()) return false;
  if (!asset.mediaTaskId || !asset.analysisChunks?.length) return true;
  return asset.analysisChunks.some((chunk) => !chunkProcessingTerminal(chunk));
}
function scheduleIndexResume(delay = 250) {
  clearTimeout(indexResumeTimer);
  if (!state.config.endpoint) return;
  indexResumeTimer = setTimeout(() => indexMissingWithWemm(false, { automatic: true }), Math.max(0, delay));
}
function scheduleDeferredMediaRetry() {
  const delay = earliestRetryDelay(state.assets, { mediaEnabled: Boolean(state.config.mediaEndpoint) });
  if (delay !== null) scheduleIndexResume(Math.max(500, delay));
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
      const trackedAsset = state.assets.find((asset) => asset.type === "video" && asset.mediaTaskId && assetNeedsChunkMedia(asset));
      const response = await fetch("/api/media/task-status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: state.config.mediaEndpoint, apiKey: state.config.apiKey, taskId: trackedAsset?.mediaTaskId || undefined }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || payload.detail || "无法读取媒体任务状态");
      state.mediaTask = normalizeMediaTaskPayload(payload); state.mediaTaskUpdatedAt = Date.now(); renderTaskCenter();
      scheduleMediaTaskPoll(["running", "queued"].includes(state.mediaTask.status) ? 2500 : 10000);
      if (!isRemoteTaskBusy(state.mediaTask) && queueCandidates().length) scheduleIndexResume(300);
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
function createImageRegionCanvas(source, region, maxWidth = 640) {
  const sourceWidth = source.naturalWidth || source.width;
  const sourceHeight = source.naturalHeight || source.height;
  const sx = Math.round(sourceWidth * region.x); const sy = Math.round(sourceHeight * region.y);
  const sw = Math.max(1, Math.round(sourceWidth * region.width)); const sh = Math.max(1, Math.round(sourceHeight * region.height));
  const scale = Math.min(1, maxWidth / sw);
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(sw * scale)); canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
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
  const imageRegions = [];
  for (const spec of IMAGE_REGION_SPECS) {
    const regionCanvas = createImageRegionCanvas(image, spec);
    imageRegions.push({ ...spec, thumbnail: await canvasBlob(regionCanvas), visualVector: visualVectorFromCanvas(regionCanvas), wemmVector: null });
  }
  return { width: image.naturalWidth, height: image.naturalHeight, duration: null, thumbnail: await canvasBlob(canvas), visualVector, imageRegions, ocr: [], ocrText: "", ocrVector: null, moments: [], content: "", ratio: classifyRatio(image.naturalWidth, image.naturalHeight), tags: [...new Set([...tagsFromFilename(file.name), ...colorTags(visualVector), "图片"])] };
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
  if (state.config.endpoint && imported) scheduleIndexResume(100);
}

function scoreSegment(segment, asset) {
  return evaluateVideoSegment({ segment, asset, query: state.query, queryVector: state.queryVector, reference: state.reference, view: state.view });
}
function resultKeyForSegment(asset, segment, index = 0) {
  return `shot:${asset.id}:${segment.order ?? index}:${Number(segment.start ?? segment.time ?? 0).toFixed(3)}:${Number(segment.end ?? segment.time ?? 0).toFixed(3)}`;
}
function scoreAsset(asset) {
  return evaluateAsset({ asset, query: state.query, queryVector: state.queryVector, reference: state.reference, view: state.view, searchScope: state.searchScope });
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
        return [{ ...asset, resultKey: `asset:${asset.id}`, searchScore: scored.coarseScore ?? scored.score, coarseScore: scored.coarseScore, rerankScore: scored.rerankScore, rerankReasons: scored.rerankReasons, rerankChannels: scored.rerankChannels, matchReasons: scored.reasons, matchIntent: scored.intent, matchChannels: scored.channels, bestRegion: scored.bestRegion, bestSegment: scored.bestSegment, isShotResult: false }];
      }
      return asset.segments.map((segment, index) => {
        const scored = scoreSegment(segment, asset);
        return { ...asset, resultKey: resultKeyForSegment(asset, segment, index), searchScore: scored.score, matchReasons: scored.reasons, matchIntent: scored.intent, matchChannels: scored.channels, bestSegment: { ...segment, score: scored.score }, isShotResult: true };
      });
    });
  } else {
    assets = sourceAssets.map((asset) => {
      const scored = scoreAsset(asset);
      return { ...asset, resultKey: `asset:${asset.id}`, searchScore: scored.coarseScore ?? scored.score, coarseScore: scored.coarseScore, rerankScore: scored.rerankScore, rerankReasons: scored.rerankReasons, rerankChannels: scored.rerankChannels, matchReasons: scored.reasons, matchIntent: scored.intent, matchChannels: scored.channels, bestRegion: scored.bestRegion, bestSegment: scored.bestSegment, isShotResult: false };
    });
  }
  if (hasSearch) assets = calibrateAndDedupe(rerankImageCandidates(assets));
  assets.sort((a, b) => state.sort === "newest" ? b.createdAt - a.createdAt : state.sort === "used" ? b.uses - a.uses || b.createdAt - a.createdAt : b.searchScore - a.searchScore || b.createdAt - a.createdAt);
  return assets;
}

function renderCounts() {
  const count = (type) => state.assets.filter((asset) => asset.type === type).length;
  elements.assetCount.textContent = state.assets.length; elements.allCount.textContent = state.assets.length;
  elements.imageCount.textContent = count("image"); elements.videoCount.textContent = count("video"); elements.textCount.textContent = count("text");
  elements.videoDurationCount.textContent = formatLibraryDuration(state.assets.reduce((sum, asset) => sum + (asset.duration || 0), 0));
  elements.segmentCount.textContent = state.assets.reduce((sum, asset) => sum + (asset.segments?.length || asset.imageRegions?.length || 0), 0);
  elements.pendingIndexCount.textContent = state.assets.filter((asset) => asset.indexStatus !== "ready").length;
}
function iconForType(type) { return type === "video" ? "i-video" : type === "image" ? "i-image" : "i-text"; }
function typeLabel(type) { return type === "video" ? "VIDEO" : type === "image" ? "IMAGE" : "TEXT"; }
function assetKindLabel(asset) { return asset.documentType || typeLabel(asset.type); }
function indexStatusLabel(asset) { return asset.indexStatus === "ready" ? "INDEXED" : asset.indexStatus === "partial" ? "PARTIAL" : asset.indexStatus === "error" ? "RETRY" : asset.indexStatus === "indexing" ? "ANALYZING" : "PENDING"; }
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
  elements.resultSummary.textContent = empty ? "导入素材后即可开始搜索" : `${resultUnit}${isSearching ? "，已过滤弱匹配与重复镜头" : ""}`;
  if (empty) { elements.assetGrid.innerHTML = ""; return; }
  elements.assetGrid.innerHTML = assets.map((asset, index) => {
    const match = isSearching && asset.searchScore > 0 ? `<span class="asset-score">${Math.round(asset.searchScore * 100)}% · ${matchLevel(asset.searchScore)}</span>` : "";
    const range = asset.bestSegment ? asset.type === "video" ? `${formatDuration(asset.bestSegment.start)}–${formatDuration(asset.bestSegment.end)}` : `段落 ${Number(asset.bestSegment.order || 0) + 1}` : null;
    const detail = asset.isShotResult ? `${formatDuration(Math.max(0, asset.bestSegment.end - asset.bestSegment.start))} 镜头 · 原片 ${formatDuration(asset.duration)}` : asset.type === "video" ? `${formatDuration(asset.duration)} · ${asset.segments?.length || 0} 段` : asset.type === "image" ? `${asset.width}×${asset.height} · ${asset.imageRegions?.length || 0} 局部` : `${(asset.content || "").length} 字`;
    const imageExcerpt = asset.bestRegion ? `优先命中 ${asset.bestRegion.label}` : asset.ocrText && asset.matchReasons?.includes("图片文字") ? asset.ocrText.slice(0, 80) : null;
    const excerpt = asset.type === "text" ? asset.bestSegment?.content || asset.excerpt : asset.type === "image" && imageExcerpt ? imageExcerpt : asset.isShotResult && asset.bestSegment?.content ? asset.bestSegment.content : range ? `${asset.isShotResult ? "命中镜头" : "优先命中"} ${range}` : `${(asset.tags || []).slice(0, 3).join(" · ") || "等待语义索引"}`;
    const selected = state.selectedResultKey === asset.resultKey || (!state.selectedResultKey && state.selectedId === asset.id);
    const typeLine = `${asset.isShotResult ? "VIDEO SHOT" : assetKindLabel(asset)}${asset.sourceContainer ? " · ZIP" : ""}`;
    const matchReasons = isSearching && asset.matchReasons?.length ? `<div class="match-reasons"><span>命中原因</span>${asset.matchReasons.map((reason) => `<em>${escapeHtml(reason)}</em>`).join("")}</div>` : "";
    return `<article class="asset-card is-entering${selected ? " is-selected" : ""}" data-id="${asset.id}" data-result-key="${escapeHtml(asset.resultKey)}" style="animation-delay:${Math.min(index, 8) * 35}ms">
      <button class="asset-preview" data-action="select" aria-label="查看 ${escapeHtml(asset.name)}">${previewMarkup(asset)}<span class="asset-badge"><svg><use href="#${iconForType(asset.type)}"/></svg>${range || assetKindLabel(asset)}</span>${match}</button>
      <div class="asset-body"><div class="asset-type-line"><span>${typeLine} · ${indexStatusLabel(asset)}</span>${range ? `<em>${range}</em>` : ""}</div><h3 title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</h3><p>${escapeHtml(excerpt || "")}</p>${matchReasons}<div class="asset-meta"><span>${detail}</span><span>${formatBytes(asset.size)}</span><div class="asset-actions"><button data-action="download" aria-label="下载原文件"><svg><use href="#i-download"/></svg></button><button data-action="delete" aria-label="删除素材"><svg><use href="#i-trash"/></svg></button></div></div></div>
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
function renderAnalysisReceipt(asset) {
  if (asset.type !== "video" || !asset.analysisReceipt) return "";
  const receipt = asset.analysisReceipt;
  const labels = { scene: "画面切分", speech: "连续语音", ocr: "画面文字", subtitles: "字幕轨" };
  const items = Object.entries(receipt.components || {}).map(([key, component]) => {
    const status = component.status || "unknown";
    return `<div class="receipt-item is-${status}"><i></i><span>${labels[key] || key}<small>${escapeHtml(component.engine || "")}</small></span><strong>${escapeHtml(receiptStatusLabel(status))}${Number.isFinite(component.count) ? ` · ${component.count}` : ""}</strong></div>`;
  }).join("");
  const profile = ANALYSIS_PROFILES[receipt.profile] || ANALYSIS_PROFILES.smart_precision;
  const protocolLabel = receipt.precisionActive ? `${profile.label}已生效` : "旧版兼容模式";
  const telemetry = [receipt.sampledFrames ? `${receipt.sampledFrames} 个采样帧` : "", receipt.elapsedMs ? `${(receipt.elapsedMs / 1000).toFixed(1)} 秒` : ""].filter(Boolean).join(" · ");
  return `<div class="inspector-section analysis-receipt"><div class="section-heading-inline"><div><h3>分析凭证</h3><p>确认这条视频实际经过了哪些能力。</p></div><span class="receipt-profile${receipt.precisionActive ? " is-active" : ""}">${escapeHtml(protocolLabel)}</span></div><div class="receipt-grid">${items}</div>${telemetry ? `<p class="receipt-telemetry">${escapeHtml(telemetry)}</p>` : ""}</div>`;
}
function renderInspector() {
  const asset = state.assets.find((item) => item.id === state.selectedId);
  elements.inspector.classList.toggle("is-open", Boolean(asset));
  if (!asset) { setInspectorExpanded(false); elements.inspector.innerHTML = `<div class="inspector-empty"><span class="empty-cross"></span><p>选择一个结果，查看命中时间、原文件与索引信息。</p></div>`; return; }
  setInspectorExpanded(state.inspectorExpanded);
  const timeline = asset.segments || [];
  const segments = timeline.length ? `<div class="inspector-section"><div class="section-heading-inline"><h3>${asset.type === "text" ? "文字分段" : "可检索片段"}</h3><span>${timeline.length} 段</span></div><div class="moment-strip">${timeline.map((segment) => {
    const score = (state.query || state.reference) && asset.type === "video" ? scoreSegment(segment, asset).score : (state.queryVector || state.reference?.wemmVector) && segment.wemmVector ? Math.max(0, cosine(state.queryVector || state.reference.wemmVector, segment.wemmVector)) : null;
    if (asset.type === "text") return `<button class="moment-button" data-order="${segment.order || 0}"><span>${escapeHtml((segment.content || "").slice(0, 100))}</span>${score !== null ? `<em>${Math.round(score * 100)}%</em>` : ""}</button>`;
    return `<button class="moment-button" data-time="${segment.time}" data-start="${segment.start ?? segment.time}" data-end="${segment.end ?? segment.time}"><img src="${getBlobUrl(segment.thumbnail || asset.thumbnail)}" alt="${formatDuration(segment.time)} 的画面"/><span>${formatDuration(segment.start ?? segment.time)}–${formatDuration(segment.end ?? segment.time)}</span>${segment.content ? `<small>${escapeHtml(segment.content.slice(0, 64))}</small>` : ""}${score !== null ? `<em>${Math.round(score * 100)}%</em>` : ""}</button>`;
  }).join("")}</div></div>` : "";
  const imageRegions = asset.type === "image" && asset.imageRegions?.length ? `<div class="inspector-section"><div class="section-heading-inline"><div><h3>整图与局部索引</h3><p>局部区域用于找角落小物体、局部构图与细节。</p></div><span>${asset.imageRegions.length + 1} 个向量</span></div><div class="moment-strip image-region-strip">${asset.imageRegions.map((region) => {
    const referenceVectors = [state.reference?.wemmVector, ...(state.reference?.imageRegionVectors || [])].filter(Boolean);
    const regionScore = state.queryVector && region.wemmVector ? Math.max(0, cosine(state.queryVector, region.wemmVector)) : referenceVectors.length && region.wemmVector ? Math.max(...referenceVectors.map((vector) => Math.max(0, cosine(vector, region.wemmVector)))) : null;
    return `<div class="moment-button image-region-card"><img src="${getBlobUrl(region.thumbnail || asset.thumbnail)}" alt="${escapeHtml(region.label)}"/><span>${escapeHtml(region.label)}</span>${regionScore !== null ? `<em>${Math.round(regionScore * 100)}%</em>` : ""}</div>`;
  }).join("")}</div></div>` : "";
  const insightItems = [
    ...(asset.transcript || []).slice(0, 6).map((item) => ({ type: "语音", time: item.start, text: item.text })),
    ...(asset.subtitles || []).slice(0, 6).map((item) => ({ type: "字幕轨", time: item.start, text: item.text })),
    ...(asset.ocr || []).slice(0, 6).map((item) => ({ type: "画面文字", time: item.time, text: item.text }))
  ].sort((a, b) => a.time - b.time);
  const warningText = (asset.analysisWarnings || []).length ? `<p class="analysis-warning">${escapeHtml(asset.analysisWarnings.join("；"))}</p>` : "";
  const mediaInsights = asset.type === "video" && (insightItems.length || warningText) ? `<div class="inspector-section"><div class="section-heading-inline"><h3>语音、字幕与画面文字</h3><span>${(asset.transcript || []).length + (asset.subtitles || []).length + (asset.ocr || []).length} 条</span></div>${insightItems.length ? `<div class="analysis-list">${insightItems.map((item) => `<button data-time="${item.time}" data-start="${item.time}" data-end="${item.time}"><b>${item.type} · ${formatDuration(item.time)}</b><span>${escapeHtml(item.text)}</span></button>`).join("")}</div>` : ""}${warningText}</div>` : "";
  const imageWarnings = (asset.imageAnalysisWarnings || []).length ? `<p class="analysis-warning">${escapeHtml(asset.imageAnalysisWarnings.join("；"))}</p>` : "";
  const imageOcrInsights = asset.type === "image" && ((asset.ocr || []).length || imageWarnings) ? `<div class="inspector-section"><div class="section-heading-inline"><div><h3>图片文字 OCR</h3><p>海报标题、价格、品牌名与包装文字可直接搜索。</p></div><span>${(asset.ocr || []).length} 条</span></div>${(asset.ocr || []).length ? `<div class="analysis-list">${asset.ocr.slice(0, 20).map((item) => `<div><b>${item.confidence == null ? "已识别" : `${Math.round(item.confidence * 100)}%`}</b><span>${escapeHtml(item.text)}</span></div>`).join("")}</div>` : ""}${imageWarnings}</div>` : "";
  const analysisReceipt = renderAnalysisReceipt(asset);
  const sizeInfo = asset.type === "text" ? `${(asset.content || "").length} 字` : `${asset.width} × ${asset.height}`;
  const sourceMeta = asset.sourceContainer ? `<div><span>压缩包来源</span><strong>${escapeHtml(asset.sourceContainer)}</strong></div><div><span>包内路径</span><strong>${escapeHtml(asset.sourcePath || asset.name)}</strong></div>` : "";
  const documentMeta = asset.documentType ? `<div><span>文档格式</span><strong>${escapeHtml(asset.documentType)}</strong></div>${asset.pageCount ? `<div><span>页数</span><strong>${asset.pageCount} 页</strong></div>` : ""}` : "";
  const parseWarning = asset.parseWarning ? `<p class="analysis-warning">${escapeHtml(asset.parseWarning)}</p>` : "";
  const expandButton = asset.type === "video" ? `<button class="icon-button" data-action="expand" aria-label="${state.inspectorExpanded ? "退出大窗口审片" : "打开大窗口审片"}"><svg><use href="#i-expand"/></svg></button>` : "";
  const reindexButton = ["video", "image"].includes(asset.type) ? `<button class="secondary-button" data-action="reindex-one"><svg><use href="#i-refresh"/></svg>重新分析</button>` : "";
  const recovery = asset.indexError ? `<div class="error-recovery"><p>${escapeHtml(asset.indexError)}</p><button class="secondary-button" data-action="retry-index"><svg><use href="#i-refresh"/></svg>重试这个素材</button></div>` : "";
  elements.inspector.innerHTML = `<div class="inspector-content"><div class="inspector-media">${inspectorMedia(asset)}</div><div class="inspector-head"><div><h2>${escapeHtml(asset.name)}</h2><p>${asset.type === "video" ? "视频" : asset.type === "image" ? "图片" : asset.documentType ? `${asset.documentType} 文档` : "文字"} · ${formatBytes(asset.size)}</p></div><div class="inspector-head-actions">${expandButton}<button class="icon-button" data-action="download" aria-label="下载原文件"><svg><use href="#i-download"/></svg></button><button class="icon-button" data-action="close" aria-label="关闭详情"><svg><use href="#i-close"/></svg></button></div></div><div class="inspector-section"><h3>素材信息</h3><div class="meta-grid"><div><span>规格</span><strong>${sizeInfo}</strong></div><div><span>使用次数</span><strong>${asset.uses} 次</strong></div><div><span>索引方式</span><strong>${asset.indexMode || "本地"}</strong></div><div><span>检索单元</span><strong>${asset.type === "image" ? (asset.imageRegions?.length || 0) + 1 : asset.segments?.length || 1} 个</strong></div>${documentMeta}${sourceMeta}</div>${parseWarning}${recovery}</div>${analysisReceipt}${segments}${imageRegions}${mediaInsights}${imageOcrInsights}<div class="inspector-section"><h3>检索标签</h3><div class="tag-list">${(asset.tags || []).map((tag) => `<button data-remove-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("")}</div><div class="tag-editor"><input id="tagInput" placeholder="添加检索标签" aria-label="新标签"/><button class="secondary-button" data-action="add-tag">添加</button></div></div><div class="inspector-actions">${reindexButton}<button class="primary-button" data-action="use"><svg><use href="#i-check"/></svg>标记已使用</button><button class="danger-button" data-action="delete" aria-label="删除素材"><svg><use href="#i-trash"/></svg></button></div></div>`;
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
async function requestEmbedding(inputs, config = state.config, signal, priority = "interactive") {
  const response = await fetch("/api/wemm/embed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: config.endpoint, apiKey: config.apiKey, dimension: Number(config.dimension), inputs, priority }), signal });
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
    state.mediaHealth = "online"; state.mediaCapabilities = payload; renderModelStatus(); return payload;
  } catch (error) {
    state.mediaHealth = "offline"; state.mediaCapabilities = null; renderModelStatus(); throw error;
  }
}
function deriveMediaEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!/^https?:\/\//i.test(value)) return "";
  return value.replace(/:8000(?=\/|$)/, ":8001").replace(/\/$/, "");
}
function precisionProtocolAvailable(capabilities = state.mediaCapabilities) { return capabilities?.analysis_protocol === ANALYSIS_PROTOCOL || Boolean(capabilities?.capabilities?.dynamic_sampling); }
function imageOcrAvailable(capabilities = state.mediaCapabilities) { return Boolean(capabilities?.image_ocr || capabilities?.capabilities?.image_ocr); }
function chunkedAnalysisAvailable(capabilities = state.mediaCapabilities) { return Boolean(capabilities?.chunked_analysis || capabilities?.capabilities?.chunked_analysis); }
function currentImageIndexSignature() { return imageIndexSignature({ imageOcr: Boolean(state.config.mediaEndpoint && imageOcrAvailable()) }); }
function segmentSignature() {
  const mediaVersion = chunkedAnalysisAvailable()
    ? `media-v5-chunked-${normalizeAnalysisProfile(state.config.analysisProfile)}`
    : precisionProtocolAvailable()
      ? `media-v4-${normalizeAnalysisProfile(state.config.analysisProfile)}`
      : "media-v3-channels";
  return `${Number(state.config.segmentSeconds)}:${Number(state.config.overlapSeconds)}:${state.config.mediaEndpoint ? mediaVersion : "fixed-v3-visual"}`;
}
function planLocalSegments(duration, lengthOverride = null, overlapOverride = null) {
  const length = Number(lengthOverride ?? state.config.segmentSeconds) || 6; const overlap = Math.min(Number(overlapOverride ?? state.config.overlapSeconds) || 0, length - 1);
  if (!duration || duration <= length) return [{ start: 0, end: duration, time: duration / 2 }];
  const segments = []; const step = Math.max(1, length - overlap); let start = 0;
  while (start < duration) { const safeStart = Math.min(start, Math.max(0, duration - length)); const end = Math.min(duration, safeStart + length); segments.push({ start: safeStart, end, time: (safeStart + end) / 2 }); if (end >= duration) break; start += step; }
  return segments.filter((segment, index, list) => index === 0 || segment.start !== list[index - 1].start);
}
async function requestVideoSegments(asset, signal) {
  const profile = ANALYSIS_PROFILES[normalizeAnalysisProfile(state.config.analysisProfile)];
  const precisionActive = Boolean(state.config.mediaEndpoint && normalizeAnalysisProfile(state.config.analysisProfile) === "smart_precision");
  const segmentSeconds = precisionActive ? profile.targetSeconds : state.config.segmentSeconds;
  const overlapSeconds = precisionActive ? 0 : state.config.overlapSeconds;
  const params = new URLSearchParams({ dimension: state.config.dimension, segment_seconds: segmentSeconds, overlap_seconds: overlapSeconds, max_segments: "0", priority: "background" });
  const form = new FormData();
  form.append("file", asset.blob, asset.name);
  const response = await fetch(`/api/wemm/index-video?${params}`, { method: "POST", headers: { "x-radar-endpoint": state.config.endpoint, "x-radar-api-key": state.config.apiKey }, body: form, signal });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "视频切片索引失败");
  const expected = planLocalSegments(asset.duration, segmentSeconds, overlapSeconds).length;
  if (expected > 1 && (payload.segments?.length || 0) < expected) {
    throw new Error(`模型服务只返回 ${payload.segments?.length || 0}/${expected} 段，请更新拯救者上的 cloud/wemm_api.py 后重启服务`);
  }
  return payload.segments.map((segment) => {
    const visualWemmVector = normalizeVector(segment.embedding);
    return { start: segment.start, end: segment.end, time: segment.time, visualWemmVector, wemmVector: visualWemmVector };
  });
}
function numberFrom(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function itemRecord(item) { return item && typeof item === "object" ? item : { text: String(item ?? "") }; }
function normalizeWarnings(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeWarnings);
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!value || typeof value !== "object") return [];
  if (typeof value.message === "string") return normalizeWarnings(value.message);
  if (typeof value.detail === "string") return normalizeWarnings(value.detail);
  return Object.values(value).flatMap(normalizeWarnings);
}
function normalizeTranscript(payload, duration) {
  const items = payloadItemsFor(payload, ["transcript", "asr", "speech"]);
  return items.map((rawItem) => {
    const item = itemRecord(rawItem);
    const start = Math.max(0, numberFrom(item.start ?? item.start_time, 0));
    const end = Math.min(duration, Math.max(start, numberFrom(item.end ?? item.end_time, start)));
    return { start, end, text: String(item.text || item.content || "").trim(), language: item.language || item.lang || null, emotion: item.emotion || null, event: item.event || null, analysisChunkIndex: Number.isInteger(item.analysisChunkIndex) ? item.analysisChunkIndex : null };
  }).filter((item) => item.text);
}
function normalizeOcr(payload, duration) {
  const items = payloadItemsFor(payload, ["ocr", "texts"]);
  return items.map((rawItem) => {
    const item = itemRecord(rawItem);
    return ({
    time: Math.min(duration, Math.max(0, numberFrom(item.time ?? item.timestamp ?? item.start, 0))),
    text: String(item.text || item.content || "").trim(),
    confidence: Number.isFinite(Number(item.confidence ?? item.score)) ? Number(item.confidence ?? item.score) : null,
    box: item.box || item.bbox || null,
    analysisChunkIndex: Number.isInteger(item.analysisChunkIndex) ? item.analysisChunkIndex : null
    });
  }).filter((item) => item.text);
}
function normalizeSubtitles(payload, duration) {
  const direct = payloadItemsFor(payload, ["subtitles", "subtitle_cues"]);
  const tracks = subtitleTracksFromPayload(payload).flatMap((track) => track.cues.map((item) => ({
    ...itemRecord(item),
    language: itemRecord(item).language || itemRecord(item).lang || track.language || track.lang || null
  })));
  const normalized = [...direct, ...tracks].map((rawItem) => {
    const item = itemRecord(rawItem);
    const start = Math.min(duration, Math.max(0, numberFrom(item.start ?? item.start_time ?? item.time, 0)));
    const end = Math.min(duration, Math.max(start, numberFrom(item.end ?? item.end_time, start)));
    return { start, end, text: String(item.text || item.content || "").trim(), language: item.language || item.lang || null, source: item.source || "embedded", analysisChunkIndex: Number.isInteger(item.analysisChunkIndex) ? item.analysisChunkIndex : null };
  }).filter((item) => item.text);
  const seen = new Set();
  return normalized.filter((item) => {
    const key = `${item.start}|${item.end}|${item.text}|${item.language || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function normalizeScenes(payload, duration, fallback) {
  const preciseUnits = payloadItemsFor(payload, ["search_units", "retrieval_units"]);
  const items = preciseUnits.length ? preciseUnits : payloadItemsFor(payload, ["scenes", "shots"]);
  let scenes = items.map((rawItem) => {
    const item = itemRecord(rawItem);
    const start = Math.min(duration, Math.max(0, numberFrom(item.start ?? item.start_time, 0)));
    const end = Math.min(duration, Math.max(start, numberFrom(item.end ?? item.end_time, start)));
    const keyframe = Math.min(end, Math.max(start, numberFrom(item.keyframe ?? item.keyframe_time ?? item.time, (start + end) / 2)));
    return { start, end, time: keyframe, analysisChunkIndex: Number.isInteger(item.analysisChunkIndex) ? item.analysisChunkIndex : null };
  }).filter((item) => item.end - item.start > .05).sort((a, b) => a.start - b.start);
  if (!preciseUnits.length && normalizeAnalysisProfile(state.config.analysisProfile) === "smart_precision") {
    scenes = scenes.flatMap((scene) => scene.end - scene.start > 3.2 ? planLocalSegments(scene.end - scene.start, ANALYSIS_PROFILES.smart_precision.targetSeconds, 0).map((unit) => ({ start: scene.start + unit.start, end: scene.start + unit.end, time: scene.start + unit.time, analysisChunkIndex: scene.analysisChunkIndex })) : [scene]);
  }
  return scenes.length ? scenes : fallback.map((item) => ({ start: item.start, end: item.end, time: item.time, analysisChunkIndex: Number.isInteger(item.analysisChunkIndex) ? item.analysisChunkIndex : null }));
}
function overlapsRange(item, start, end) { return numberFrom(item.end, item.start) >= start && numberFrom(item.start, item.time) <= end; }
async function requestMediaAnalysis(asset, signal) {
  const form = new FormData();
  form.append("file", asset.blob, asset.name);
  Object.entries(analysisRequestFields(state.config.analysisProfile)).forEach(([key, value]) => form.append(key, value));
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
async function requestImageAnalysis(asset, signal) {
  const form = new FormData(); form.append("file", asset.blob, asset.name);
  const response = await fetch("/api/media/analyze-image", {
    method: "POST",
    headers: { "x-radar-media-endpoint": state.config.mediaEndpoint, "x-radar-api-key": state.config.apiKey },
    body: form,
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "图片文字识别失败");
  return payload;
}
async function analyzeVideoMedia(asset, signal) {
  const payload = await requestMediaAnalysis(asset, signal);
  const duration = numberFrom(payload.duration, asset.duration) || asset.duration;
  const transcript = normalizeTranscript(payload, duration);
  const ocr = normalizeOcr(payload, duration);
  const subtitles = normalizeSubtitles(payload, duration);
  const scenes = normalizeScenes(payload, duration, planLocalSegments(duration));
  const normalized = { duration, scenes, transcript, ocr, subtitles };
  return { ...normalized, receipt: normalizeAnalysisReceipt(payload, normalized, state.config.analysisProfile), warnings: normalizeWarnings(payload.warnings) };
}
function waitWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("任务已停止", "AbortError")); }, { once: true });
  });
}
async function startChunkedMediaTask(asset, signal) {
  const form = new FormData();
  if (!asset.analysisGeneration) {
    asset.analysisGeneration = crypto.randomUUID();
    asset.analysisStage = "upload";
    asset.analysisProgress = 1;
    await putAsset(asset);
  }
  const generation = asset.analysisGeneration;
  form.append("file", asset.blob, asset.name);
  form.append("asset_key", asset.fingerprint || `${asset.name}:${asset.size}`);
  form.append("client_asset_id", asset.id);
  form.append("generation_id", generation);
  form.append("chunk_seconds", String(DEFAULT_ANALYSIS_CHUNK_SECONDS));
  Object.entries(analysisRequestFields(state.config.analysisProfile)).forEach(([key, value]) => form.append(key, value));
  form.set("ocr_fps", "0.35");
  form.append("ocr_strategy", "dynamic");
  form.append("ocr_max_frames_per_chunk", "75");
  const response = await fetch("/api/media/analyze-video/start", {
    method: "POST",
    headers: { "x-radar-media-endpoint": state.config.mediaEndpoint, "x-radar-api-key": state.config.apiKey },
    body: form,
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "无法创建长视频分块任务");
  if (!payload.task_id && !payload.taskId) throw new Error("分块服务没有返回任务 ID");
  const returnedGeneration = payload.generation_id || payload.generationId;
  if (returnedGeneration && String(returnedGeneration) !== String(generation)) throw new Error("拯救者返回了另一代分析任务，已拒绝覆盖本地断点");
  const reportedDuration = numberFrom(payload.duration, asset.duration);
  if (reportedDuration > 0) asset.duration = reportedDuration;
  asset.mediaTaskId = payload.task_id || payload.taskId;
  asset.analysisGeneration = generation;
  asset.analysisProtocol = "radar-long-video-v1";
  asset.analysisChunkSeconds = Number(payload.chunk_seconds || DEFAULT_ANALYSIS_CHUNK_SECONDS);
  asset.analysisChunks = mergeChunkState(planAnalysisChunks(asset.duration, asset.analysisChunkSeconds), payload.chunks || [], asset.analysisChunks || []);
  asset.analysisStage = "chunk-uploaded"; asset.analysisProgress = 3; state.mediaTaskUpdatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
}
function assertChunkTaskIdentity(asset, payload = {}) {
  const task = payload.task || payload;
  const taskId = task.task_id || task.taskId || (payload.task ? task.id : null);
  const generation = task.generation_id || task.generationId || payload.generation_id || payload.generationId;
  if (taskId && asset.mediaTaskId && String(taskId) !== String(asset.mediaTaskId)) throw new Error("收到的分块结果不属于当前视频任务");
  if (generation && asset.analysisGeneration && String(generation) !== String(asset.analysisGeneration)) throw new Error("收到的分块结果属于旧版分析，已拒绝覆盖新断点");
}
async function fetchChunkedTaskStatus(asset, signal) {
  const response = await fetch("/api/media/task-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: state.config.mediaEndpoint, apiKey: state.config.apiKey, taskId: asset.mediaTaskId }),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || "无法读取长视频分块状态");
  assertChunkTaskIdentity(asset, payload);
  return payload;
}
async function fetchChunkedTaskResult(asset, chunk, signal) {
  const response = await fetch("/api/media/task-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: state.config.mediaEndpoint, apiKey: state.config.apiKey, taskId: asset.mediaTaskId, chunkIndex: chunk.index }),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || `第 ${chunk.index + 1} 块结果读取失败`);
  assertChunkTaskIdentity(asset, payload);
  return payload;
}
async function retryChunkedTask(asset, chunk, signal) {
  const response = await fetch("/api/media/retry-chunk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: state.config.mediaEndpoint, apiKey: state.config.apiKey, taskId: asset.mediaTaskId, chunkIndex: chunk.index }),
    signal
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.detail || `第 ${chunk.index + 1} 块重试失败`);
  chunk.status = "queued"; chunk.stage = "queued"; chunk.error = null; chunk.attempts = Number(chunk.attempts || 0) + 1;
}
function normalizedAnalysisFromChunkPayload(payload, chunk, duration) {
  const adjusted = normalizeChunkResult(payload, chunk);
  const transcript = normalizeTranscript(adjusted, duration);
  const ocr = normalizeOcr(adjusted, duration);
  const subtitles = normalizeSubtitles(adjusted, duration);
  const fallback = planLocalSegments(chunk.end - chunk.start).map((item) => ({ start: item.start + chunk.start, end: item.end + chunk.start, time: item.time + chunk.start, analysisChunkIndex: chunk.index }));
  const scenes = normalizeScenes(adjusted, duration, fallback);
  const normalized = { duration, scenes, transcript, ocr, subtitles };
  return { ...normalized, receipt: normalizeAnalysisReceipt(adjusted, normalized, state.config.analysisProfile), warnings: normalizeWarnings(adjusted.warnings) };
}
function mergeSavedChunkAnalyses(asset) {
  const saved = (asset.analysisChunks || []).filter((chunk) => chunk.resultSaved && chunk.analysis);
  const warnings = [];
  saved.forEach((chunk) => warnings.push(...(chunk.analysis.warnings || [])));
  (asset.analysisChunks || []).filter((chunk) => ["failed", "error"].includes(chunk.status)).forEach((chunk) => warnings.push(`第 ${chunk.index + 1} 块失败：${chunk.error || "未知错误"}`));
  (asset.analysisChunks || []).filter(chunkResultFetchExhausted).forEach((chunk) => warnings.push(`第 ${chunk.index + 1} 块已经算完，但结果读取失败：${chunk.resultFetchError || "网络错误"}`));
  const normalized = {
    duration: asset.duration,
    scenes: saved.flatMap((chunk) => chunk.analysis.scenes || []).sort((a, b) => a.start - b.start),
    transcript: saved.flatMap((chunk) => chunk.analysis.transcript || []).sort((a, b) => a.start - b.start),
    ocr: saved.flatMap((chunk) => chunk.analysis.ocr || []).sort((a, b) => a.time - b.time),
    subtitles: saved.flatMap((chunk) => chunk.analysis.subtitles || []).sort((a, b) => a.start - b.start)
  };
  const receipts = saved.map((chunk) => chunk.analysis.receipt).filter(Boolean);
  const receiptPayload = {
    analysis_protocol: ANALYSIS_PROTOCOL,
    analysis_profile: state.config.analysisProfile,
    sampled_frames: receipts.reduce((sum, item) => sum + Number(item.sampledFrames || 0), 0),
    elapsed_ms: receipts.reduce((sum, item) => sum + Number(item.elapsedMs || 0), 0),
    capabilities: { scene: true, asr: true, ocr: true, subtitles: true, dynamic_sampling: true }
  };
  return { ...normalized, receipt: normalizeAnalysisReceipt(receiptPayload, normalized, state.config.analysisProfile), warnings: [...new Set(warnings)] };
}
function chunkResultFetchExhausted(chunk) {
  return !chunk.resultSaved && ["ready", "complete"].includes(chunk.status) && chunk.resultFetchStatus === "error" && Number(chunk.resultFetchAttempts || 0) >= MEDIA_AUTO_RETRY_LIMIT;
}
function chunkProcessingTerminal(chunk) {
  return chunk.resultSaved
    || (["error", "failed"].includes(chunk.status) && Number(chunk.attempts || 0) >= MEDIA_AUTO_RETRY_LIMIT)
    || chunkResultFetchExhausted(chunk);
}
async function analyzeVideoMediaChunked(asset, signal) {
  const locallyTerminal = asset.analysisChunks?.length && asset.analysisChunks.every(chunkProcessingTerminal);
  if (locallyTerminal) {
    const saved = mergeSavedChunkAnalyses(asset);
    if (saved.scenes.length || saved.transcript.length || saved.ocr.length || saved.subtitles.length) return saved;
  }
  if (!asset.mediaTaskId) await startChunkedMediaTask(asset, signal);
  if (!asset.analysisChunks?.length) asset.analysisChunks = planAnalysisChunks(asset.duration);
  let idlePolls = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException("任务已停止", "AbortError");
    const payload = await fetchChunkedTaskStatus(asset, signal);
    const remoteChunks = payload.chunks || payload.task?.chunks || [];
    const chunkSeconds = Number(payload.chunk_seconds || asset.analysisChunkSeconds || DEFAULT_ANALYSIS_CHUNK_SECONDS);
    asset.analysisChunkSeconds = chunkSeconds;
    asset.analysisChunks = mergeChunkState(planAnalysisChunks(asset.duration, chunkSeconds), remoteChunks, asset.analysisChunks);
    let changed = false;
    for (const chunk of asset.analysisChunks) {
      if (["ready", "complete"].includes(chunk.status) && !chunk.resultSaved && Number(chunk.resultFetchAttempts || 0) < MEDIA_AUTO_RETRY_LIMIT && Number(chunk.resultFetchNextRetryAt || 0) <= Date.now()) {
        try {
          const result = await fetchChunkedTaskResult(asset, chunk, signal);
          chunk.analysis = normalizedAnalysisFromChunkPayload(result, chunk, asset.duration); chunk.resultSaved = true; chunk.progress = 100;
          chunk.resultParserVersion = CHUNK_RESULT_PARSER_VERSION;
          chunk.resultFetchStatus = "ready"; chunk.resultFetchAttempts = 0; chunk.resultFetchNextRetryAt = null; chunk.resultFetchError = null;
          chunk.sceneCount = chunk.analysis.scenes.length; chunk.transcriptCount = chunk.analysis.transcript.length; chunk.ocrCount = chunk.analysis.ocr.length; changed = true;
          chunk.components = {
            ...(chunk.components || {}),
            scene: { ...(chunk.components?.scene || {}), status: "ready", progress: 100, count: chunk.sceneCount },
            speech: { ...(chunk.components?.speech || {}), status: "ready", progress: 100, count: chunk.transcriptCount },
            ocr: { ...(chunk.components?.ocr || {}), status: "ready", progress: 100, count: chunk.ocrCount }
          };
          state.mediaTaskUpdatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
        } catch (error) {
          chunk.resultFetchStatus = "error";
          chunk.resultFetchAttempts = Number(chunk.resultFetchAttempts || 0) + 1;
          chunk.resultFetchNextRetryAt = Date.now() + retryDelayForAttempt(chunk.resultFetchAttempts);
          chunk.resultFetchError = error.message;
          changed = true;
        }
      }
      if (["error", "failed"].includes(chunk.status) && Number(chunk.attempts || 0) < MEDIA_AUTO_RETRY_LIMIT) {
        try { await retryChunkedTask(asset, chunk, signal); changed = true; }
        catch (error) { chunk.attempts = Number(chunk.attempts || 0) + 1; chunk.error = error.message; changed = true; }
      }
    }
    const summary = summarizeChunkProgress(asset.analysisChunks);
    asset.analysisStage = "chunks"; asset.analysisProgress = Math.min(56, Math.round(summary.percent * .56)); state.mediaTaskUpdatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
    const terminal = asset.analysisChunks.every(chunkProcessingTerminal);
    if (terminal) break;
    const running = ["running", "queued", "processing"].includes(payload.status || payload.task?.status);
    idlePolls = changed || running ? 0 : idlePolls + 1;
    if (idlePolls > 120) throw new Error("长视频任务长时间没有进展，已保留完成块，可稍后继续");
    await waitWithSignal(2500, signal);
  }
  const analysis = mergeSavedChunkAnalyses(asset);
  if (!analysis.scenes.length && !analysis.transcript.length && !analysis.ocr.length) throw new Error("所有长视频分块均未产生可用结果");
  return analysis;
}
function textChannelsForScene(scene, analysis) {
  if (!analysis) return { speechText: "", ocrText: "", content: "" };
  const speech = [...analysis.transcript, ...(analysis.subtitles || [])].filter((item) => overlapsRange(item, scene.start, scene.end)).map((item) => item.text);
  const frameText = analysis.ocr.filter((item) => item.time >= scene.start && item.time <= scene.end).map((item) => item.text);
  const speechText = [...new Set(speech)].join(" ");
  const ocrText = [...new Set(frameText)].join(" ");
  return { speechText, ocrText, content: [...new Set([...speech, ...frameText])].join(" ") };
}
async function embedSceneChannels(scenes, analysis, signal) {
  const texts = scenes.map((scene) => textChannelsForScene(scene, analysis));
  const inputs = [];
  texts.forEach((item, index) => {
    if (item.speechText) inputs.push({ index, channel: "speechVector", text: item.speechText });
    if (item.ocrText) inputs.push({ index, channel: "ocrVector", text: item.ocrText });
  });
  const vectors = inputs.length ? await embedInBatches(inputs.map((item) => ({ kind: "text", text: item.text })), signal) : [];
  const vectorMaps = { speechVector: new Map(), ocrVector: new Map() };
  inputs.forEach((item, vectorIndex) => vectorMaps[item.channel].set(item.index, vectors[vectorIndex]));
  return { texts, ...vectorMaps };
}
async function enrichVideoSegments(videoSegments, analysis, signal) {
  if (!analysis) return videoSegments;
  const scenes = analysis.scenes;
  const { texts, speechVector, ocrVector } = await embedSceneChannels(scenes, analysis, signal);
  return scenes.map((scene, index) => {
    let visualMatches = videoSegments.filter((segment) => overlapsRange(segment, scene.start, scene.end));
    if (!visualMatches.length && videoSegments.length) visualMatches = [videoSegments.reduce((best, item) => Math.abs(item.time - scene.time) < Math.abs(best.time - scene.time) ? item : best)];
    const visualWemmVector = averageVectors(visualMatches.map((item) => item.visualWemmVector || item.wemmVector));
    return { ...scene, ...texts[index], visualWemmVector, speechVector: speechVector.get(index) || null, ocrVector: ocrVector.get(index) || null, wemmVector: visualWemmVector };
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
  const { texts, speechVector, ocrVector } = await embedSceneChannels(segments, analysis, signal);
  return segments.map((segment, index) => ({
    ...segment,
    ...texts[index],
    visualWemmVector: imageVectors[index],
    speechVector: speechVector.get(index) || null,
    ocrVector: ocrVector.get(index) || null,
    wemmVector: imageVectors[index]
  }));
}
async function buildCheckpointedChunkSegments(asset, signal) {
  const output = [];
  for (const chunk of asset.analysisChunks || []) {
    if (signal?.aborted) throw new DOMException("任务已停止", "AbortError");
    if (chunk.vectorStatus === "ready" && chunk.segments?.length) { output.push(...chunk.segments); continue; }
    const fallbackScenes = planLocalSegments(chunk.end - chunk.start).map((item) => ({ start: item.start + chunk.start, end: item.end + chunk.start, time: item.time + chunk.start }));
    const chunkAnalysis = chunk.analysis || { duration: asset.duration, scenes: fallbackScenes, transcript: [], ocr: [], subtitles: [] };
    chunk.vectorStatus = "running"; chunk.stage = "embedding"; chunk.vectorError = null;
    chunk.components = { ...(chunk.components || {}), vector: { ...(chunk.components?.vector || {}), status: "running", progress: 5, count: Number(chunk.vectorCount || 0) } };
    asset.analysisStage = "embedding"; await putAsset(asset); renderTaskCenter();
    try {
      chunk.segments = (await buildKeyframeSegments(asset, chunkAnalysis, signal)).map((segment) => ({ ...segment, analysisChunkIndex: chunk.index }));
      chunk.vectorCount = chunk.segments.length; chunk.vectorStatus = "ready"; chunk.stage = "done"; chunk.progress = 100;
      chunk.components.vector = { status: "ready", progress: 100, count: chunk.vectorCount };
      output.push(...chunk.segments); state.mediaTaskUpdatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
    } catch (error) {
      if (error.name === "AbortError") throw error;
      chunk.components.vector = { ...(chunk.components?.vector || {}), status: "error", progress: 0, count: Number(chunk.vectorCount || 0), error: error.message };
      chunk.vectorStatus = "error"; chunk.vectorError = error.message; chunk.error = chunk.error || `向量写入失败：${error.message}`;
      asset.analysisRetryCount = MEDIA_AUTO_RETRY_LIMIT; asset.analysisBlockedSignature = segmentSignature(); asset.analysisNextRetryAt = null; await putAsset(asset); renderTaskCenter();
    }
  }
  if (!output.length) throw new Error("长视频所有分块的向量写入都失败了");
  return output.sort((a, b) => a.start - b.start);
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
async function embedInBatches(inputs, signal, priority = "background") {
  const vectors = [];
  const batchSize = priority === "interactive" ? 16 : 4;
  for (let index = 0; index < inputs.length; index += batchSize) { if (signal?.aborted) throw new DOMException("任务已停止", "AbortError"); vectors.push(...await requestEmbedding(inputs.slice(index, index + batchSize), state.config, signal, priority)); }
  return vectors.map(normalizeVector);
}
async function indexOneAsset(asset, signal, options = {}) {
  const modelAvailable = options.modelAvailable !== false;
  let mediaError = null;
  if (asset.type === "video") {
    asset.indexStatus = "indexing"; asset.analysisStage = state.config.mediaEndpoint ? "scene" : "embedding"; asset.analysisProgress = 5; asset.indexError = null; await putAsset(asset); renderTaskCenter();
    let analysis = null; let visualSegments = null; let videoEndpointError = null;
    const isLongVideo = asset.duration >= LONG_VIDEO_THRESHOLD_SECONDS;
    const useChunkedAnalysis = isLongVideo && state.config.mediaEndpoint && chunkedAnalysisAvailable();
    if (isLongVideo && !asset.analysisChunks?.length) asset.analysisChunks = planAnalysisChunks(asset.duration);
    if (state.config.mediaEndpoint) {
      if (isLongVideo && !chunkedAnalysisAvailable()) {
        mediaError = new Error("8001 尚未启用长视频分块断点，请先完成拯救者升级");
        asset.mediaAnalysisStatus = "partial";
        asset.analysisRetryCount = MEDIA_AUTO_RETRY_LIMIT;
        asset.analysisBlockedSignature = segmentSignature();
        asset.analysisNextRetryAt = null;
      } else {
        try {
          analysis = useChunkedAnalysis ? await analyzeVideoMediaChunked(asset, signal) : await analyzeVideoMedia(asset, signal);
          const failedChunks = useChunkedAnalysis ? (asset.analysisChunks || []).filter((chunk) => (["error", "failed"].includes(chunk.status) && !chunk.resultSaved) || chunkResultFetchExhausted(chunk)).length : 0;
          asset.mediaAnalysisStatus = failedChunks ? "partial" : "ready";
          asset.analysisRetryCount = failedChunks ? MEDIA_AUTO_RETRY_LIMIT : 0;
          asset.analysisBlockedSignature = failedChunks ? segmentSignature() : null;
          asset.analysisNextRetryAt = null;
        }
        catch (error) {
          if (error.name === "AbortError") throw error;
          mediaError = error;
          const savedChunkAnalysis = useChunkedAnalysis ? mergeSavedChunkAnalyses(asset) : null;
          if (savedChunkAnalysis && (savedChunkAnalysis.scenes.length || savedChunkAnalysis.transcript.length || savedChunkAnalysis.ocr.length || savedChunkAnalysis.subtitles.length)) {
            analysis = savedChunkAnalysis;
            asset.mediaAnalysisStatus = "partial";
          } else asset.mediaAnalysisStatus = "error";
          asset.analysisRetryCount = Number(asset.analysisRetryCount || 0) + 1;
          if (asset.analysisRetryCount >= MEDIA_AUTO_RETRY_LIMIT) asset.analysisBlockedSignature = segmentSignature();
          asset.analysisNextRetryAt = Date.now() + retryDelayForAttempt(asset.analysisRetryCount);
        }
      }
    } else asset.mediaAnalysisStatus = "disabled";
    asset.analysisStage = "embedding"; asset.analysisProgress = 58; await putAsset(asset); renderTaskCenter();
    if (modelAvailable && !isLongVideo) {
      try { visualSegments = await requestVideoSegments(asset, signal); }
      catch (error) { if (error.name === "AbortError") throw error; videoEndpointError = error; }
    }

    let segments;
    if (isLongVideo && modelAvailable) {
      segments = await buildCheckpointedChunkSegments(asset, signal);
      asset.indexMode = useChunkedAnalysis
        ? `分块断点 · ${(asset.analysisChunks || []).length} 块 · 动态OCR多路索引`
        : `分块断点视觉索引 · ${(asset.analysisChunks || []).length} 块 · 等待媒体服务升级`;
    } else if (!modelAvailable) {
      segments = (asset.analysisChunks || []).flatMap((chunk) => chunk.segments || []);
      asset.indexMode = `分块媒体结果已保存 · 等待 WeMM 向量`;
    } else if (visualSegments?.length) {
      const semanticSegments = analysis ? await enrichVideoSegments(visualSegments, analysis, signal) : visualSegments;
      segments = await addSegmentThumbnails(asset, semanticSegments, signal);
      asset.indexMode = analysis ? `WeMM 视频 · ${analysis.receipt.precisionActive ? "近秒级" : "兼容"}多路索引` : "WeMM 视频";
    } else {
      segments = await buildKeyframeSegments(asset, analysis, signal);
      asset.indexMode = analysis ? `关键帧 · ${analysis.receipt.precisionActive ? "近秒级" : "兼容"}多路索引` : "关键帧兼容";
    }
    const warnings = [...(analysis?.warnings || [])];
    if (mediaError) warnings.push(`媒体分析暂不可用：${mediaError.message}`);
    if (videoEndpointError) warnings.push("拯救者 WeMM 暂无完整视频接口，已自动使用镜头关键帧融合索引");
    if (!modelAvailable) warnings.push("8000 WeMM 当前不可用；已保留媒体分块结果，服务恢复后只补向量，不会重做语音与 OCR");
    if (isLongVideo && state.config.mediaEndpoint && !chunkedAnalysisAvailable()) warnings.push("8001 尚未支持长视频分块断点；已停止整条媒体分析，只建立可断点保存的视觉向量，升级后再补语音与 OCR");
    if (analysis && !analysis.receipt.precisionActive) warnings.push("拯救者媒体服务仍在使用旧版分析协议；已兼容写入，但动态抽帧与字幕轨无法确认生效");
    asset.transcript = analysis?.transcript || asset.transcript || [];
    asset.ocr = analysis?.ocr || asset.ocr || [];
    asset.subtitles = analysis?.subtitles || asset.subtitles || [];
    asset.analysisReceipt = analysis?.receipt || asset.analysisReceipt || null;
    asset.analysisWarnings = [...new Set(warnings)];
    asset.segments = segments?.length ? segments : asset.segments || [];
    asset.wemmVector = averageVectors(asset.segments.map((item) => item.visualWemmVector || item.wemmVector)) || asset.wemmVector;
    if (modelAvailable) asset.indexedSignature = segmentSignature();
    const hasVectorFailures = (asset.analysisChunks || []).some((chunk) => chunk.vectorStatus === "error");
    asset.analysisStage = mediaError || !modelAvailable || asset.mediaAnalysisStatus === "partial" || hasVectorFailures ? "partial" : "done"; asset.analysisProgress = modelAvailable ? 100 : 58;
  } else if (asset.type === "image") {
    if (!asset.imageRegions?.length) {
      const rebuilt = await processImage(asset.blob);
      asset.thumbnail = rebuilt.thumbnail; asset.visualVector = rebuilt.visualVector; asset.imageRegions = rebuilt.imageRegions; asset.width = rebuilt.width; asset.height = rebuilt.height;
    }
    const visualUnits = [{ label: "整图", thumbnail: asset.thumbnail }, ...asset.imageRegions.map((region) => ({ label: region.label, thumbnail: region.thumbnail }))];
    const vectors = await embedInBatches(await Promise.all(visualUnits.map(async (unit) => ({ kind: "image", mime: "image/webp", data: await blobToBase64(unit.thumbnail) }))), signal);
    asset.wemmVector = vectors[0]; asset.visualWemmVector = vectors[0];
    asset.imageRegions = asset.imageRegions.map((region, index) => ({ ...region, wemmVector: vectors[index + 1] || null }));
    asset.ocr = []; asset.ocrText = ""; asset.ocrVector = null; asset.imageAnalysisWarnings = [];
    if (state.config.mediaEndpoint && imageOcrAvailable()) {
      try {
        const payload = await requestImageAnalysis(asset, signal);
        asset.ocr = normalizeImageOcr(payload); asset.ocrText = [...new Set(asset.ocr.map((item) => item.text))].join(" ");
        if (asset.ocrText) [asset.ocrVector] = await embedInBatches([{ kind: "text", text: asset.ocrText.slice(0, 8000) }], signal);
        asset.tags = [...new Set([...(asset.tags || []), ...asset.ocr.slice(0, 4).map((item) => item.text).filter((text) => text.length <= 24)])];
        asset.imageOcrStatus = "ready"; asset.imageAnalysisRetryCount = 0; asset.imageAnalysisNextRetryAt = null;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        asset.imageOcrStatus = "error"; asset.imageAnalysisRetryCount = Number(asset.imageAnalysisRetryCount || 0) + 1; asset.imageAnalysisNextRetryAt = Date.now() + retryDelayForAttempt(asset.imageAnalysisRetryCount);
        asset.imageAnalysisWarnings.push(`图片 OCR 暂不可用：${error.message}`);
      }
    } else asset.imageOcrStatus = "disabled";
    asset.imageIndexedSignature = currentImageIndexSignature(); asset.segments = [];
    asset.indexMode = `WeMM 整图 + ${asset.imageRegions.length} 局部${asset.ocrText ? " + 图片OCR" : ""}`;
  } else {
    const chunks = chunkText(asset.content); const vectors = await embedInBatches(chunks.map((text) => ({ kind: "text", text })), signal);
    asset.segments = chunks.map((content, order) => ({ order, content, textVector: vectors[order], wemmVector: vectors[order] })); asset.wemmVector = averageVectors(vectors); asset.indexMode = "WeMM 文字";
  }
  const incompleteVideo = asset.type === "video" && (
    (Boolean(state.config.mediaEndpoint) && ["error", "partial"].includes(asset.mediaAnalysisStatus))
    || !modelAvailable
    || (asset.analysisChunks || []).some((chunk) => chunk.vectorStatus === "error")
  );
  const incompleteImage = asset.type === "image" && imageOcrAvailable() && asset.imageOcrStatus === "error";
  asset.indexStatus = incompleteVideo || incompleteImage ? "partial" : "ready";
  asset.indexError = incompleteVideo ? (!modelAvailable ? "媒体分块已保存，等待 8000 WeMM 恢复后补齐向量" : `部分分块未完成：${mediaError?.message || "可单独重试失败块"}`) : incompleteImage ? asset.imageAnalysisWarnings[0] : null;
  asset.updatedAt = Date.now(); await putAsset(asset); renderTaskCenter();
}
async function indexMissingWithWemm(force = false, options = {}) {
  const { automatic = false, includeFailed = false } = options;
  if (!state.config.endpoint || state.indexing || state.indexStarting) return;
  state.indexStarting = true;
  let pending = [];
  let modelAvailable = state.modelHealth === "online";
  try {
    try { await checkModelHealth(); modelAvailable = true; }
    catch (error) {
      modelAvailable = false;
      if (!automatic) toast(`WeMM 暂不可用，长视频媒体分析会继续，向量稍后补写：${error.message}`, "error");
    }
    if (state.config.mediaEndpoint && state.mediaHealth !== "online") {
      try { await checkMediaHealth(); }
      catch (error) { if (!automatic && !modelAvailable) toast(`媒体分析服务也不可用：${error.message}`, "error"); }
    }
    pending = queueCandidates({ force, includeFailed });
    if (!modelAvailable) pending = pending.filter(assetNeedsChunkMedia);
    if (!pending.length) {
      if (!modelAvailable && queueCandidates({ force, includeFailed }).length) scheduleIndexResume(15000);
      else scheduleDeferredMediaRetry();
      if (!automatic) toast(modelAvailable ? "语义索引已经是最新状态" : "媒体结果已保存，等待 WeMM 恢复后补向量");
      return;
    }
    if (state.config.mediaEndpoint) {
      const remoteTask = await refreshMediaTaskStatus(true);
      if (isRemoteTaskBusy(remoteTask)) {
        const tracked = pending.find((asset) => asset.mediaTaskId && (!remoteTask.taskId || String(asset.mediaTaskId) === String(remoteTask.taskId)));
        if (!tracked) {
          if (!automatic) { toast("已加入等待队列，当前任务完成后会自动继续", "normal"); elements.taskDialog.showModal(); }
          scheduleIndexResume(3000); return;
        }
        pending = [tracked, ...pending.filter((asset) => asset !== tracked)];
      }
    }
    state.indexing = true;
  } finally {
    state.indexStarting = false;
  }
  state.indexController = new AbortController(); elements.indexProgress.hidden = false; elements.cancelIndexButton.hidden = false; radarPulse(10000);
  let interrupted = false;
  try {
    for (let index = 0; index < pending.length; index += 1) {
      if (state.indexController.signal.aborted) throw new DOMException("任务已停止", "AbortError");
      const asset = pending[index]; const planned = asset.type === "video" ? planLocalSegments(asset.duration).length : null;
      elements.progressBar.style.width = `${Math.round(index / pending.length * 100)}%`;
      elements.progressText.textContent = asset.type === "video" ? `正在完整分析 ${asset.name}，预计 ${planned} 段` : `正在建立 ${asset.name} 的语义索引`;
      try { await indexOneAsset(asset, state.indexController.signal, { modelAvailable }); }
      catch (error) {
        if (error.name === "AbortError") throw error;
        const savedChunks = (asset.analysisChunks || []).some((chunk) => chunk.resultSaved || chunk.vectorStatus === "ready");
        asset.indexStatus = savedChunks ? "partial" : "error"; asset.indexError = error.message; asset.analysisStage = savedChunks ? "partial" : "failed"; await putAsset(asset); toast(`${asset.name}：${error.message}`, "error");
      }
      renderAll();
    }
    elements.progressBar.style.width = "100%"; elements.progressText.textContent = "语义索引已完成";
  } catch (error) {
    if (error.name === "AbortError") {
      interrupted = true;
      for (const asset of state.assets.filter((item) => item.indexStatus === "indexing")) { asset.indexStatus = "pending"; asset.analysisStage = "stopped"; await putAsset(asset); }
      elements.progressText.textContent = "任务已停止，未完成的素材仍保留在待处理列表"; toast("已停止语义索引");
    }
    else toast(error.message, "error");
  } finally {
    state.indexing = false; state.indexController = null; elements.cancelIndexButton.hidden = true; setTimeout(() => { elements.indexProgress.hidden = true; }, 1800); renderAll();
    if (!interrupted) {
      if (queueCandidates().length) scheduleIndexResume(modelAvailable ? 400 : 15000); else scheduleDeferredMediaRetry();
    }
  }
}
async function queueAssetForRetry(asset) {
  if (asset.analysisChunks?.length) return resumeAssetProcessing(asset);
  asset.indexStatus = "pending"; asset.indexError = null; asset.analysisStage = "queued";
  asset.analysisRetryCount = 0; asset.analysisNextRetryAt = null; asset.mediaAnalysisStatus = asset.type === "video" ? "pending" : asset.mediaAnalysisStatus;
  asset.imageAnalysisRetryCount = 0; asset.imageAnalysisNextRetryAt = null; asset.imageOcrStatus = asset.type === "image" ? "pending" : asset.imageOcrStatus;
  await putAsset(asset); renderAll(); renderTaskCenter(); scheduleIndexResume(0); toast(`${asset.name} 已加入分析队列`);
}
async function resumeAssetProcessing(asset) {
  asset.indexStatus = "pending"; asset.indexError = null; asset.analysisStage = "queued";
  asset.analysisNextRetryAt = null;
  await putAsset(asset); renderAll(); renderTaskCenter(); scheduleIndexResume(0); toast(`${asset.name} 将从已保存的分块继续`);
}
async function retryAnalysisChunk(asset, chunkIndex) {
  const chunk = asset.analysisChunks?.find((item) => Number(item.index) === Number(chunkIndex));
  if (!chunk) return toast("没有找到这个视频分块", "error");
  const retryKey = `${asset.id}:${chunk.index}`;
  if (retryingChunkKeys.has(retryKey) || asset.indexStatus === "indexing") return toast("这一块正在处理，请稍后再试", "error");
  retryingChunkKeys.add(retryKey); renderTaskCenter();
  try {
    if (chunkResultFetchExhausted(chunk)) {
      chunk.resultFetchStatus = "pending"; chunk.resultFetchAttempts = 0; chunk.resultFetchNextRetryAt = null; chunk.resultFetchError = null;
    } else if (chunk.resultSaved && chunk.vectorStatus === "error") {
      chunk.vectorStatus = "pending"; chunk.vectorError = null;
      if (chunk.error?.startsWith("向量写入失败")) chunk.error = null;
      chunk.components = { ...(chunk.components || {}), vector: { status: "pending", progress: 0, count: Number(chunk.vectorCount || 0) } };
    } else {
      if (!asset.mediaTaskId) throw new Error("原分块任务已经失效，请重新上传这个视频创建新任务");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try { await retryChunkedTask(asset, chunk, controller.signal); }
      finally { clearTimeout(timeout); }
    }
    asset.indexStatus = "pending"; asset.indexError = null; asset.analysisStage = "queued";
    asset.analysisRetryCount = 0; asset.analysisBlockedSignature = null; asset.analysisNextRetryAt = null;
    await putAsset(asset); renderAll(); renderTaskCenter(); scheduleIndexResume(0);
    toast(`${asset.name} 第 ${chunk.index + 1} 块已加入重试`);
  } catch (error) {
    chunk.error = error.name === "AbortError" ? "单块重试请求超时" : error.message;
    await putAsset(asset); renderTaskCenter(); toast(chunk.error, "error");
  } finally {
    retryingChunkKeys.delete(retryKey); renderTaskCenter();
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
  const backgroundActive = state.indexing;
  if (backgroundActive) elements.progressText.textContent = "后台入库正在让路，优先处理当前搜索";
  try { radarPulse(1700); const [vector] = await requestEmbedding([{ kind: "text", text: state.query }], state.config, undefined, "interactive"); state.queryVector = normalizeVector(vector); renderAssets(); }
  catch (error) { state.queryVector = null; toast(`语义搜索暂不可用：${error.message}`, "error"); renderAssets(); }
  finally { if (backgroundActive && state.indexing) elements.progressText.textContent = "搜索已完成，继续后台入库"; }
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
      if (type === "image" && media.imageRegions?.length) {
        const inputs = [input, ...await Promise.all(media.imageRegions.map(async (region) => ({ kind: "image", mime: "image/webp", data: await blobToBase64(region.thumbnail) })))];
        const vectors = await requestEmbedding(inputs, state.config, undefined, "interactive");
        state.reference.wemmVector = normalizeVector(vectors[0]); state.reference.imageRegionVectors = vectors.slice(1).map(normalizeVector);
      } else {
        const [vector] = await requestEmbedding([input]); state.reference.wemmVector = normalizeVector(vector);
      }
      renderAssets();
    }
  } catch (error) { toast(`参考文件读取失败：${error.message}`, "error"); }
}

function searchableVideoClips() {
  return state.assets.filter((asset) => asset.type === "video").flatMap((asset) => (asset.segments || []).map((segment) => ({ asset, segment, vector: segment.visualWemmVector || segment.wemmVector || asset.wemmVector })));
}
async function matchScript() {
  const lines = elements.scriptInput.value.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 10);
  if (!lines.length) return toast("请先输入脚本镜头", "error");
  if (!state.config.endpoint) return toast("脚本配镜需要先连接 WeMM", "error");
  const clips = searchableVideoClips().filter((clip) => clip.vector?.length);
  if (!clips.length) return toast("请先为视频补齐语义索引", "error");
  elements.matchScriptButton.disabled = true; elements.matchScriptButton.textContent = "正在匹配"; radarPulse(4000);
  try {
    const vectors = await embedInBatches(lines.map((text) => ({ kind: "text", text })), undefined, "interactive");
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
  const payload = state.assets.map(({ blob, thumbnail, moments, segments, imageRegions, visualVector, wemmVector, content, ...asset }) => ({ ...asset, textCharacters: content?.length || 0, wemmDimensions: wemmVector?.length || 0, imageRegions: (imageRegions || []).map(({ id, label, x, y, width, height, wemmVector: vector }) => ({ id, label, x, y, width, height, wemmDimensions: vector?.length || 0 })), segments: (segments || []).map(({ start, end, time, order, content: segmentText, speechText, ocrText, wemmVector: vector, visualWemmVector, speechVector, ocrVector }) => ({ start, end, time, order, excerpt: segmentText?.slice(0, 100), speechExcerpt: speechText?.slice(0, 100), ocrExcerpt: ocrText?.slice(0, 100), wemmDimensions: vector?.length || 0, visualDimensions: visualWemmVector?.length || 0, speechDimensions: speechVector?.length || 0, ocrDimensions: ocrVector?.length || 0 })) }));
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
elements.retryIndexButton.addEventListener("click", () => indexMissingWithWemm(false, { includeFailed: true }));
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
  if (action === "retry-index") return queueAssetForRetry(asset);
  if (action === "reindex-one") return queueAssetForRetry(asset);
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
  const analysisProfile = elements.analysisProfileInputs.find((input) => input.checked)?.value || "smart_precision";
  return {
    endpoint: elements.endpointInput.value.trim(), mediaEndpoint: elements.mediaEndpointInput.value.trim(), apiKey: elements.apiKeyInput.value.trim(),
    dimension: Number(elements.dimensionInput.value), segmentSeconds: Number(elements.segmentSecondsInput.value), overlapSeconds: Number(elements.overlapSecondsInput.value),
    analysisProfile: normalizeAnalysisProfile(analysisProfile)
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
    const capabilities = [health.scene && "切镜", health.asr && "语音", health.ocr && "OCR", (health.subtitles || health.capabilities?.subtitles) && "字幕轨", precisionProtocolAvailable(health) && "精细协议", chunkedAnalysisAvailable(health) && "长视频断点"].filter(Boolean).join(" · ");
    setServiceFeedback("media", "success", `连接成功${capabilities ? ` · ${capabilities}` : ""}`); return health;
  } catch (error) { setServiceFeedback("media", "error", error.message); throw error; }
  finally { setTesting(elements.testMediaConnectionButton, false, "测试媒体服务"); }
}
function openSettingsDialog() {
  elements.endpointInput.value = state.config.endpoint; elements.mediaEndpointInput.value = state.config.mediaEndpoint || deriveMediaEndpoint(state.config.endpoint); elements.apiKeyInput.value = state.config.apiKey;
  elements.dimensionInput.value = state.config.dimension; elements.segmentSecondsInput.value = state.config.segmentSeconds; elements.segmentSecondsValue.textContent = `${state.config.segmentSeconds} 秒`; elements.overlapSecondsInput.value = state.config.overlapSeconds;
  elements.analysisProfileInputs.forEach((input) => { input.checked = input.value === normalizeAnalysisProfile(state.config.analysisProfile); });
  updateAnalysisProfileHint();
  setServiceFeedback("wemm", state.modelHealth === "online" ? "success" : "", state.modelHealth === "online" ? "当前 WeMM 连接正常" : "尚未确认 WeMM 连接");
  setServiceFeedback("media", state.mediaHealth === "online" ? "success" : "", state.mediaHealth === "online" ? "当前媒体分析连接正常" : "尚未确认媒体服务连接");
  elements.settingsDialog.showModal();
}
function updateAnalysisProfileHint() {
  const profile = normalizeAnalysisProfile(elements.analysisProfileInputs.find((input) => input.checked)?.value);
  elements.analysisProfileHint.textContent = profile === "smart_precision" ? "智能精细会根据画面变化自动增加或减少采样，不会机械地逐帧识别。" : "快速分析减少抽帧与 OCR 次数，导入更快，但动作和短暂字幕的定位会更粗。";
}
elements.settingsButton.addEventListener("click", openSettingsDialog);
elements.modelStatus.addEventListener("click", openSettingsDialog);
elements.taskCenterButton.addEventListener("click", () => { renderTaskCenter(); elements.taskDialog.showModal(); refreshMediaTaskStatus(true); });
elements.closeTaskDialogButton.addEventListener("click", () => elements.taskDialog.close());
elements.refreshTaskStatusButton.addEventListener("click", async () => { await refreshMediaTaskStatus(false); if (queueCandidates().length) scheduleIndexResume(0); });
elements.localTaskList.addEventListener("toggle", (event) => {
  const details = event.target.closest?.("[data-chunk-details-asset]");
  if (details) taskDetailOpenState.set(details.dataset.chunkDetailsAsset, details.open);
}, true);
elements.localTaskList.addEventListener("click", (event) => {
  const chunkButton = event.target.closest("[data-retry-chunk-asset]");
  if (chunkButton) {
    const asset = state.assets.find((item) => item.id === chunkButton.dataset.retryChunkAsset);
    if (asset) retryAnalysisChunk(asset, Number(chunkButton.dataset.retryChunkIndex));
    return;
  }
  const resumeButton = event.target.closest("[data-resume-asset]");
  if (resumeButton) {
    const asset = state.assets.find((item) => item.id === resumeButton.dataset.resumeAsset);
    if (asset) resumeAssetProcessing(asset);
    return;
  }
  const button = event.target.closest("[data-retry-asset]"); if (!button) return;
  const asset = state.assets.find((item) => item.id === button.dataset.retryAsset); if (asset) queueAssetForRetry(asset);
});
elements.segmentSecondsInput.addEventListener("input", () => { elements.segmentSecondsValue.textContent = `${elements.segmentSecondsInput.value} 秒`; });
elements.analysisProfileInputs.forEach((input) => input.addEventListener("change", updateAnalysisProfileHint));
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
  else {
    toast(`设置已保存，但 WeMM 当前不可用：${checks[0].reason.message}`, "error");
    if (checks[1]?.status === "fulfilled" && chunkedAnalysisAvailable()) {
      toast("长视频媒体分析仍会继续，WeMM 恢复后只补向量");
      indexMissingWithWemm();
    }
  }
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
  try {
    state.assets = (await getAllAssets()).map((asset) => ({ ...asset, segments: asset.segments || [], imageRegions: asset.imageRegions || [], transcript: asset.transcript || [], ocr: asset.ocr || [], ocrText: asset.ocrText || "", subtitles: asset.subtitles || [], analysisReceipt: asset.analysisReceipt || null, analysisWarnings: asset.analysisWarnings || [], imageAnalysisWarnings: asset.imageAnalysisWarnings || [], tags: asset.tags || [], content: asset.content || "", indexStatus: asset.indexStatus || (asset.wemmVector ? "ready" : "pending") })).sort((a, b) => b.createdAt - a.createdAt);
    const recoveredAssets = state.assets.filter((asset) => (asset.analysisChunks || []).some(recoverChunkResultParserFailure));
    for (const asset of recoveredAssets) {
      asset.indexStatus = "pending"; asset.indexError = null; asset.analysisStage = "queued";
      asset.analysisRetryCount = 0; asset.analysisNextRetryAt = null; asset.analysisBlockedSignature = null;
      await putAsset(asset);
    }
  }
  catch (error) { toast(`本地素材库打开失败：${error.message}`, "error"); }
  renderAll(); radar.setBlips(filteredAssets()); updateStorageStatus();
  if (state.config.endpoint) {
    Promise.allSettled([checkModelHealth(), state.config.mediaEndpoint ? checkMediaHealth() : Promise.resolve(null)]).then(async (results) => {
      if (state.config.mediaEndpoint) await refreshMediaTaskStatus(true);
      if (results[0].status === "fulfilled" || (results[1]?.status === "fulfilled" && chunkedAnalysisAvailable())) scheduleIndexResume(0);
    });
  } else renderTaskCenter();
}
initialize();
