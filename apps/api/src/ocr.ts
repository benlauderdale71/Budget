import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export interface ReaderStatus {
  engine: "tesseract";
  available: boolean;
  version: string | null;
  languages: string[];
  pdfText: boolean;
  onDevice: false;
  note: string;
}

export interface ReceiptRead {
  text: string;
  confidence: number | null;
  confidenceNote: string;
  source: "image_ocr" | "pdf_text" | "pdf_scan";
  engine: string;
  pagesRead: number;
  note: string | null;
}

const MAX_PIXELS = 12_000_000;
const MAX_SIDE = 8_000;
const MAX_PDF_PAGES = 8;
const TEXT_PAGES = 3;
const OCR_PAGES = 2;

let cached: ReaderStatus | null = null;

export function readerStatus(force = false): ReaderStatus {
  if (cached && !force) return cached;
  const binary = process.env.BUDGETCENTS_TESSERACT || "tesseract";
  const pdfBinary = process.env.BUDGETCENTS_PDFTOTEXT || "pdftotext";
  const tess = spawnSync(binary, ["--version"], { timeout: 4000, encoding: "utf8" });
  const poppler = spawnSync(pdfBinary, ["-v"], { timeout: 4000, encoding: "utf8" });
  const available = tess.status === 0;
  const versionLine = `${tess.stdout || ""}${tess.stderr || ""}`.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  const pdfText = poppler.status === 0 || `${poppler.stdout || ""}${poppler.stderr || ""}`.includes("pdftotext");
  cached = {
    engine: "tesseract",
    available,
    version: available ? versionLine : null,
    languages: available ? ["eng"] : [],
    pdfText,
    onDevice: false,
    note: available
      ? "Receipts are read on the BudgetCents server with local Tesseract and Poppler. The image is not sent to an external OCR service. This is not on-device recognition."
      : "The local receipt reader is not available on this server. You can still type the receipt.",
  };
  return cached;
}

export async function readReceipt(bytes: Buffer, mime: string): Promise<ReceiptRead> {
  const status = readerStatus();
  if (!status.available) throw new Error(status.note);
  if (mime === "application/pdf" && !status.pdfText) throw new Error("PDF text extraction is not available on this server.");
  const dir = await mkdtemp(join(tmpdir(), "budgetcents-ocr-"));
  try {
    if (mime === "application/pdf") return await readPdf(bytes, dir, status.version ?? "tesseract");
    if (mime !== "image/jpeg" && mime !== "image/png") throw new Error("Only JPEG, PNG, and PDF files are accepted.");
    assertImageBounds(bytes, mime);
    const path = join(dir, "page.png");
    await writeFile(path, bytes);
    const read = await recognizeImage(path);
    return { ...read, source: "image_ocr", engine: status.version ?? "tesseract", pagesRead: 1, note: null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readPdf(bytes: Buffer, dir: string, engine: string): Promise<ReceiptRead> {
  const path = join(dir, "receipt.pdf");
  await writeFile(path, bytes);
  const pages = await pageCount(path);
  if (pages > MAX_PDF_PAGES) throw new Error(`This PDF has ${pages} pages. Receipts are limited to ${MAX_PDF_PAGES} pages.`);
  const text = await run(process.env.BUDGETCENTS_PDFTOTEXT || "pdftotext", ["-layout", "-f", "1", "-l", String(Math.min(TEXT_PAGES, pages)), path, "-"]);
  const embedded = text.stdout.replace(/\f/g, "\n").trim();
  const letters = embedded.match(/[A-Za-z]/g)?.length ?? 0;
  if (letters >= 20) {
    return {
      text: embedded,
      confidence: null,
      confidenceNote: "Embedded PDF text does not include a Tesseract confidence score.",
      source: "pdf_text",
      engine: "pdftotext",
      pagesRead: Math.min(TEXT_PAGES, pages),
      note: pages > TEXT_PAGES ? `Only the first ${TEXT_PAGES} pages of embedded text were read.` : null,
    };
  }
  const prefix = join(dir, "page");
  await run(process.env.BUDGETCENTS_PDFTOPPM || "pdftoppm", ["-png", "-r", "120", "-scale-to", "1600", "-f", "1", "-l", String(Math.min(OCR_PAGES, pages)), path, prefix]);
  const images = (await readdir(dir)).filter((name) => name.startsWith("page-") && name.endsWith(".png")).sort();
  if (!images.length) throw new Error("The PDF had no embedded text and no page could be rasterized.");
  const parts: string[] = [];
  const scores: number[] = [];
  for (const image of images) {
    const read = await recognizeImage(join(dir, image));
    if (read.text.trim()) parts.push(read.text.trim());
    if (read.confidence != null) scores.push(read.confidence);
  }
  const confidence = scores.length ? roundMean(scores) : null;
  return {
    text: parts.join("\n"),
    confidence,
    confidenceNote: confidence == null ? "Tesseract did not report a word confidence for this page." : "Mean of Tesseract word confidence values on the rasterized pages.",
    source: "pdf_scan",
    engine,
    pagesRead: images.length,
    note: pages > OCR_PAGES ? `Only the first ${OCR_PAGES} scanned pages were read.` : null,
  };
}

async function recognizeImage(path: string): Promise<{ text: string; confidence: number | null; confidenceNote: string }> {
  const first = await tesseract(path, "4");
  const letters = first.text.match(/[A-Za-z]/g)?.length ?? 0;
  const chosen = letters >= 8 ? first : await tesseract(path, "1");
  const better = (chosen.text.match(/[A-Za-z]/g)?.length ?? 0) >= letters ? chosen : first;
  return {
    text: better.text,
    confidence: better.confidence,
    confidenceNote: better.confidence == null ? "Tesseract did not report a word confidence for this image." : "Mean of Tesseract word confidence values. Words scored below zero were left out.",
  };
}

async function tesseract(path: string, psm: "4" | "1"): Promise<{ text: string; confidence: number | null }> {
  const result = await run(process.env.BUDGETCENTS_TESSERACT || "tesseract", [path, "stdout", "-l", "eng", "--psm", psm, "tsv"]);
  return parseTsv(result.stdout);
}

function parseTsv(tsv: string): { text: string; confidence: number | null } {
  const rows = tsv.split("\n").slice(1).filter(Boolean);
  const lines = new Map<string, string[]>();
  const scores: number[] = [];
  for (const row of rows) {
    const parts = row.split("\t");
    if (parts.length < 12 || parts[0] !== "5") continue;
    const word = parts.slice(11).join("\t").trim();
    if (!word) continue;
    const key = parts.slice(1, 5).join(":");
    const list = lines.get(key) ?? [];
    list.push(word);
    lines.set(key, list);
    const confidence = Number(parts[10]);
    if (Number.isFinite(confidence) && confidence >= 0) scores.push(confidence);
  }
  const text = [...lines.values()].map((words) => words.join(" ")).join("\n");
  if (!scores.length) return { text, confidence: null };
  return { text, confidence: roundMean(scores) };
}

function roundMean(scores: number[]): number {
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Math.round(mean * 10000) / 10000;
}

async function pageCount(path: string): Promise<number> {
  const info = await run(process.env.BUDGETCENTS_PDFINFO || "pdfinfo", [path]);
  const match = info.stdout.match(/Pages:\s+(\d+)/);
  const pages = match ? Number(match[1]) : 0;
  if (!pages) throw new Error("The PDF page count could not be read.");
  return pages;
}

function assertImageBounds(bytes: Buffer, mime: string) {
  const size = imageSize(bytes, mime);
  if (!size) throw new Error("This image's size could not be checked.");
  if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) {
    throw new Error("This image is too large to read. Use a photo under 12 megapixels.");
  }
  if (size.width < 20 || size.height < 20) throw new Error("This image is too small to read.");
}

function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame && offset + 9 < bytes.length) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 20_000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const coded = error as NodeJS.ErrnoException & { killed?: boolean };
        if (coded.killed) reject(new Error("The receipt reader stopped because it took too long."));
        else if (coded.code === "ENOENT") reject(new Error("The local receipt reader is not installed."));
        else reject(new Error("The receipt reader could not finish this file."));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
