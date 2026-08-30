import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_PROTOCOL, analysisRequestFields, normalizeAnalysisReceipt, normalizeAnalysisProfile } from "../public/media-analysis.js";

test("defaults video analysis to the smart precision contract", () => {
  assert.equal(normalizeAnalysisProfile("unknown"), "smart_precision");
  assert.deepEqual(analysisRequestFields("smart_precision"), {
    analysis_protocol: ANALYSIS_PROTOCOL,
    analysis_profile: "smart_precision",
    target_unit_seconds: "2",
    ocr_fps: "2",
    visual_samples_per_scene: "3",
    dynamic_sampling: "true",
    extract_subtitle_tracks: "true"
  });
});

test("builds an auditable receipt from precision media results", () => {
  const receipt = normalizeAnalysisReceipt({
    analysis_protocol: ANALYSIS_PROTOCOL,
    analysis_profile: "smart_precision",
    sampled_frames: 48,
    capabilities: { asr: true, ocr: true, subtitles: true, dynamic_sampling: true }
  }, {
    scenes: [{ start: 0, end: 2 }],
    transcript: [{ text: "台词" }],
    ocr: [],
    subtitles: [{ text: "字幕" }]
  });
  assert.equal(receipt.precisionActive, true);
  assert.equal(receipt.sampledFrames, 48);
  assert.equal(receipt.components.speech.status, "ready");
  assert.equal(receipt.components.ocr.status, "empty");
  assert.equal(receipt.components.subtitles.count, 1);
});

test("marks old media services as legacy instead of pretending precision is active", () => {
  const receipt = normalizeAnalysisReceipt({}, { scenes: [{ start: 0, end: 6 }], transcript: [], ocr: [], subtitles: [] });
  assert.equal(receipt.protocol, "legacy");
  assert.equal(receipt.precisionActive, false);
});
