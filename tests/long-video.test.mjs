import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_RESULT_PARSER_VERSION,
  mergeChunkState,
  normalizeChunkResult,
  planAnalysisChunks,
  recoverChunkResultParserFailure,
  summarizeChunkProgress
} from "../public/long-video.js";

test("plans a 601-second video as five checkpointed chunks within the 120-180 second range", () => {
  const chunks = planAnalysisChunks(601, 150);

  assert.equal(chunks.length, 5);
  assert.deepEqual(chunks.map(({ index, start, end }) => ({ index, start, end })), [
    { index: 0, start: 0, end: 150 },
    { index: 1, start: 150, end: 300 },
    { index: 2, start: 300, end: 450 },
    { index: 3, start: 450, end: 600 },
    { index: 4, start: 600, end: 601 }
  ]);
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.end - chunk.start >= 120));
  assert.ok(chunks.every((chunk) => chunk.end - chunk.start <= 180));

  assert.equal(planAnalysisChunks(601, 30)[0].end, 120, "too-small chunk sizes are clamped to 120 seconds");
  assert.equal(planAnalysisChunks(601, 999)[0].end, 180, "too-large chunk sizes are clamped to 180 seconds");
});

test("mergeChunkState never rolls a saved result or ready vector checkpoint backward", () => {
  const planned = planAnalysisChunks(300, 150);
  const saved = [{
    ...planned[0],
    status: "ready",
    stage: "saved",
    progress: 100,
    resultSaved: true,
    vectorStatus: "ready",
    vectorCount: 23,
    sceneCount: 9,
    attempts: 2
  }];
  const remote = [{
    chunk_index: 0,
    status: "pending",
    stage: "queued",
    progress: 0,
    scene_count: 0,
    attempts: 1
  }];

  const [merged] = mergeChunkState(planned, remote, saved);

  assert.equal(merged.status, "ready");
  assert.equal(merged.stage, "saved");
  assert.equal(merged.progress, 100);
  assert.equal(merged.resultSaved, true);
  assert.equal(merged.vectorStatus, "ready");
  assert.equal(merged.vectorCount, 23);
  assert.equal(merged.sceneCount, 9);
  assert.equal(merged.attempts, 2);
});

test("normalizeChunkResult offsets relative timestamps and marks every normalized item with its chunk index", () => {
  const chunk = { index: 2, start: 300, end: 450 };
  const normalized = normalizeChunkResult({
    timebase: "relative",
    scenes: [{ start: 1, end: 4, keyframe_time: 2 }],
    transcript: [{ start_time: 4, end_time: 6, text: "语音" }],
    ocr: [{ time: 7, text: "字幕" }],
    subtitles: [{ start: 8, end: 9, text: "内嵌字幕" }],
    subtitle_tracks: [{ language: "zh", cues: [{ start: 10, end: 11, text: "字幕轨" }] }]
  }, chunk);

  assert.equal(normalized.timebase, "global");
  assert.deepEqual(
    [normalized.scenes[0].start, normalized.scenes[0].end, normalized.scenes[0].keyframe_time],
    [301, 304, 302]
  );
  assert.deepEqual(
    [normalized.transcript[0].start_time, normalized.transcript[0].end_time, normalized.ocr[0].time],
    [304, 306, 307]
  );
  assert.deepEqual(
    [normalized.subtitles[0].start, normalized.subtitles[0].end],
    [308, 309]
  );
  assert.deepEqual(
    [normalized.subtitle_tracks[0].cues[0].start, normalized.subtitle_tracks[0].cues[0].end, normalized.subtitle_tracks[0].cues[0].analysisChunkIndex],
    [310, 311, 2]
  );

  const normalizedItems = [
    ...normalized.scenes,
    ...normalized.transcript,
    ...normalized.ocr,
    ...normalized.subtitles
  ];
  assert.ok(normalizedItems.every((item) => item.analysisChunkIndex === 2));
});

test("normalizeChunkResult accepts object-wrapped subtitle collections without dropping other media results", () => {
  const chunk = { index: 1, start: 150, end: 300 };
  const normalized = normalizeChunkResult({
    timebase: "relative",
    scenes: [{ start: 1, end: 3 }],
    transcript: [{ start: 4, end: 5, text: "语音结果" }],
    ocr: [{ time: 6, text: "画面文字" }],
    subtitles: {
      items: [{ start: 7, end: 8, text: "对象包装字幕" }],
      count: 1
    },
    subtitle_tracks: {
      items: [{
        language: "zh",
        cues: {
          items: [{ start: 9, end: 10, text: "对象包装字幕轨" }]
        }
      }]
    }
  }, chunk);

  assert.deepEqual(
    [normalized.scenes[0].start, normalized.transcript[0].start, normalized.ocr[0].time],
    [151, 154, 156],
    "an unexpected subtitle response shape must not discard successfully analyzed scenes, speech, or OCR"
  );
  assert.deepEqual(
    [normalized.subtitles[0].start, normalized.subtitles[0].end, normalized.subtitles[0].analysisChunkIndex],
    [157, 158, 1]
  );
  assert.deepEqual(
    [normalized.subtitle_tracks[0].cues[0].start, normalized.subtitle_tracks[0].cues[0].end, normalized.subtitle_tracks[0].cues[0].analysisChunkIndex],
    [159, 160, 1]
  );
});

test("normalizeChunkResult accepts subtitle_cues object wrappers as the direct subtitle fallback", () => {
  const normalized = normalizeChunkResult({
    timebase: "relative",
    subtitle_cues: {
      cues: [{ start_time: 2, end_time: 4, text: "备用字幕字段" }]
    },
    subtitle_tracks: [{
      language: "en",
      items: [{ start: 5, end: 6, text: "数组字幕轨" }]
    }]
  }, { index: 3, start: 450, end: 600 });

  assert.deepEqual(
    [normalized.subtitles[0].start_time, normalized.subtitles[0].end_time, normalized.subtitles[0].analysisChunkIndex],
    [452, 454, 3]
  );
  assert.deepEqual(
    [normalized.subtitle_tracks[0].cues[0].start, normalized.subtitle_tracks[0].cues[0].end],
    [455, 456]
  );
});

test("normalizeChunkResult ignores scalar status fields and reads keyed subtitle collections with metadata", () => {
  const normalized = normalizeChunkResult({
    timebase: "relative",
    subtitles: "ready",
    subtitle_cues: {
      zh: [{ start: 1, end: 2, text: "中文" }],
      en: [{ start: 3, end: 4, text: "English" }],
      count: 2,
      status: "ready"
    }
  }, { index: 1, start: 150, end: 300 });

  assert.deepEqual(normalized.subtitles.map((item) => item.text), ["中文", "English"]);
  assert.deepEqual(normalized.subtitles.map((item) => item.start), [151, 153]);
  assert.ok(normalized.subtitles.every((item) => item.analysisChunkIndex === 1));
});

test("recovers a persisted map parser failure once without rerunning saved media", () => {
  const chunk = {
    status: "ready",
    resultSaved: false,
    resultFetchStatus: "error",
    resultFetchAttempts: 3,
    resultFetchError: "(payload.subtitles || payload.subtitle_cues || []).map is not a function"
  };

  assert.equal(recoverChunkResultParserFailure(chunk), true);
  assert.equal(chunk.resultParserVersion, CHUNK_RESULT_PARSER_VERSION);
  assert.equal(chunk.resultFetchStatus, "pending");
  assert.equal(chunk.resultFetchAttempts, 0);
  assert.equal(chunk.resultFetchError, null);
  assert.equal(recoverChunkResultParserFailure(chunk), false, "the migration only runs once");
  assert.equal(recoverChunkResultParserFailure({ ...chunk, resultSaved: true, resultParserVersion: 0 }), false, "saved media is never reset");
});

test("summarizeChunkProgress reports independent media and vector checkpoint totals", () => {
  const summary = summarizeChunkProgress([
    { status: "ready", resultSaved: true, progress: 100, vectorStatus: "ready", sceneCount: 8, transcriptCount: 4, ocrCount: 7, vectorCount: 8 },
    { status: "complete", resultSaved: true, progress: 100, vectorStatus: "error", sceneCount: 5, transcriptCount: 2, ocrCount: 3, vectorCount: 0 },
    { status: "running", progress: 40, vectorStatus: "pending", sceneCount: 2, transcriptCount: 1, ocrCount: 1, vectorCount: 0 },
    { status: "failed", progress: 20, vectorStatus: "pending", sceneCount: 0, transcriptCount: 0, ocrCount: 0, vectorCount: 0 }
  ]);

  assert.deepEqual(summary, {
    total: 4,
    ready: 2,
    failed: 1,
    vectorsReady: 1,
    running: 1,
    sceneCount: 15,
    transcriptCount: 7,
    ocrCount: 11,
    vectorCount: 8,
    mediaPercent: 65,
    vectorPercent: 25,
    percent: 65
  });
  assert.deepEqual(summarizeChunkProgress([]), {
    total: 0,
    ready: 0,
    failed: 0,
    vectorsReady: 0,
    running: 0,
    sceneCount: 0,
    transcriptCount: 0,
    ocrCount: 0,
    vectorCount: 0,
    mediaPercent: 0,
    vectorPercent: 0,
    percent: 0
  });
});

test("mergeChunkState keeps a saved chunk even if a shorter plan is returned later", () => {
  const planned = planAnalysisChunks(300, 150);
  const savedExtra = { ...planAnalysisChunks(450, 150)[2], resultSaved: true, status: "ready", sceneCount: 4 };
  const merged = mergeChunkState(planned, [], [savedExtra]);
  assert.deepEqual(merged.map((chunk) => chunk.index), [0, 1, 2]);
  assert.equal(merged[2].resultSaved, true);
  assert.equal(merged[2].sceneCount, 4);
});
