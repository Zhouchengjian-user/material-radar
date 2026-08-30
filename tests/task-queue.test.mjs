import assert from "node:assert/strict";
import test from "node:test";
import { assetNeedsIndex, earliestRetryDelay, isRemoteTaskBusy, retryDelayForAttempt } from "../public/task-queue.js";

test("recognizes a busy remote media task", () => {
  assert.equal(isRemoteTaskBusy({ status: "running" }), true);
  assert.equal(isRemoteTaskBusy({ status: "queued" }), true);
  assert.equal(isRemoteTaskBusy({ status: "idle" }), false);
});

test("automatically resumes pending and incomplete video work", () => {
  const options = { mediaEnabled: true, signature: "v2", now: 10000 };
  assert.equal(assetNeedsIndex({ type: "video", indexStatus: "pending" }, options), true);
  assert.equal(assetNeedsIndex({ type: "video", indexStatus: "ready", indexedSignature: "v1" }, options), true);
  assert.equal(assetNeedsIndex({ type: "video", indexStatus: "ready", indexedSignature: "v2", mediaAnalysisStatus: "disabled" }, options), true);
  assert.equal(assetNeedsIndex({ type: "video", indexStatus: "ready", indexedSignature: "v2", mediaAnalysisStatus: "error", analysisRetryCount: 1, analysisNextRetryAt: 9000 }, options), true);
  assert.equal(assetNeedsIndex({ type: "video", indexStatus: "partial", indexedSignature: "v2", analysisRetryCount: 1, analysisNextRetryAt: 11000 }, options), false);
});

test("automatically upgrades old image indexes and retries failed image OCR", () => {
  const options = { mediaEnabled: true, imageSignature: "image-v2:ocr", now: 10000 };
  assert.equal(assetNeedsIndex({ type: "image", indexStatus: "ready", imageIndexedSignature: "image-v1" }, options), true);
  assert.equal(assetNeedsIndex({ type: "image", indexStatus: "ready", imageIndexedSignature: "image-v2:ocr", imageOcrStatus: "ready" }, options), false);
  assert.equal(assetNeedsIndex({ type: "image", indexStatus: "partial", imageIndexedSignature: "image-v2:ocr", imageOcrStatus: "error", imageAnalysisRetryCount: 1, imageAnalysisNextRetryAt: 9000 }, options), true);
});

test("caps automatic media retries but permits an explicit retry", () => {
  const asset = { type: "video", indexStatus: "partial", indexedSignature: "v2", analysisRetryCount: 3, analysisNextRetryAt: 0 };
  assert.equal(assetNeedsIndex(asset, { mediaEnabled: true, signature: "v2", now: 10000 }), false);
  assert.equal(assetNeedsIndex(asset, { force: true, mediaEnabled: true, signature: "v2", now: 10000 }), true);
});

test("blocks a failed chunk signature without preventing a later protocol upgrade", () => {
  const asset = {
    type: "video",
    indexStatus: "partial",
    indexedSignature: null,
    mediaAnalysisStatus: "partial",
    analysisRetryCount: 3,
    analysisBlockedSignature: "media-v5"
  };
  assert.equal(assetNeedsIndex(asset, { mediaEnabled: true, signature: "media-v5", now: 10000 }), false);
  assert.equal(assetNeedsIndex(asset, { mediaEnabled: true, signature: "media-v6", now: 10000 }), true);
  assert.equal(assetNeedsIndex({ ...asset, indexStatus: "pending" }, { mediaEnabled: true, signature: "media-v5", now: 10000 }), true);
});

test("uses bounded exponential retry delays", () => {
  assert.equal(retryDelayForAttempt(1), 2500);
  assert.equal(retryDelayForAttempt(2), 5000);
  assert.equal(retryDelayForAttempt(9), 60000);
  assert.equal(earliestRetryDelay([
    { type: "video", indexStatus: "partial", analysisRetryCount: 1, analysisNextRetryAt: 14000 },
    { type: "video", indexStatus: "partial", analysisRetryCount: 2, analysisNextRetryAt: 12000 }
  ], { mediaEnabled: true, now: 10000 }), 2000);
});
