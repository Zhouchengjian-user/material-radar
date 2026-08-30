import assert from "node:assert/strict";
import test from "node:test";
import { calibrateAndDedupe, evaluateAsset, evaluateVideoSegment, exactTextScore, inferQueryIntent, rerankImageCandidates } from "../public/retrieval.js";

test("detects visual, speech and OCR query intent", () => {
  assert.equal(inferQueryIntent({ query: "夕阳下两个人拥抱" }).label, "画面优先");
  assert.equal(inferQueryIntent({ query: "台词说着因为我遇见了你" }).label, "台词优先");
  assert.equal(inferQueryIntent({ query: "画面文字显示限时优惠" }).label, "画面文字优先");
});

test("keeps speech and visual channels independent during scoring", () => {
  const segment = {
    visualWemmVector: [1, 0],
    speechVector: [0, 1],
    ocrVector: [-1, 0],
    speechText: "因为我遇见了你",
    ocrText: ""
  };
  const visual = evaluateVideoSegment({ segment, asset: { name: "clip.mp4", tags: [] }, query: "夕阳人物", queryVector: [1, 0] });
  const speech = evaluateVideoSegment({ segment, asset: { name: "clip.mp4", tags: [] }, query: "台词说着因为我遇见了你", queryVector: [0, 1] });
  assert.ok(visual.channels.visual > visual.channels.speech);
  assert.ok(speech.channels.speech > speech.channels.visual);
  assert.ok(speech.reasons.includes("台词/旁白"));
});

test("recognizes exact Chinese text without requiring whitespace", () => {
  assert.equal(exactTextScore("屏幕中央显示限时优惠", "限时优惠"), 1);
  assert.ok(exactTextScore("暖色夕阳下的人物特写", "夕阳人物特写") > .5);
});

test("labels legacy mixed text as a shot description instead of ASR and OCR", () => {
  const evaluation = evaluateVideoSegment({
    segment: { wemmVector: [1, 0], content: "海边夕阳下两个人散步" },
    asset: { name: "old-index.mp4", tags: [] },
    query: "夕阳"
  });
  assert.ok(evaluation.reasons.includes("镜头描述"));
  assert.ok(!evaluation.reasons.includes("台词/旁白"));
  assert.ok(!evaluation.reasons.includes("画面文字"));
});

test("treats an exact document phrase as a strong match", () => {
  const evaluation = evaluateAsset({
    asset: { type: "text", name: "brief.txt", tags: [], content: "夕阳海边产品广告", segments: [] },
    query: "夕阳海边"
  });
  assert.ok(evaluation.score >= .8);
  assert.deepEqual(evaluation.reasons, ["原文命中"]);
});

test("reranks an image when a local crop or OCR matches better than the whole image", () => {
  const evaluation = evaluateAsset({
    asset: {
      type: "image", name: "poster.png", tags: [], wemmVector: [0, 1], visualWemmVector: [0, 1],
      imageRegions: [{ id: "top-right", label: "右上区域", wemmVector: [1, 0] }],
      ocrText: "夏日限定五折", ocrVector: [1, 0]
    },
    query: "画面文字显示夏日限定五折",
    queryVector: [1, 0]
  });
  assert.ok(evaluation.rerankScore > evaluation.coarseScore);
  assert.ok(evaluation.rerankReasons.includes("图片文字"));
  assert.equal(evaluation.bestRegion.label, "右上区域");
});

test("only applies detailed image reranking to the configured candidate set", () => {
  const results = [
    { id: "a", resultKey: "a", type: "image", searchScore: .7, coarseScore: .7, rerankScore: .82, rerankReasons: ["局部细节"] },
    { id: "b", resultKey: "b", type: "image", searchScore: .6, coarseScore: .6, rerankScore: .9, rerankReasons: ["图片文字"] }
  ];
  const reranked = rerankImageCandidates(results, { maximum: 1 });
  assert.equal(reranked[0].searchScore, .82);
  assert.equal(reranked[1].searchScore, .6);
});

test("filters weak matches and removes overlapping duplicate shots", () => {
  const results = [
    { id: "a", createdAt: 3, searchScore: .62, isShotResult: true, bestSegment: { start: 0, end: 6, visualVector: [1, 0] } },
    { id: "a", createdAt: 2, searchScore: .59, isShotResult: true, bestSegment: { start: 2, end: 7, visualVector: [1, 0] } },
    { id: "a", createdAt: 1, searchScore: .48, isShotResult: true, bestSegment: { start: 12, end: 18, visualVector: [0, 1] } },
    { id: "b", createdAt: 0, searchScore: .17, isShotResult: true, bestSegment: { start: 0, end: 5, visualVector: [0, 1] } },
    { id: "image", type: "image", createdAt: 0, searchScore: 0, isShotResult: false }
  ];
  const kept = calibrateAndDedupe(results);
  assert.deepEqual(kept.map((item) => item.searchScore), [.62, .48]);
});
