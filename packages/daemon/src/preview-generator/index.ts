import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import mammoth from 'mammoth';
import readXlsxFile, { type CellValue } from 'read-excel-file/node';
import sanitizeHtml from 'sanitize-html';
import sharp from 'sharp';
import WordExtractor from 'word-extractor';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { DaemonConfig } from '../config/index.js';
import { convertToPdf } from '../converter/index.js';

export type PreviewKind = 'pdf' | 'docx-html' | 'xlsx-table' | 'pptx-pdf' | 'office-pdf';

export interface GeneratedPreview {
  kind: PreviewKind;
  previewCount: number;
  aspectRatio: number;
  thumbPath: string;
  manifestPath: string;
  htmlPath?: string;
  sheetPaths: string[];
  pdfPath?: string;
  blurUpBase64: string;
  textSummary: string;
}

interface PdfInfo {
  pageCount: number;
  aspectRatio: number;
  thumbPath: string;
  blurUpBase64: string;
  pages: Array<{ index: number; widthPt: number; heightPt: number }>;
}

interface PdfTextPage {
  getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
  cleanup?(): void;
}

const A4_RATIO = 210 / 297;
const MAX_TEXT_SUMMARY = 20_000;
const MAX_SHEETS = 24;
const MAX_ROWS = 240;
const MAX_COLS = 60;
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

export async function generatePreview(config: DaemonConfig, inputPath: string, documentId: string): Promise<GeneratedPreview> {
  const ext = extension(inputPath);
  const workDir = path.join(config.dataDir, 'work', documentId, 'preview-v2');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  if (ext === 'pdf') return generatePdfPreview(inputPath, workDir, 'pdf');
  if (OFFICE_EXTS.has(ext)) return generateOfficePdfPreview(config, inputPath, documentId, workDir, ext);

  const pdfPath = await convertToPdf(config, inputPath, documentId);
  const kind: PreviewKind = ext === 'ppt' || ext === 'pptx' ? 'pptx-pdf' : 'office-pdf';
  return generatePdfPreview(pdfPath, workDir, kind);
}

async function generateOfficePdfPreview(
  config: DaemonConfig,
  inputPath: string,
  documentId: string,
  workDir: string,
  ext: string
): Promise<GeneratedPreview> {
  try {
    const [pdfPath, extractedText] = await Promise.all([
      convertToPdf(config, inputPath, documentId),
      extractOfficeText(inputPath, ext)
    ]);
    const kind: PreviewKind = ext === 'ppt' || ext === 'pptx' ? 'pptx-pdf' : 'office-pdf';
    const preview = await generatePdfPreview(pdfPath, workDir, kind);
    const textSummary = extractedText || await extractPdfText(pdfPath);
    return { ...preview, textSummary };
  } catch (error) {
    if (config.allowLowFidelityOfficeFallback) {
      return generateLowFidelityOfficeFallback(inputPath, workDir, ext);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`office_pdf_preview_failed:${reason}`);
  }
}

async function generateLowFidelityOfficeFallback(inputPath: string, workDir: string, ext: string): Promise<GeneratedPreview> {
  if (ext === 'docx') return generateDocxPreview(inputPath, workDir);
  if (ext === 'doc') return generateLegacyDocPreview(inputPath, workDir);
  if (ext === 'xlsx') return generateWorkbookPreview(inputPath, workDir);
  throw new Error('office_pdf_converter_missing');
}

async function generatePdfPreview(pdfPath: string, workDir: string, kind: PreviewKind): Promise<GeneratedPreview> {
  const info = await renderPdfThumb(pdfPath, path.join(workDir, 'thumb.webp'));
  const manifest = {
    version: 1,
    kind,
    previewCount: info.pageCount,
    pdf: true,
    paper: paperFromRatio(info.aspectRatio),
    pages: info.pages
  };
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return {
    kind,
    previewCount: info.pageCount,
    aspectRatio: info.aspectRatio,
    thumbPath: info.thumbPath,
    manifestPath,
    sheetPaths: [],
    pdfPath,
    blurUpBase64: info.blurUpBase64,
    textSummary: ''
  };
}

async function generateDocxPreview(inputPath: string, workDir: string): Promise<GeneratedPreview> {
  const [htmlResult, textResult] = await Promise.all([
    mammoth.convertToHtml({ path: inputPath }, {
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh"
      ]
    }),
    mammoth.extractRawText({ path: inputPath })
  ]);
  const textSummary = normalizeText(textResult.value);
  const safeHtml = sanitizeHtml(htmlResult.value, {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' })
    }
  });
  const htmlPath = path.join(workDir, 'doc.html');
  await writeFile(htmlPath, documentHtml(safeHtml), 'utf8');
  const thumbPath = path.join(workDir, 'thumb.webp');
  await renderTextThumb(thumbPath, titleFromFilename(inputPath), textSummary || 'Document preview');
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeJson(manifestPath, {
    version: 1,
    kind: 'docx-html',
    previewCount: 1,
    html: true,
    paper: { widthMm: 210, heightMm: 297, orientation: 'portrait' },
    messages: htmlResult.messages.map((message) => String(message.message)).slice(0, 12)
  });
  return {
    kind: 'docx-html',
    previewCount: 1,
    aspectRatio: A4_RATIO,
    thumbPath,
    manifestPath,
    htmlPath,
    sheetPaths: [],
    blurUpBase64: await blurDataUrl(thumbPath),
    textSummary
  };
}

async function generateLegacyDocPreview(inputPath: string, workDir: string): Promise<GeneratedPreview> {
  const extractor = new WordExtractor();
  const document = await extractor.extract(inputPath);
  const textSummary = normalizeText([
    document.getBody(),
    document.getHeaders({ includeFooters: false }),
    document.getFooters(),
    document.getTextboxes()
  ].filter(Boolean).join('\n\n'));
  const htmlPath = path.join(workDir, 'doc.html');
  await writeFile(htmlPath, documentHtml(textToHtml(textSummary || titleFromFilename(inputPath))), 'utf8');
  const thumbPath = path.join(workDir, 'thumb.webp');
  await renderTextThumb(thumbPath, titleFromFilename(inputPath), textSummary || 'Legacy Word preview');
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeJson(manifestPath, {
    version: 1,
    kind: 'docx-html',
    previewCount: 1,
    html: true,
    paper: { widthMm: 210, heightMm: 297, orientation: 'portrait' },
    source: 'legacy-doc-text'
  });
  return {
    kind: 'docx-html',
    previewCount: 1,
    aspectRatio: A4_RATIO,
    thumbPath,
    manifestPath,
    htmlPath,
    sheetPaths: [],
    blurUpBase64: await blurDataUrl(thumbPath),
    textSummary
  };
}

async function generateWorkbookPreview(inputPath: string, workDir: string): Promise<GeneratedPreview> {
  const worksheets = (await readXlsxFile(inputPath)).slice(0, MAX_SHEETS);
  const sheetPaths: string[] = [];
  const sheetSummaries: Array<{ index: number; name: string; rows: number; cols: number }> = [];
  const textParts: string[] = [];
  for (const [index, worksheet] of worksheets.entries()) {
    const rows = worksheet.data.filter((row) => row.some((cell) => cell !== null && cell !== ''));
    const clippedRows = rows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS).map(formatCell));
    const colCount = clippedRows.reduce((max, row) => Math.max(max, row.length), 0);
    const sheetPath = path.join(workDir, `sheet-${index + 1}.json`);
    const rowCount = rows.length;
    await writeJson(sheetPath, {
      index: index + 1,
      name: worksheet.sheet,
      rowCount,
      colCount,
      truncated: rowCount > clippedRows.length,
      rows: clippedRows
    });
    sheetPaths.push(sheetPath);
    sheetSummaries.push({ index: index + 1, name: worksheet.sheet, rows: rowCount, cols: colCount });
    textParts.push(worksheet.sheet, ...clippedRows.slice(0, 40).flat().filter(Boolean).map(String));
  }
  const textSummary = normalizeText(textParts.join('\n'));
  const thumbPath = path.join(workDir, 'thumb.webp');
  await renderTableThumb(thumbPath, worksheets[0]?.sheet || titleFromFilename(inputPath), sheetPaths[0]);
  const manifestPath = path.join(workDir, 'manifest.json');
  await writeJson(manifestPath, {
    version: 1,
    kind: 'xlsx-table',
    previewCount: sheetPaths.length,
    paper: workbookPaper(sheetSummaries[0]?.cols || 0),
    sheets: sheetSummaries
  });
  return {
    kind: 'xlsx-table',
    previewCount: Math.max(1, sheetPaths.length),
    aspectRatio: A4_RATIO,
    thumbPath,
    manifestPath,
    sheetPaths,
    blurUpBase64: await blurDataUrl(thumbPath),
    textSummary
  };
}

async function extractOfficeText(inputPath: string, ext: string): Promise<string> {
  try {
    if (ext === 'docx') {
      const result = await mammoth.extractRawText({ path: inputPath });
      return normalizeText(result.value);
    }
    if (ext === 'doc') {
      const extractor = new WordExtractor();
      const document = await extractor.extract(inputPath);
      return normalizeText([
        document.getBody(),
        document.getHeaders({ includeFooters: false }),
        document.getFooters(),
        document.getTextboxes()
      ].filter(Boolean).join('\n\n'));
    }
    if (ext === 'xlsx') {
      const worksheets = (await readXlsxFile(inputPath)).slice(0, MAX_SHEETS);
      const parts: string[] = [];
      for (const worksheet of worksheets) {
        parts.push(worksheet.sheet);
        parts.push(
          ...worksheet.data
            .slice(0, 80)
            .flat()
            .filter((value) => value !== null && value !== undefined && value !== '')
            .map(formatCell)
        );
      }
      return normalizeText(parts.join('\n'));
    }
  } catch {
    return '';
  }
  return '';
}

async function extractPdfText(pdfPath: string): Promise<string> {
  try {
    const bytes = new Uint8Array(await readFile(pdfPath));
    const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
    const parts: string[] = [];
    const maxPages = Math.min(pdf.numPages, 30);
    for (let index = 1; index <= maxPages; index += 1) {
      const page = await pdf.getPage(index);
      if (!hasPdfTextContent(page)) {
        page.cleanup?.();
        continue;
      }
      const text = await page.getTextContent();
      parts.push(...text.items.map((item) => item.str || '').filter(Boolean));
      page.cleanup?.();
      if (parts.join(' ').length >= MAX_TEXT_SUMMARY) break;
    }
    await pdf.destroy?.();
    return normalizeText(parts.join(' '));
  } catch {
    return '';
  }
}

function hasPdfTextContent(page: object): page is PdfTextPage {
  return typeof (page as { getTextContent?: unknown }).getTextContent === 'function';
}

async function renderPdfThumb(pdfPath: string, thumbPath: string): Promise<PdfInfo> {
  const bytes = new Uint8Array(await readFile(pdfPath));
  const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const pages: Array<{ index: number; widthPt: number; heightPt: number }> = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const current = index === 1 ? page : await pdf.getPage(index);
    const viewport = current.getViewport({ scale: 1 });
    pages.push({ index, widthPt: viewport.width, heightPt: viewport.height });
    if (index !== 1) current.cleanup?.();
  }
  const scale = Math.min(2.4, 900 / Math.max(1, baseViewport.width));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  const png = canvas.toBuffer('image/png');
  await writeFile(thumbPath, await sharp(png).webp({ quality: 84 }).toBuffer());
  page.cleanup?.();
  await pdf.destroy?.();
  return {
    pageCount: pdf.numPages,
    aspectRatio: baseViewport.width && baseViewport.height ? baseViewport.width / baseViewport.height : A4_RATIO,
    thumbPath,
    blurUpBase64: await blurDataUrl(thumbPath),
    pages
  };
}

async function renderTextThumb(outputPath: string, title: string, text: string): Promise<void> {
  const lines = wrapText(text || title, 42).slice(0, 11);
  const svg = cardSvg(title, lines.map((line) => `<text x="86" y="${line.y}" class="body">${escapeXml(line.text)}</text>`).join('\n'));
  await writeFile(outputPath, await sharp(Buffer.from(svg)).webp({ quality: 84 }).toBuffer());
}

async function renderTableThumb(outputPath: string, title: string, firstSheetPath?: string): Promise<void> {
  let rows: string[][] = [];
  if (firstSheetPath) {
    const parsed = JSON.parse(await readFile(firstSheetPath, 'utf8')) as { rows?: string[][] };
    rows = Array.isArray(parsed.rows) ? parsed.rows.slice(0, 8) : [];
  }
  const cellWidth = 86;
  const cellHeight = 34;
  const table = rows.map((row, y) => row.slice(0, 6).map((cell, x) => {
    const left = 74 + x * cellWidth;
    const top = 144 + y * cellHeight;
    return `<rect x="${left}" y="${top}" width="${cellWidth}" height="${cellHeight}" class="cell ${y === 0 ? 'head' : ''}"/><text x="${left + 8}" y="${top + 22}" class="small">${escapeXml(String(cell).slice(0, 12))}</text>`;
  }).join('\n')).join('\n');
  const svg = cardSvg(title, table || '<text x="86" y="176" class="body">Empty sheet</text>');
  await writeFile(outputPath, await sharp(Buffer.from(svg)).webp({ quality: 84 }).toBuffer());
}

function cardSvg(title: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1273" viewBox="0 0 900 1273">
  <style>
    .bg{fill:#fbfaf4}.page{fill:#fff;stroke:#e7e2d7;stroke-width:2}.title{font:700 44px "Segoe UI",Arial,sans-serif;fill:#2e6450}.body{font:500 25px "Segoe UI",Arial,sans-serif;fill:#282621}.small{font:600 18px "Segoe UI",Arial,sans-serif;fill:#38352f}.muted{fill:#bcb5a8}.cell{fill:#fff;stroke:#e1dcd1}.head{fill:#f1eee5}
  </style>
  <rect width="900" height="1273" class="bg"/>
  <rect x="48" y="42" width="804" height="1189" rx="30" class="page"/>
  <text x="86" y="105" class="title">${escapeXml(title.slice(0, 48))}</text>
  <rect x="86" y="126" width="728" height="2" class="muted"/>
  ${body}
</svg>`;
}

function documentHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body>${body}</body></html>`;
}

function textToHtml(value: string): string {
  const paragraphs = value.split(/\r?\n+/).map((part) => part.trim()).filter(Boolean).slice(0, 240);
  return paragraphs.map((paragraph, index) => {
    const tag = index === 0 && paragraph.length < 100 ? 'h1' : 'p';
    return `<${tag}>${escapeXml(paragraph)}</${tag}>`;
  }).join('\n') || '<p>Empty document</p>';
}

async function blurDataUrl(imagePath: string): Promise<string> {
  const blur = await sharp(await readFile(imagePath)).resize({ width: 20, height: 20, fit: 'inside' }).webp({ quality: 28 }).toBuffer();
  return `data:image/webp;base64,${blur.toString('base64')}`;
}

function wrapText(value: string, width: number): Array<{ text: string; y: number }> {
  const words = value.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length >= 14) break;
  }
  if (current && lines.length < 14) lines.push(current);
  return lines.map((text, index) => ({ text, y: 168 + index * 44 }));
}

function formatCell(value: CellValue | null): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_SUMMARY);
}

function titleFromFilename(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, '') || 'Document';
}

function extension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '&') return '&amp;';
    if (char === "'") return '&apos;';
    return '&quot;';
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function paperFromRatio(ratio: number): { widthMm: number; heightMm: number; orientation: 'portrait' | 'landscape' } {
  return ratio >= 1
    ? { widthMm: 297, heightMm: 210, orientation: 'landscape' }
    : { widthMm: 210, heightMm: 297, orientation: 'portrait' };
}

function workbookPaper(cols: number): { widthMm: number; heightMm: number; orientation: 'portrait' | 'landscape' } {
  return cols > 8
    ? { widthMm: 297, heightMm: 210, orientation: 'landscape' }
    : { widthMm: 210, heightMm: 297, orientation: 'portrait' };
}
