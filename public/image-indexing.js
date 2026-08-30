export const IMAGE_INDEX_VERSION = "image-v2-global-regions-ocr";

// Five overlapping regions cover corners, edges and the centre without turning
// one image into dozens of expensive model requests.
export const IMAGE_REGION_SPECS = [
  { id: "top-left", label: "左上区域", x: 0, y: 0, width: .62, height: .62 },
  { id: "top-right", label: "右上区域", x: .38, y: 0, width: .62, height: .62 },
  { id: "bottom-left", label: "左下区域", x: 0, y: .38, width: .62, height: .62 },
  { id: "bottom-right", label: "右下区域", x: .38, y: .38, width: .62, height: .62 },
  { id: "center", label: "中心区域", x: .19, y: .19, width: .62, height: .62 }
];

const numberFrom = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function normalizeImageOcr(payload = {}) {
  const rows = payload.ocr || payload.texts || payload.results || [];
  return rows.map((item) => {
    if (typeof item === "string") return { text: item.trim(), confidence: null, box: null };
    return {
      text: String(item.text || item.content || item.value || "").trim(),
      confidence: item.confidence == null ? null : numberFrom(item.confidence),
      box: item.box || item.bbox || item.points || null
    };
  }).filter((item) => item.text);
}

export function imageIndexSignature({ imageOcr = false } = {}) {
  return `${IMAGE_INDEX_VERSION}:${imageOcr ? "ocr" : "visual"}`;
}
