export const ANALYSIS_PROTOCOL = "radar-precision-v1";

export const ANALYSIS_PROFILES = Object.freeze({
  smart_precision: Object.freeze({
    label: "智能精细",
    targetSeconds: 2,
    ocrFps: 2,
    visualSamplesPerScene: 3,
    dynamicSampling: true,
    extractSubtitleTracks: true
  }),
  fast: Object.freeze({
    label: "快速分析",
    targetSeconds: 6,
    ocrFps: 0.35,
    visualSamplesPerScene: 1,
    dynamicSampling: false,
    extractSubtitleTracks: true
  })
});

export function normalizeAnalysisProfile(value) {
  return Object.hasOwn(ANALYSIS_PROFILES, value) ? value : "smart_precision";
}

export function analysisRequestFields(value) {
  const profile = normalizeAnalysisProfile(value);
  const settings = ANALYSIS_PROFILES[profile];
  return {
    analysis_protocol: ANALYSIS_PROTOCOL,
    analysis_profile: profile,
    target_unit_seconds: String(settings.targetSeconds),
    ocr_fps: String(settings.ocrFps),
    visual_samples_per_scene: String(settings.visualSamplesPerScene),
    dynamic_sampling: String(settings.dynamicSampling),
    extract_subtitle_tracks: String(settings.extractSubtitleTracks)
  };
}

function countFrom(payload, keys, fallback = 0) {
  for (const key of keys) {
    const value = Number(payload?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function componentStatus(value, count, supported = true) {
  const raw = String(value || "").toLowerCase();
  if (["failed", "error"].includes(raw)) return "failed";
  if (["unsupported", "unavailable"].includes(raw) || !supported) return "unsupported";
  if (["skipped", "disabled"].includes(raw)) return "skipped";
  return count > 0 ? "ready" : "empty";
}

export function normalizeAnalysisReceipt(payload = {}, normalized = {}, requestedProfile = "smart_precision") {
  const raw = payload.analysis_receipt || payload.receipt || {};
  const components = raw.components || payload.components || {};
  const capabilities = payload.capabilities || {};
  const profile = normalizeAnalysisProfile(payload.analysis_profile || raw.profile || requestedProfile);
  const sceneCount = normalized.scenes?.length || countFrom(payload, ["search_unit_count", "scene_count"]);
  const speechCount = normalized.transcript?.length || countFrom(payload, ["transcript_count", "asr_count"]);
  const ocrCount = normalized.ocr?.length || countFrom(payload, ["ocr_count"]);
  const subtitleCount = normalized.subtitles?.length || countFrom(payload, ["subtitle_count"]);
  const protocol = String(payload.analysis_protocol || raw.protocol || "legacy");
  const precisionActive = protocol === ANALYSIS_PROTOCOL || Boolean(capabilities.dynamic_sampling || raw.dynamic_sampling);
  const verifiedStatus = (value, count, supported) => !precisionActive && !value && count === 0 ? "unknown" : componentStatus(value, count, supported);

  return {
    protocol,
    profile,
    precisionActive,
    sampledFrames: countFrom(raw, ["sampled_frames"], countFrom(payload, ["sampled_frames", "frame_count"])),
    elapsedMs: countFrom(raw, ["elapsed_ms", "duration_ms"], countFrom(payload, ["analysis_ms"])),
    components: {
      scene: { status: verifiedStatus(components.scene?.status, sceneCount, true), count: sceneCount, engine: components.scene?.engine || "PySceneDetect" },
      speech: { status: verifiedStatus(components.speech?.status || components.asr?.status, speechCount, capabilities.asr !== false), count: speechCount, engine: components.speech?.engine || components.asr?.engine || "SenseVoice" },
      ocr: { status: verifiedStatus(components.ocr?.status, ocrCount, capabilities.ocr !== false), count: ocrCount, engine: components.ocr?.engine || "PaddleOCR" },
      subtitles: { status: verifiedStatus(components.subtitles?.status, subtitleCount, capabilities.subtitles !== false), count: subtitleCount, engine: components.subtitles?.engine || "FFmpeg 字幕轨" }
    }
  };
}

export function receiptStatusLabel(status) {
  return ({ ready: "已写入", empty: "已检查，无内容", failed: "失败", unsupported: "服务未支持", skipped: "已跳过", unknown: "旧服务未回执" })[status] || "待确认";
}
