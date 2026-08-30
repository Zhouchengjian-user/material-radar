export const MEDIA_AUTO_RETRY_LIMIT = 3;

export function isRemoteTaskBusy(task = {}) {
  return ["running", "queued"].includes(task.status);
}

export function assetNeedsIndex(asset, options = {}) {
  const {
    force = false,
    includeFailed = false,
    mediaEnabled = false,
    signature = null,
    imageSignature = null,
    now = Date.now()
  } = options;
  if (force) return true;

  const status = asset.indexStatus || "pending";
  if (status === "pending" || status === "indexing") return true;
  if (status === "error") return includeFailed;

  if (asset.type === "image") {
    if (imageSignature && asset.imageIndexedSignature !== imageSignature) return true;
    const incompleteOcr = mediaEnabled && imageSignature?.endsWith(":ocr") && asset.imageOcrStatus === "error";
    if (incompleteOcr) {
      const attempts = Number(asset.imageAnalysisRetryCount || 0);
      const retryAt = Number(asset.imageAnalysisNextRetryAt || 0);
      return attempts < MEDIA_AUTO_RETRY_LIMIT && retryAt <= now;
    }
    return status !== "ready";
  }
  if (asset.type !== "video") return status !== "ready";
  const attempts = Number(asset.analysisRetryCount || 0);
  const blockedForCurrentSignature = attempts >= MEDIA_AUTO_RETRY_LIMIT && Boolean(signature) && asset.analysisBlockedSignature === signature;
  if (signature && asset.indexedSignature !== signature && !blockedForCurrentSignature) return true;

  const incompleteMedia = status === "partial" || (mediaEnabled && asset.mediaAnalysisStatus !== "ready");
  if (!incompleteMedia) return status !== "ready";
  if (!mediaEnabled) return false;

  const retryAt = Number(asset.analysisNextRetryAt || 0);
  return attempts < MEDIA_AUTO_RETRY_LIMIT && retryAt <= now;
}

export function retryDelayForAttempt(attempt = 1) {
  return Math.min(60000, 2500 * (2 ** Math.max(0, Number(attempt) - 1)));
}

export function earliestRetryDelay(assets, options = {}) {
  const { mediaEnabled = false, now = Date.now() } = options;
  if (!mediaEnabled) return null;
  const waits = assets
    .filter((asset) => asset.type === "video" || asset.type === "image")
    .filter((asset) => asset.type === "video" ? (asset.indexStatus === "partial" || asset.mediaAnalysisStatus !== "ready") : asset.imageOcrStatus === "error")
    .filter((asset) => Number(asset.type === "video" ? asset.analysisRetryCount : asset.imageAnalysisRetryCount || 0) < MEDIA_AUTO_RETRY_LIMIT)
    .map((asset) => Math.max(0, Number(asset.type === "video" ? asset.analysisNextRetryAt : asset.imageAnalysisNextRetryAt || 0) - now));
  return waits.length ? Math.min(...waits) : null;
}
