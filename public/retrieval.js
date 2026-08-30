const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, Number(value) || 0));

const SYNONYMS = {
  暖色: ["暖色", "暖调", "金色", "橙色", "日落", "夕阳"],
  冷色: ["冷色", "冷调", "蓝色", "青色"],
  夜晚: ["夜晚", "夜景", "夜间", "黑夜"],
  人物: ["人物", "人像", "人", "角色"],
  特写: ["特写", "近景", "脸部", "面部"],
  户外: ["户外", "室外", "外景"],
  室内: ["室内", "内景", "房间"],
  台词: ["台词", "对白", "旁白", "语音"],
  字幕: ["字幕", "文字", "标题", "文案"],
  科技: ["科技", "未来", "赛博", "数码"],
  竖屏: ["竖屏", "portrait"],
  横屏: ["横屏", "landscape"]
};

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function queryTokens(query) {
  const normalized = normalizeText(query).replace(/[“”‘’"']/g, "");
  if (!normalized) return [];
  let tokens = [];
  try {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    tokens = [...segmenter.segment(normalized)].filter((item) => item.isWordLike).map((item) => item.segment);
  } catch {
    tokens = normalized.split(/[\s,，。！？!?;；:：、/]+/);
  }
  return [...new Set(tokens.map((item) => item.trim()).filter((item) => item.length > 1 || /[a-z\d]/i.test(item)))].slice(0, 12);
}

function synonymGroup(token) {
  const direct = SYNONYMS[token];
  if (direct) return direct;
  const matched = Object.values(SYNONYMS).find((values) => values.includes(token));
  return matched || [token];
}

export function exactTextScore(text, query) {
  const haystack = normalizeText(text);
  const needle = normalizeText(query).replace(/[“”‘’"']/g, "");
  if (!haystack || !needle) return 0;
  if (haystack.includes(needle)) return 1;
  const tokens = queryTokens(needle);
  if (!tokens.length) return 0;
  const hits = tokens.filter((token) => synonymGroup(token).some((term) => haystack.includes(term))).length;
  const coverage = hits / Math.min(tokens.length, 8);
  return clamp(coverage * (hits >= 2 ? 1 : .78));
}

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  return clamp(a.reduce((sum, value, index) => sum + value * b[index], 0), -1, 1);
}

function semanticSimilarity(vector, queryVector, referenceVector) {
  const queryScore = queryVector?.length ? Math.max(0, cosineSimilarity(queryVector, vector)) : null;
  const referenceScore = referenceVector?.length ? Math.max(0, cosineSimilarity(referenceVector, vector)) : null;
  if (queryScore !== null && referenceScore !== null) return queryScore * .7 + referenceScore * .3;
  return queryScore ?? referenceScore ?? 0;
}

function bestImageSemantic(vectors, queryVector, referenceVectors) {
  const valid = (vectors || []).filter((vector) => vector?.length);
  const references = (referenceVectors || []).filter((vector) => vector?.length);
  if (!valid.length) return 0;
  return Math.max(...valid.map((vector) => {
    const queryScore = queryVector?.length ? Math.max(0, cosineSimilarity(queryVector, vector)) : null;
    const referenceScore = references.length ? Math.max(...references.map((reference) => Math.max(0, cosineSimilarity(reference, vector)))) : null;
    if (queryScore !== null && referenceScore !== null) return queryScore * .7 + referenceScore * .3;
    return queryScore ?? referenceScore ?? 0;
  }));
}

export function inferQueryIntent({ query = "", referenceType = null, view = "radar" } = {}) {
  const text = normalizeText(query);
  const hasQuote = /[“”‘’"']/.test(String(query || ""));
  const speechIntent = hasQuote || /(台词|对白|旁白|语音|说着|说出|说了|讲述|听到|声音|口播)/.test(text);
  const ocrIntent = /(画面文字|屏幕文字|字幕|标题|文案|logo|品牌名|写着|显示|价格|数字|二维码|包装文字|海报文字)/i.test(text);
  let weights = { visual: .7, speech: .12, ocr: .08, metadata: .1 };
  let label = "画面优先";
  if (speechIntent && ocrIntent) { weights = { visual: .2, speech: .36, ocr: .34, metadata: .1 }; label = "台词与文字优先"; }
  else if (speechIntent) { weights = { visual: .2, speech: .62, ocr: .08, metadata: .1 }; label = "台词优先"; }
  else if (ocrIntent) { weights = { visual: .22, speech: .06, ocr: .62, metadata: .1 }; label = "画面文字优先"; }
  else if (view === "text") { weights = { visual: .08, speech: .32, ocr: .25, metadata: .35 }; label = "文字语义优先"; }
  if (!text && ["image", "video"].includes(referenceType)) { weights = { visual: .88, speech: .04, ocr: .03, metadata: .05 }; label = "参考画面优先"; }
  return { weights, label, speechIntent, ocrIntent };
}

function matchReasons(channels, contributions, referenceType) {
  const labels = {
    visual: referenceType ? "参考画面" : "画面语义",
    speech: "台词/旁白",
    ocr: "画面文字",
    metadata: "名称/标签"
  };
  return Object.keys(channels)
    .filter((key) => channels[key] >= (key === "metadata" ? .35 : .18) && contributions[key] > .015)
    .sort((a, b) => contributions[b] - contributions[a])
    .slice(0, 3)
    .map((key) => labels[key]);
}

function finishEvaluation(channels, intent, referenceType) {
  const contributions = Object.fromEntries(Object.entries(channels).map(([key, value]) => [key, clamp(value) * intent.weights[key]]));
  const score = clamp(Object.values(contributions).reduce((sum, value) => sum + value, 0));
  return { score, channels, contributions, reasons: matchReasons(channels, contributions, referenceType), intent: intent.label };
}

export function evaluateVideoSegment({ segment, asset, query = "", queryVector = null, reference = null, view = "radar" }) {
  const intent = inferQueryIntent({ query, referenceType: reference?.type, view });
  const referenceVector = reference?.wemmVector;
  const visualVector = segment.visualWemmVector || segment.videoVector || segment.wemmVector;
  const semanticVisual = semanticSimilarity(visualVector, queryVector, referenceVector);
  const layoutSimilarity = reference?.visualVector && segment.visualVector ? Math.max(0, cosineSimilarity(reference.visualVector, segment.visualVector)) : 0;
  let visual = semanticVisual ? semanticVisual * .9 + layoutSimilarity * .1 : layoutSimilarity * .78;
  const speechText = segment.speechText || "";
  const ocrText = segment.ocrText || "";
  const fallbackText = !speechText && !ocrText ? segment.content || "" : "";
  const referenceText = reference?.type === "text" ? String(reference.content || "").slice(0, 600) : "";
  const textNeedle = query || referenceText;
  const legacyExact = exactTextScore(fallbackText, textNeedle);
  if (fallbackText) visual = Math.max(visual, legacyExact * .32);
  const speech = Math.max(
    semanticSimilarity(segment.speechVector, queryVector, referenceVector),
    exactTextScore(speechText, textNeedle)
  );
  const ocr = Math.max(
    semanticSimilarity(segment.ocrVector, queryVector, referenceVector),
    exactTextScore(ocrText, textNeedle)
  );
  const metadataText = `${asset?.name || ""} ${(asset?.tags || []).join(" ")} ${fallbackText}`;
  const metadata = exactTextScore(metadataText, textNeedle);
  const evaluation = finishEvaluation({ visual, speech, ocr, metadata }, intent, reference?.type);
  if (fallbackText && legacyExact >= .35) evaluation.reasons = ["镜头描述", ...evaluation.reasons.filter((reason) => reason !== "名称/标签" && (semanticVisual >= .18 || reason !== "画面语义"))].slice(0, 3);
  return evaluation;
}

export function evaluateAsset({ asset, query = "", queryVector = null, reference = null, view = "radar", searchScope = "segments" }) {
  if (asset.type === "video" && asset.segments?.length) {
    const ranked = asset.segments.map((segment) => ({ segment, evaluation: evaluateVideoSegment({ segment, asset, query, queryVector, reference, view }) })).sort((a, b) => b.evaluation.score - a.evaluation.score);
    if (searchScope === "assets" || ranked[0]?.evaluation.score) return { ...ranked[0]?.evaluation, bestSegment: ranked[0]?.segment || null };
  }
  const intent = inferQueryIntent({ query, referenceType: reference?.type, view });
  const referenceVector = reference?.wemmVector;
  const semantic = semanticSimilarity(asset.visualWemmVector || asset.wemmVector, queryVector, referenceVector);
  const localVisual = reference?.visualVector && asset.visualVector ? Math.max(0, cosineSimilarity(reference.visualVector, asset.visualVector)) : 0;
  const textNeedle = query || (reference?.type === "text" ? String(reference.content || "").slice(0, 600) : "");
  const text = `${asset.name || ""} ${(asset.tags || []).join(" ")} ${asset.content || ""}`;
  const exact = exactTextScore(text, textNeedle);
  if (asset.type === "text") {
    const rankedSegments = (asset.segments || []).map((segment) => {
      const segmentSemantic = semanticSimilarity(segment.textVector || segment.wemmVector, queryVector, referenceVector);
      const segmentExact = exactTextScore(segment.content || "", textNeedle);
      return { segment, score: segmentSemantic * .72 + segmentExact * .28, semantic: segmentSemantic, exact: segmentExact };
    }).sort((a, b) => b.score - a.score);
    const best = rankedSegments[0];
    const documentExact = Math.max(exact, best?.exact || 0);
    const metadataExact = exactTextScore(`${asset.name || ""} ${(asset.tags || []).join(" ")}`, textNeedle);
    const textIntent = { ...intent, weights: { visual: 0, speech: .82, ocr: 0, metadata: .18 }, label: "文字语义优先" };
    const evaluation = finishEvaluation({ visual: 0, speech: Math.max(semantic, best?.semantic || 0, documentExact), ocr: 0, metadata: metadataExact }, textIntent, reference?.type);
    evaluation.reasons = evaluation.score ? [documentExact ? "原文命中" : "文字语义"] : [];
    return { ...evaluation, bestSegment: best?.segment || null };
  }
  if (asset.type === "image") {
    const referenceVectors = [reference?.wemmVector, ...(reference?.imageRegionVectors || [])];
    const globalVisual = bestImageSemantic([asset.visualWemmVector || asset.wemmVector], queryVector, referenceVectors);
    const localVisual = bestImageSemantic((asset.imageRegions || []).map((region) => region.wemmVector), queryVector, referenceVectors);
    const visual = Math.max(globalVisual * .68 + localVisual * .32, localVisual * .94, globalVisual);
    const ocrText = asset.ocrText || (asset.ocr || []).map((item) => item.text).join(" ");
    const ocr = Math.max(
      semanticSimilarity(asset.ocrVector, queryVector, reference?.type === "text" ? reference?.wemmVector : null),
      exactTextScore(ocrText, textNeedle)
    );
    const coarseIntent = { ...intent, weights: { visual: .88, speech: 0, ocr: 0, metadata: .12 }, label: "整图语义召回" };
    const coarse = finishEvaluation({ visual: globalVisual, speech: 0, ocr: 0, metadata: exact }, coarseIntent, reference?.type);
    let rerankWeights = intent.ocrIntent
      ? { visual: .28, speech: 0, ocr: .62, metadata: .1 }
      : { visual: .78, speech: 0, ocr: .12, metadata: .1 };
    if (!query && ["image", "video"].includes(reference?.type)) rerankWeights = { visual: .92, speech: 0, ocr: .02, metadata: .06 };
    const rerankIntent = { ...intent, weights: rerankWeights, label: intent.ocrIntent ? "图片文字精排" : "整图与局部精排" };
    const reranked = finishEvaluation({ visual, speech: 0, ocr, metadata: exact }, rerankIntent, reference?.type);
    const reasons = reranked.reasons.filter((reason) => reason !== "画面文字");
    if (localVisual > globalVisual + .035 && visual > .18) reasons.unshift("局部细节");
    if (ocr >= .35) reasons.unshift("图片文字");
    return {
      ...coarse,
      coarseScore: coarse.score,
      rerankScore: reranked.score,
      rerankReasons: [...new Set(reasons)].slice(0, 3),
      rerankChannels: reranked.channels,
      bestRegion: (asset.imageRegions || []).map((region) => ({ region, score: bestImageSemantic([region.wemmVector], queryVector, referenceVectors) })).sort((a, b) => b.score - a.score)[0]?.region || null,
      bestSegment: null
    };
  }
  const visual = semantic ? semantic * .9 + localVisual * .1 : localVisual * .78;
  const visualIntent = { ...intent, weights: { visual: .88, speech: 0, ocr: 0, metadata: .12 } };
  return { ...finishEvaluation({ visual, speech: 0, ocr: 0, metadata: exact }, visualIntent, reference?.type), bestSegment: null };
}

export function rerankImageCandidates(results, { maximum = 40 } = {}) {
  const candidates = results
    .filter((item) => item.type === "image" && Number.isFinite(item.rerankScore))
    .sort((a, b) => (b.coarseScore ?? b.searchScore) - (a.coarseScore ?? a.searchScore))
    .slice(0, maximum);
  const candidateKeys = new Set(candidates.map((item) => item.resultKey || item.id));
  return results.map((item) => {
    if (!candidateKeys.has(item.resultKey || item.id)) return item;
    return {
      ...item,
      searchScore: item.rerankScore,
      matchReasons: item.rerankReasons || item.matchReasons,
      matchChannels: item.rerankChannels || item.matchChannels
    };
  });
}

function overlapRatio(a, b) {
  const start = Math.max(Number(a.start) || 0, Number(b.start) || 0);
  const end = Math.min(Number(a.end) || 0, Number(b.end) || 0);
  const overlap = Math.max(0, end - start);
  const shortest = Math.max(.01, Math.min((Number(a.end) || 0) - (Number(a.start) || 0), (Number(b.end) || 0) - (Number(b.start) || 0)));
  return overlap / shortest;
}

function duplicateShot(candidate, existing) {
  if (!candidate.isShotResult || !existing.isShotResult || candidate.id !== existing.id) return false;
  const a = candidate.bestSegment || {}; const b = existing.bestSegment || {};
  if (overlapRatio(a, b) >= .42) return true;
  const gap = Math.max(0, Math.max(Number(a.start) || 0, Number(b.start) || 0) - Math.min(Number(a.end) || 0, Number(b.end) || 0));
  return gap <= .35 && cosineSimilarity(a.visualVector, b.visualVector) >= .995;
}

export function calibrateAndDedupe(results, { maximum = 60 } = {}) {
  const ranked = [...results].sort((a, b) => b.searchScore - a.searchScore || b.createdAt - a.createdAt);
  const topByType = new Map();
  ranked.filter((item) => item.searchScore > 0).forEach((item) => topByType.set(item.type || "all", Math.max(topByType.get(item.type || "all") || 0, item.searchScore || 0)));
  if (![...topByType.values()].some(Boolean)) return [];
  const kept = [];
  for (const candidate of ranked) {
    if (!(candidate.searchScore > 0)) continue;
    const top = topByType.get(candidate.type || "all") || 0;
    const floor = Math.max(Math.min(.18, top * .62), top * .68, top - .18);
    if (candidate.searchScore + 1e-6 < floor) continue;
    if (kept.some((item) => duplicateShot(candidate, item))) continue;
    kept.push(candidate);
    if (kept.length >= maximum) break;
  }
  return kept;
}

export function matchLevel(score) {
  if (score >= .52) return "强匹配";
  if (score >= .32) return "较相关";
  return "可能相关";
}
