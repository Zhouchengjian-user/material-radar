import Busboy from "busboy";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import yauzl from "yauzl";
import { extractText } from "unpdf";
import { basename, extname } from "node:path";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_ARCHIVE_DEPTH = 2;

export const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "html", "htm", "srt", "vtt", "xml", "yaml", "yml", "log"]);
export const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "pptx", "xlsx", "rtf", "odt"]);
export const ARCHIVE_EXTENSIONS = new Set(["zip"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg", "heic", "heif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "mpeg", "mpg", "3gp"]);

function extensionOf(name = "") {
  return extname(name).slice(1).toLowerCase();
}

function cleanFilename(name = "file") {
  return basename(String(name).replaceAll("\\", "/")).replace(/[\u0000-\u001f]/g, "").slice(0, 240) || "file";
}

function safeArchivePath(name = "") {
  const normalized = String(name).replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === ".." || part.includes("\u0000"))) throw new Error("压缩包包含不安全的文件路径");
  return parts.join("/");
}

export function mimeForName(name = "") {
  const extension = extensionOf(name);
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mpeg: "video/mpeg", mpg: "video/mpeg", "3gp": "video/3gpp",
    txt: "text/plain", md: "text/markdown", markdown: "text/markdown", json: "application/json", csv: "text/csv", html: "text/html", htm: "text/html", srt: "application/x-subrip", vtt: "text/vtt", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", log: "text/plain",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text", zip: "application/zip"
  })[extension] || "application/octet-stream";
}

export function supportedAssetName(name = "") {
  const extension = extensionOf(name);
  return IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension) || DOCUMENT_EXTENSIONS.has(extension);
}

function decodeXmlEntities(value = "") {
  return value.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function textFromXml(xml = "") {
  return decodeXmlEntities(xml
    .replace(/<w:tab\s*\/>/gi, "\t")
    .replace(/<w:br\s*\/>|<br\s*\/>/gi, "\n")
    .replace(/<\/(?:w:p|a:p|text:p|row|si|sst)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function streamToBuffer(stream, maxBytes = MAX_ENTRY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy(new Error("解压后的单个文件超过 256MB"));
      throw new Error("解压后的单个文件超过 256MB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function collectZipXml(buffer, includePath) {
  const zipfile = await yauzl.fromBufferPromise(buffer, { validateEntrySizes: true });
  const parts = [];
  for await (const entry of zipfile.eachEntry()) {
    if (entry.fileName.endsWith("/") || !includePath(entry.fileName)) continue;
    const stream = await zipfile.openReadStreamPromise(entry);
    const data = await streamToBuffer(stream, 32 * 1024 * 1024);
    const text = textFromXml(data.toString("utf8"));
    if (text) parts.push({ path: entry.fileName, text });
  }
  return parts.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).map((item) => item.text).join("\n\n");
}

function textFromRtf(buffer) {
  return buffer.toString("utf8")
    .replace(/\\u(-?\d+)\??/g, (_, value) => String.fromCharCode(Number(value) < 0 ? Number(value) + 65536 : Number(value)))
    .replace(/\\'[0-9a-f]{2}/gi, " ")
    .replace(/\\(?:par|line)\b/g, "\n")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractDocumentText(buffer, filename) {
  const extension = extensionOf(filename);
  if (!DOCUMENT_EXTENSIONS.has(extension)) throw new Error("不是可解析的文档格式");
  if (extension === "pdf") {
    const result = await extractText(new Uint8Array(buffer), { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    const content = pages.map((page, index) => `第 ${index + 1} 页\n${String(page || "").trim()}`).filter((page) => page.trim()).join("\n\n").trim();
    return { content, documentType: "PDF", pageCount: Number(result.totalPages || pages.length), warning: content ? "" : "没有检测到可复制文字，可能是扫描型 PDF" };
  }
  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return { content: result.value.trim(), documentType: "DOCX", warning: result.messages?.map((item) => item.message).filter(Boolean).join("；") || "" };
  }
  if (extension === "doc") {
    const document = await new WordExtractor().extract(buffer);
    const content = [document.getBody(), document.getTextboxes?.({ includeHeadersAndFooters: true })].filter(Boolean).join("\n\n").trim();
    return { content, documentType: "DOC", warning: content ? "" : "Word 文档没有提取到正文" };
  }
  if (extension === "pptx") {
    const content = await collectZipXml(buffer, (path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path));
    return { content, documentType: "PPTX", warning: content ? "" : "演示文稿没有提取到文字" };
  }
  if (extension === "xlsx") {
    const content = await collectZipXml(buffer, (path) => /^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/i.test(path));
    return { content, documentType: "XLSX", warning: content ? "" : "表格没有提取到文字" };
  }
  if (extension === "odt") {
    const content = await collectZipXml(buffer, (path) => path === "content.xml");
    return { content, documentType: "ODT", warning: content ? "" : "文档没有提取到文字" };
  }
  const content = textFromRtf(buffer);
  return { content, documentType: "RTF", warning: content ? "" : "RTF 文档没有提取到文字" };
}

async function expandZipBuffer(buffer, rootName, prefix = "", depth = 0, limits = { count: 0, bytes: 0, archiveBytes: buffer.length }) {
  const zipfile = await yauzl.fromBufferPromise(buffer, { validateEntrySizes: true, strictFileNames: false });
  const entries = [];
  const skipped = [];
  for await (const entry of zipfile.eachEntry()) {
    if (entry.fileName.endsWith("/")) continue;
    if (limits.count >= MAX_ARCHIVE_ENTRIES) throw new Error(`压缩包文件超过 ${MAX_ARCHIVE_ENTRIES} 个，请拆分后再导入`);
    limits.count += 1;
    let path;
    try { path = safeArchivePath(`${prefix}${entry.fileName}`); }
    catch (error) { skipped.push({ path: entry.fileName, reason: error.message }); continue; }
    if (path.split("/").some((part) => part === "__MACOSX" || part.startsWith("."))) { skipped.push({ path, reason: "系统隐藏文件" }); continue; }
    if (entry.generalPurposeBitFlag & 0x1) { skipped.push({ path, reason: "加密文件暂不支持" }); continue; }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) { skipped.push({ path, reason: "单个文件超过 256MB" }); continue; }
    limits.bytes += entry.uncompressedSize;
    if (limits.bytes > MAX_EXTRACTED_BYTES || (limits.bytes > 64 * 1024 * 1024 && limits.bytes > limits.archiveBytes * 220)) throw new Error("压缩包解压体积异常，请检查是否为压缩炸弹或拆分后重试");
    const extension = extensionOf(path);
    if (!supportedAssetName(path) && !ARCHIVE_EXTENSIONS.has(extension)) { skipped.push({ path, reason: "暂不支持此格式" }); continue; }
    const stream = await zipfile.openReadStreamPromise(entry);
    const data = await streamToBuffer(stream);
    if (extension === "zip" && depth < MAX_ARCHIVE_DEPTH) {
      try {
        const nested = await expandZipBuffer(data, rootName, `${path}/`, depth + 1, limits);
        entries.push(...nested.entries); skipped.push(...nested.skipped);
      } catch (error) { skipped.push({ path, reason: `内层 ZIP 解析失败：${error.message}` }); }
      continue;
    }
    let document = null;
    if (DOCUMENT_EXTENSIONS.has(extension)) {
      try { document = await extractDocumentText(data, path); }
      catch (error) { skipped.push({ path, reason: `文档解析失败：${error.message}` }); continue; }
    }
    entries.push({
      name: cleanFilename(path), sourcePath: path, sourceContainer: cleanFilename(rootName), mime: mimeForName(path), size: data.length,
      data: data.toString("base64"), extractedText: document?.content || "", documentType: document?.documentType || "", pageCount: document?.pageCount || null, parseWarning: document?.warning || ""
    });
  }
  return { entries, skipped };
}

export async function parseImportBuffer(buffer, filename) {
  const extension = extensionOf(filename);
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    const result = await expandZipBuffer(buffer, filename);
    return { kind: "archive", ...result };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return { kind: "document", document: await extractDocumentText(buffer, filename) };
  }
  throw new Error("当前解析接口仅接收 PDF、Office 文档或 ZIP 压缩包");
}

export function readMultipartFile(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upload = null;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    let parser;
    try {
      parser = Busboy({ headers: request.headers, defParamCharset: "utf8", limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, parts: 2 } });
    } catch (error) { return fail(error); }
    parser.on("file", (field, stream, info) => {
      if (field !== "file") { stream.resume(); return; }
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => { size += chunk.length; chunks.push(chunk); });
      stream.on("limit", () => fail(new Error("单次导入文件最大支持 512MB")));
      stream.on("error", fail);
      stream.on("end", () => { if (!stream.truncated) upload = { filename: cleanFilename(info.filename), mime: info.mimeType || mimeForName(info.filename), buffer: Buffer.concat(chunks, size) }; });
    });
    parser.on("filesLimit", () => fail(new Error("每次只解析一个文档或压缩包")));
    parser.on("error", fail);
    parser.on("close", () => {
      if (settled) return;
      if (!upload) return fail(new Error("没有收到可解析文件"));
      settled = true; resolve(upload);
    });
    request.pipe(parser);
  });
}
