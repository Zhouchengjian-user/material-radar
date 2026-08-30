import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_REGION_SPECS, imageIndexSignature, normalizeImageOcr } from "../public/image-indexing.js";

test("covers an image with five overlapping local regions", () => {
  assert.equal(IMAGE_REGION_SPECS.length, 5);
  assert.deepEqual(IMAGE_REGION_SPECS.map((item) => item.id), ["top-left", "top-right", "bottom-left", "bottom-right", "center"]);
  assert.ok(IMAGE_REGION_SPECS.every((item) => item.x >= 0 && item.y >= 0 && item.x + item.width <= 1 && item.y + item.height <= 1));
});

test("normalizes image OCR payloads and versions visual versus OCR indexes", () => {
  assert.deepEqual(normalizeImageOcr({ ocr: [{ text: "限时优惠", confidence: .96, bbox: [1, 2, 3, 4] }, " 品牌名 "] }), [
    { text: "限时优惠", confidence: .96, box: [1, 2, 3, 4] },
    { text: "品牌名", confidence: null, box: null }
  ]);
  assert.match(imageIndexSignature({ imageOcr: false }), /:visual$/);
  assert.match(imageIndexSignature({ imageOcr: true }), /:ocr$/);
});
