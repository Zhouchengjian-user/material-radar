export const LONG_VIDEO_THRESHOLD_SECONDS = 6 * 60;
export const DEFAULT_ANALYSIS_CHUNK_SECONDS = 150;
export const CHUNK_RESULT_PARSER_VERSION = 2;

const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const COLLECTION_KEYS = ["items", "cues", "segments", "results", "data", "entries", "records", "list", "values", "lines", "tracks"];
const ITEM_FIELDS = ["start", "end", "time", "timestamp", "start_time", "end_time", "keyframe", "keyframe_time", "text", "content", "bbox", "box"];

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
const looksLikeItem = (value) => isRecord(value) && ITEM_FIELDS.some((key) => hasOwn(value, key));

// The media service has had several response shapes over time. Turn arrays,
// wrapper objects ({ items: [...] }) and keyed objects ({ zh: [...] }) into one
// predictable list without mistaking a component status object for content.
export function asPayloadItems(value, nestedKeys = []) {
  if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined);
  if (value === null || value === undefined || value === "") return [];
  // A scalar at the root is normally a status such as "ready", not media
  // content. Strings inside an actual array are still retained by the branch
  // above for backward compatibility.
  if (!isRecord(value)) return [];
  if (looksLikeItem(value)) return [value];

  const keys = [...new Set([...nestedKeys, ...COLLECTION_KEYS])];
  for (const key of keys) {
    if (!hasOwn(value, key)) continue;
    const items = asPayloadItems(value[key], nestedKeys);
    if (items.length) return items;
  }

  const structuredValues = Object.values(value).filter((item) => Array.isArray(item) || isRecord(item));
  if (structuredValues.length) {
    return structuredValues.flatMap((item) => asPayloadItems(item, nestedKeys));
  }
  return [];
}

export function payloadItemsFor(payload = {}, keys = []) {
  for (const key of keys) {
    const items = asPayloadItems(payload?.[key], keys);
    if (items.length) return items;
  }
  return [];
}

export function subtitleTracksFromPayload(payload = {}) {
  const value = payload.subtitle_tracks
    ?? payload.subtitleTracks
    ?? payload.subtitles?.tracks
    ?? payload.subtitles?.subtitle_tracks;
  if (value === null || value === undefined) return [];
  const isTrack = (item) => isRecord(item) && (
    hasOwn(item, "cues")
    || hasOwn(item, "subtitle_cues")
    || hasOwn(item, "subtitles")
    || (hasOwn(item, "items") && ["language", "lang", "title", "id", "index"].some((key) => hasOwn(item, key)))
  );
  const roots = isTrack(value) ? [value] : asPayloadItems(value, ["tracks", "subtitle_tracks"]);
  return roots.map((root) => {
    if (looksLikeItem(root)) return { cues: [root] };
    if (!isRecord(root)) return { cues: asPayloadItems(root) };
    const cues = payloadItemsFor(root, ["cues", "subtitle_cues", "subtitles", "items", "segments", "lines"]);
    return { ...root, cues };
  }).filter((track) => track.cues.length);
}

export function recoverChunkResultParserFailure(chunk = {}) {
  const error = `${chunk.resultFetchError || ""} ${chunk.error || ""}`;
  const isOldParserFailure = Number(chunk.resultParserVersion || 0) < CHUNK_RESULT_PARSER_VERSION
    && !chunk.resultSaved
    && /\.map is not a function/i.test(error);
  if (!isOldParserFailure) return false;
  chunk.resultParserVersion = CHUNK_RESULT_PARSER_VERSION;
  chunk.resultFetchStatus = "pending";
  chunk.resultFetchAttempts = 0;
  chunk.resultFetchNextRetryAt = null;
  chunk.resultFetchError = null;
  chunk.error = null;
  if (["error", "failed"].includes(chunk.status)) {
    chunk.status = "pending";
    chunk.stage = "result";
    chunk.attempts = 0;
  }
  return true;
}

export function planAnalysisChunks(duration, chunkSeconds = DEFAULT_ANALYSIS_CHUNK_SECONDS) {
  const safeDuration = Math.max(0, numeric(duration));
  const size = Math.min(180, Math.max(120, numeric(chunkSeconds, DEFAULT_ANALYSIS_CHUNK_SECONDS)));
  if (!safeDuration) return [];
  const chunks = [];
  for (let start = 0, index = 0; start < safeDuration; start += size, index += 1) {
    chunks.push({
      index,
      start,
      end: Math.min(safeDuration, start + size),
      status: "pending",
      stage: "queued",
      progress: 0,
      sceneCount: 0,
      transcriptCount: 0,
      ocrCount: 0,
      vectorCount: 0,
      resultSaved: false,
      vectorStatus: "pending",
      attempts: 0,
      error: null,
      components: {
        scene: { status: "pending", progress: 0, count: 0 },
        speech: { status: "pending", progress: 0, count: 0 },
        ocr: { status: "pending", progress: 0, count: 0 },
        vector: { status: "pending", progress: 0, count: 0 }
      }
    });
  }
  return chunks;
}

function mergeComponent(previous = {}, current = {}, fallbackCount = 0) {
  const saved = previous.status === "ready" || previous.status === "complete";
  const currentStatus = String(current.status || "").toLowerCase();
  const status = saved ? "ready" : currentStatus || previous.status || "pending";
  const progress = saved
    ? 100
    : Math.max(numeric(previous.progress), numeric(current.progress ?? current.percent));
  return {
    ...previous,
    ...current,
    status,
    progress,
    count: numeric(current.count, numeric(previous.count, fallbackCount))
  };
}

export function mergeChunkState(planned, remote = [], saved = []) {
  const plannedByIndex = new Map(planned.map((item) => [numeric(item.index, -1), item]));
  const remoteByIndex = new Map(remote.map((item) => [numeric(item.index ?? item.chunk_index, -1), item]));
  const savedByIndex = new Map(saved.map((item) => [numeric(item.index, -1), item]));
  const indexes = [...new Set([...plannedByIndex.keys(), ...remoteByIndex.keys(), ...savedByIndex.keys()])]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b);
  return indexes.map((index) => {
    const item = plannedByIndex.get(index) || savedByIndex.get(index) || remoteByIndex.get(index);
    const previous = savedByIndex.get(index) || {};
    const current = remoteByIndex.get(index) || {};
    const resultSaved = Boolean(previous.resultSaved);
    const remoteStatus = String(current.status || "").toLowerCase();
    const status = resultSaved
      ? "ready"
      : remoteStatus || previous.status || item.status;
    const sceneCount = Math.max(numeric(current.scene_count ?? current.sceneCount), numeric(previous.sceneCount));
    const transcriptCount = Math.max(numeric(current.transcript_count ?? current.transcriptCount), numeric(previous.transcriptCount));
    const ocrCount = Math.max(numeric(current.ocr_count ?? current.ocrCount), numeric(previous.ocrCount));
    const previousComponents = previous.components || {};
    const remoteComponents = current.components || {};
    const vectorStatus = previous.vectorStatus || item.vectorStatus;
    return {
      ...item,
      ...previous,
      index,
      status,
      stage: resultSaved ? (previous.stage || "media-saved") : current.stage || previous.stage || item.stage,
      progress: resultSaved ? 100 : Math.max(numeric(current.progress), numeric(previous.progress, item.progress)),
      sceneCount,
      transcriptCount,
      ocrCount,
      resultSaved,
      vectorStatus,
      error: resultSaved ? (previous.vectorError || null) : current.error || current.message || previous.error || null,
      attempts: Math.max(numeric(current.attempts), numeric(previous.attempts)),
      components: {
        scene: mergeComponent(previousComponents.scene, remoteComponents.scene, sceneCount),
        speech: mergeComponent(previousComponents.speech || previousComponents.asr, remoteComponents.speech || remoteComponents.asr, transcriptCount),
        ocr: mergeComponent(previousComponents.ocr, remoteComponents.ocr, ocrCount),
        vector: mergeComponent(previousComponents.vector, {
          status: vectorStatus,
          progress: vectorStatus === "ready" ? 100 : previousComponents.vector?.progress,
          count: previous.vectorCount
        }, numeric(previous.vectorCount))
      }
    };
  });
}

function offsetItem(item, chunk, fields) {
  const output = isRecord(item) ? { ...item } : { text: String(item ?? "") };
  fields.forEach((field) => { if (Number.isFinite(Number(output[field]))) output[field] = Number(output[field]) + chunk.start; });
  return output;
}

export function normalizeChunkResult(payload = {}, chunk = {}) {
  const relative = payload.timebase !== "global" && numeric(chunk.start) > 0;
  const analysisChunkIndex = numeric(chunk.index, 0);
  const adjust = (item, fields) => ({
    ...(relative ? offsetItem(item, chunk, fields) : (isRecord(item) ? { ...item } : { text: String(item ?? "") })),
    analysisChunkIndex
  });
  const scenes = payloadItemsFor(payload, ["search_units", "retrieval_units", "scenes", "shots"]).map((item) => adjust(item, ["start", "end", "time", "keyframe", "start_time", "end_time", "keyframe_time"]));
  const transcript = payloadItemsFor(payload, ["transcript", "asr", "speech"]).map((item) => adjust(item, ["start", "end", "time", "start_time", "end_time"]));
  const ocr = payloadItemsFor(payload, ["ocr", "texts"]).map((item) => adjust(item, ["time", "timestamp", "start", "end", "start_time", "end_time"]));
  const subtitles = payloadItemsFor(payload, ["subtitles", "subtitle_cues"]).map((item) => adjust(item, ["start", "end", "time", "start_time", "end_time"]));
  const subtitleTracks = subtitleTracksFromPayload(payload).map((track) => ({
    ...track,
    cues: track.cues.map((item) => adjust(item, ["start", "end", "time", "start_time", "end_time"]))
  }));
  return { ...payload, timebase: "global", scenes, search_units: scenes, retrieval_units: scenes, transcript, ocr, subtitles, subtitle_tracks: subtitleTracks };
}

export function summarizeChunkProgress(chunks = []) {
  const ready = chunks.filter((item) => item.resultSaved).length;
  const failed = chunks.filter((item) => !item.resultSaved && (item.status === "error" || item.status === "failed")).length;
  const vectorsReady = chunks.filter((item) => item.vectorStatus === "ready").length;
  const mediaPercent = chunks.length ? Math.round(chunks.reduce((sum, item) => {
    if (item.resultSaved) return sum + 100;
    return sum + Math.max(0, Math.min(100, numeric(item.progress)));
  }, 0) / chunks.length) : 0;
  const vectorPercent = chunks.length ? Math.round(chunks.reduce((sum, item) => {
    if (item.vectorStatus === "ready") return sum + 100;
    return sum + Math.max(0, Math.min(100, numeric(item.components?.vector?.progress)));
  }, 0) / chunks.length) : 0;
  return {
    total: chunks.length,
    ready,
    failed,
    vectorsReady,
    running: chunks.filter((item) => ["queued", "running", "processing", "analyzing"].includes(item.status)).length,
    sceneCount: chunks.reduce((sum, item) => sum + numeric(item.sceneCount), 0),
    transcriptCount: chunks.reduce((sum, item) => sum + numeric(item.transcriptCount), 0),
    ocrCount: chunks.reduce((sum, item) => sum + numeric(item.ocrCount), 0),
    vectorCount: chunks.reduce((sum, item) => sum + numeric(item.vectorCount), 0),
    mediaPercent,
    vectorPercent,
    percent: mediaPercent
  };
}
