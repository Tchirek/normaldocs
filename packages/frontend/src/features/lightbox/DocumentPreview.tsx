import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { absoluteApiUrl } from '../../lib/api';
import type { DocumentItem, PaperInfo, PreviewManifest, PreviewManifestPage } from '../../types/document';

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: Record<string, unknown>): { promise: Promise<void> };
    cleanup?: () => void;
  }>;
  destroy?: () => Promise<void>;
}

interface SheetData {
  name: string;
  rows: string[][];
  truncated?: boolean;
}

const A4_PAPER: PaperInfo = { widthMm: 210, heightMm: 297, orientation: 'portrait' };
const manifestCache = new Map<string, PreviewManifest | null>();
const manifestInflight = new Map<string, Promise<PreviewManifest | null>>();
const htmlCache = new Map<string, string>();
const htmlInflight = new Map<string, Promise<string>>();
const sheetCache = new Map<string, SheetData | null>();
const sheetInflight = new Map<string, Promise<SheetData | null>>();
const pdfDocumentCache = new Map<string, Promise<PdfDocument>>();
const pdfPageCountCache = new Map<string, number>();
const PAGE_STAGE_INITIAL_DELAY_MS = 163;
const PAGE_STAGE_FAST_DELAY_MS = 78;
const PAGE_STAGE_SLOW_DELAY_MS = 109;
const PAGE_ENTER_STAGGER_MS = 31;

export function DocumentPreview({
  item,
  readerRef,
  active,
  preload
}: {
  item: DocumentItem;
  readerRef?: RefObject<HTMLDivElement | null>;
  active: boolean;
  preload: boolean;
}) {
  const manifestUrl = item.previewManifestUrl ? absoluteApiUrl(item.previewManifestUrl) : null;
  const [manifest, setManifest] = useState<PreviewManifest | null>(() => manifestUrl ? manifestCache.get(manifestUrl) ?? null : null);
  const shouldLoadPreview = active || preload;

  useEffect(() => {
    let disposed = false;
    if (!shouldLoadPreview) {
      return;
    }
    if (!manifestUrl) {
      setManifest(null);
      return;
    }
    const cached = manifestCache.get(manifestUrl) ?? null;
    if (manifestCache.has(manifestUrl)) {
      setManifest((current) => current === cached ? current : cached);
    } else {
      setManifest(null);
    }
    loadManifest(manifestUrl)
      .then((next) => {
        if (!disposed) setManifest((current) => current === next ? current : next);
      })
      .catch(() => {
        if (!disposed) setManifest(null);
      });
    return () => {
      disposed = true;
    };
  }, [manifestUrl, shouldLoadPreview]);

  return (
    <div ref={readerRef} className="document-reader" data-preview-kind={item.previewKind || 'pending'} data-active-preview={active ? 'true' : 'false'}>
      <ReaderHeader item={item} />
      <div className="document-reader-content">
        {shouldLoadPreview ? renderPreview(item, manifest, active) : <ReaderSkeleton paper={manifest?.paper || A4_PAPER} label="Loading document preview" />}
      </div>
    </div>
  );
}

function renderPreview(item: DocumentItem, manifest: PreviewManifest | null, active: boolean) {
  if (item.previewKind === 'docx-html' && item.previewHtmlUrl) {
    return <DocHtmlPreview url={absoluteApiUrl(item.previewHtmlUrl)} paper={manifest?.paper || A4_PAPER} />;
  }
  if (item.previewKind === 'xlsx-table') {
    return <SheetPreview item={item} manifest={manifest} />;
  }
  if ((item.previewKind === 'pdf' || item.previewKind === 'pptx-pdf' || item.previewKind === 'office-pdf') && item.previewPdfUrl) {
    return <PdfPreview url={absoluteApiUrl(item.previewPdfUrl)} pages={manifest?.pages || []} paper={manifest?.paper || A4_PAPER} active={active} />;
  }
  return <ReaderSkeleton paper={manifest?.paper || A4_PAPER} label="Preview is being prepared" />;
}

function ReaderHeader({ item }: { item: DocumentItem }) {
  return (
    <div className="document-reader-header" aria-hidden="true">
      <span>{formatUploadedDate(item.uploadedAt)}</span>
      <span>{item.previewCount ? `${item.previewCount} previews` : 'preparing'}</span>
    </div>
  );
}

function formatUploadedDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'Uploaded';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Uploaded';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function DocHtmlPreview({ url, paper }: { url: string; paper: PaperInfo }) {
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(url) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    if (htmlCache.has(url)) {
      const cached = htmlCache.get(url) ?? null;
      setHtml((current) => current === cached ? current : cached);
    } else {
      setHtml(null);
    }
    setError(null);
    loadHtml(url)
      .then((text) => {
        if (!disposed) setHtml((current) => current === text ? current : text);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : 'doc_html_failed');
      });
    return () => {
      disposed = true;
    };
  }, [url]);

  if (error) return <ReaderSkeleton paper={paper} label={`Preview failed: ${error}`} />;
  if (html === null) return <ReaderSkeleton paper={paper} label="Loading document preview" />;

  return (
    <article className="paper-page docx-paper preview-reveal" style={paperStyle(paper)}>
      <div className="docx-paper-body" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

function PdfPreview({
  url,
  pages,
  paper,
  active
}: {
  url: string;
  pages: PreviewManifestPage[];
  paper: PaperInfo;
  active: boolean;
}) {
  const [pageCount, setPageCount] = useState(() => pdfPageCountCache.get(url) ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PdfDocument | null>(null);
  const [stagedPageCount, setStagedPageCount] = useState(0);
  const documentUrlRef = useRef<string | null>(null);
  const stagedPageCountRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let loadTimer: number | null = null;
    const urlChanged = documentUrlRef.current !== url;
    documentUrlRef.current = url;
    setError(null);
    if (urlChanged) setPdfDocument(null);
    const cachedPageCount = pdfPageCountCache.get(url) ?? 0;
    setPageCount((current) => current === cachedPageCount ? current : cachedPageCount);
    const load = () => loadPdfDocument(url)
      .then((pdf) => {
        if (disposed) return;
        setPdfDocument(pdf);
        pdfPageCountCache.set(url, pdf.numPages);
        setPageCount((current) => current === pdf.numPages ? current : pdf.numPages);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : 'pdf_load_failed');
      });
    if (active || pdfDocumentCache.has(url)) {
      void load();
    } else {
      loadTimer = window.setTimeout(() => {
        loadTimer = null;
        void load();
      }, 240);
    }
    return () => {
      disposed = true;
      if (loadTimer !== null) window.clearTimeout(loadTimer);
    };
  }, [active, url]);

  const knownPageCount = Math.max(pageCount, pages.length);

  useEffect(() => {
    if (!knownPageCount) {
      stagedPageCountRef.current = 0;
      setStagedPageCount(0);
      return;
    }

    const resetCount = active
      ? Math.min(knownPageCount, Math.max(1, stagedPageCountRef.current || 1))
      : Math.min(knownPageCount, 1);
    stagedPageCountRef.current = resetCount;
    setStagedPageCount((current) => current === resetCount ? current : resetCount);

    if (!active || resetCount >= knownPageCount) return;

    let disposed = false;
    let timer: number | null = null;
    let frame: number | null = null;

    const step = () => {
      if (disposed) return;
      const current = stagedPageCountRef.current;
      if (current >= knownPageCount) return;
      const increment = current < 5 ? 1 : current < 15 ? 2 : 4;
      const next = Math.min(knownPageCount, current + increment);
      stagedPageCountRef.current = next;
      setStagedPageCount(next);
      if (next < knownPageCount) {
        timer = window.setTimeout(() => {
          timer = null;
          frame = requestAnimationFrame(step);
        }, next < 7 ? PAGE_STAGE_FAST_DELAY_MS : PAGE_STAGE_SLOW_DELAY_MS);
      }
    };

    timer = window.setTimeout(() => {
      timer = null;
      frame = requestAnimationFrame(step);
    }, PAGE_STAGE_INITIAL_DELAY_MS);

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [active, knownPageCount, url]);

  if (error) return <ReaderSkeleton paper={paper} label={`PDF preview failed: ${error}`} />;
  if (!knownPageCount) return <ReaderSkeleton paper={paper} label="Loading PDF pages" />;
  const visiblePageCount = active ? Math.min(knownPageCount, Math.max(1, stagedPageCount)) : Math.min(knownPageCount, 1);

  return (
    <div className="preview-reveal">
      {Array.from({ length: visiblePageCount }, (_, index) => {
        const page = pages.find((entry) => entry.index === index + 1);
        return <PdfPage key={index + 1} pdf={pdfDocument} pageNumber={index + 1} pageInfo={page} paper={paper} enter={active && index > 0} />;
      })}
    </div>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  pageInfo,
  paper,
  enter
}: {
  pdf: PdfDocument | null;
  pageNumber: number;
  pageInfo?: PreviewManifestPage;
  paper: PaperInfo;
  enter: boolean;
}) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPixelWidthRef = useRef(0);
  const renderedRef = useRef(false);
  const [ratio, setRatio] = useState(() => pageInfo ? pageInfo.widthPt / pageInfo.heightPt : paper.widthMm / paper.heightMm);
  const [rendered, setRendered] = useState(false);
  const [shouldRender, setShouldRender] = useState(() => pageNumber <= 2);

  useEffect(() => {
    renderedRef.current = rendered;
  }, [rendered]);

  useEffect(() => {
    const nextRatio = pageInfo ? pageInfo.widthPt / pageInfo.heightPt : paper.widthMm / paper.heightMm;
    setRatio((current) => Math.abs(current - nextRatio) < 0.0001 ? current : nextRatio);
  }, [pageInfo, paper.heightMm, paper.widthMm]);

  useEffect(() => {
    if (pageNumber <= 2 && !shouldRender) {
      setShouldRender(true);
      return;
    }
    const section = sectionRef.current;
    if (shouldRender || !section || typeof IntersectionObserver === 'undefined') {
      if (!shouldRender && (pageNumber <= 2 || typeof IntersectionObserver === 'undefined')) setShouldRender(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShouldRender(true);
        observer.disconnect();
      }
    }, { rootMargin: '900px 0px' });
    observer.observe(section);
    return () => observer.disconnect();
  }, [pageNumber, shouldRender]);

  useEffect(() => {
    let disposed = false;
    let renderTicket = 0;
    const canvas = canvasRef.current;
    if (!canvas || !pdf || !shouldRender) return;
    let resizeTimer: number | null = null;
    const render = () => {
      const lightbox = document.getElementById('lightbox');
      if (lightbox?.dataset.gestureMode === 'switch') {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(render, 120);
        return;
      }
      const ticket = ++renderTicket;
      pdf.getPage(pageNumber).then(async (page) => {
        if (disposed || ticket !== renderTicket) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.width / base.height);
        const measuredWidth = sectionRef.current?.clientWidth || canvas.clientWidth || Math.floor(window.innerWidth * 0.92);
        const isMobile = window.matchMedia('(max-width: 760px)').matches;
        const maxRatio = isMobile ? 2.35 : 2.25;
        const pixelRatio = Math.min(maxRatio, Math.max(1, window.devicePixelRatio || 1));
        const maxPixelWidth = isMobile ? 1900 : 2600;
        const targetPixelWidth = Math.min(Math.ceil(measuredWidth * pixelRatio), maxPixelWidth);
        if (lastPixelWidthRef.current === targetPixelWidth && renderedRef.current) return;
        lastPixelWidthRef.current = targetPixelWidth;
        if (renderedRef.current) {
          renderedRef.current = false;
          setRendered(false);
        }
        const viewport = page.getViewport({ scale: targetPixelWidth / base.width });
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        if (!disposed && ticket === renderTicket) {
          renderedRef.current = true;
          setRendered(true);
        }
        page.cleanup?.();
      }).catch(() => undefined);
    };
    const frame = requestAnimationFrame(render);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (disposed) return;
          if (resizeTimer !== null) window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(render, 180);
        });
    if (sectionRef.current) observer?.observe(sectionRef.current);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      observer?.disconnect();
    };
  }, [pageNumber, pdf, shouldRender]);

  const enterIndex = Math.min(Math.max(pageNumber - 2, 0), 8);
  const pageStyle = {
    aspectRatio: ratio,
    '--page-enter-delay': `${enterIndex * PAGE_ENTER_STAGGER_MS}ms`
  } as CSSProperties;

  return (
    <section ref={sectionRef} className={`paper-page pdf-paper ${rendered ? 'is-rendered' : 'is-rendering'} ${enter ? 'page-enter' : ''}`} style={pageStyle}>
      {!rendered && <div className="pdf-page-loading" aria-hidden="true" />}
      <canvas ref={canvasRef} className="pdf-preview-page" aria-label={`Page ${pageNumber}`} />
    </section>
  );
}

function SheetPreview({ item, manifest }: { item: DocumentItem; manifest: PreviewManifest | null }) {
  const sheets = manifest?.sheets || [];
  const [active, setActive] = useState(1);
  const [sheet, setSheet] = useState<SheetData | null>(null);

  useEffect(() => {
    const first = sheets[0]?.index || 1;
    setActive(first);
  }, [item.id, sheets]);

  useEffect(() => {
    let disposed = false;
    const url = absoluteApiUrl(`/api/preview/${item.id}/sheet/${active}`);
    if (sheetCache.has(url)) {
      const cached = sheetCache.get(url) ?? null;
      setSheet((current) => current === cached ? current : cached);
    } else {
      setSheet(null);
    }
    loadSheet(url)
      .then((next) => {
        if (!disposed) setSheet((current) => current === next ? current : next);
      })
      .catch(() => {
        if (!disposed) setSheet(null);
      });
    return () => {
      disposed = true;
    };
  }, [active, item.id]);

  const activeMeta = sheets.find((entry) => entry.index === active);
  const landscape = (activeMeta?.cols || 0) > 8;
  const paper: PaperInfo = landscape
    ? { widthMm: 297, heightMm: 210, orientation: 'landscape' }
    : A4_PAPER;

  return (
    <div className="sheet-preview preview-reveal">
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((entry) => (
            <button key={entry.index} className={entry.index === active ? 'active' : ''} type="button" onClick={() => setActive(entry.index)}>
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <section className="paper-page sheet-paper" style={paperStyle(paper)}>
        <div className="sheet-table-wrap">
          {sheet ? (
            <table className="sheet-table">
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, colIndex) => (
                      <td key={colIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="sheet-loading">Loading sheet...</div>
          )}
        </div>
      </section>
    </div>
  );
}

function ReaderSkeleton({ paper, label }: { paper: PaperInfo; label: string }) {
  return (
    <section className="paper-page paper-skeleton" style={paperStyle(paper)}>
      <div />
      <div />
      <div />
      <span>{label}</span>
    </section>
  );
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

function loadManifest(url: string): Promise<PreviewManifest | null> {
  const cached = manifestInflight.get(url);
  if (cached) return cached;
  const promise = fetch(url)
    .then((response) => response.ok ? response.json() : Promise.reject(new Error(`manifest_${response.status}`)))
    .then((next) => normalizeManifest(next))
    .then((next) => {
      if (next) manifestCache.set(url, next);
      return next;
    })
    .finally(() => {
      manifestInflight.delete(url);
    });
  manifestInflight.set(url, promise);
  return promise;
}

function loadHtml(url: string): Promise<string> {
  const cached = htmlCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = htmlInflight.get(url);
  if (inflight) return inflight;
  const promise = fetch(url)
    .then((response) => response.ok ? response.text() : Promise.reject(new Error(`doc_html_${response.status}`)))
    .then((text) => {
      const body = extractBodyHtml(text);
      htmlCache.set(url, body);
      return body;
    })
    .finally(() => {
      htmlInflight.delete(url);
    });
  htmlInflight.set(url, promise);
  return promise;
}

function loadSheet(url: string): Promise<SheetData | null> {
  if (sheetCache.has(url)) return Promise.resolve(sheetCache.get(url) ?? null);
  const inflight = sheetInflight.get(url);
  if (inflight) return inflight;
  const promise = fetch(url)
    .then((response) => response.ok ? response.json() : Promise.reject(new Error(`sheet_${response.status}`)))
    .then((next) => {
      const sheet = normalizeSheet(next);
      if (sheet) sheetCache.set(url, sheet);
      return sheet;
    })
    .finally(() => {
      sheetInflight.delete(url);
    });
  sheetInflight.set(url, promise);
  return promise;
}

function loadPdfDocument(url: string): Promise<PdfDocument> {
  const cached = pdfDocumentCache.get(url);
  if (cached) return cached;
  const promise = loadPdfjs()
    .then((pdfjs) => pdfjs.getDocument({ url }).promise)
    .then((pdf) => pdf as PdfDocument)
    .catch((error) => {
      pdfDocumentCache.delete(url);
      throw error;
    });
  pdfDocumentCache.set(url, promise);
  return promise;
}

function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.mjs?url')
    ]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function normalizeSheet(value: unknown): SheetData | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rows = Array.isArray(record.rows)
    ? record.rows.map((row) => Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [])
    : [];
  return {
    name: typeof record.name === 'string' ? record.name : 'Sheet',
    rows,
    truncated: Boolean(record.truncated)
  };
}

function normalizeManifest(value: unknown): PreviewManifest | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const version = Number(record.version || 1);
  const kind = typeof record.kind === 'string' ? record.kind : null;
  const previewCount = Number(record.previewCount || 0);
  if (!kind || !Number.isFinite(previewCount)) return null;
  const paper = normalizePaper(record.paper);
  const pages = Array.isArray(record.pages)
    ? record.pages.map(normalizePage).filter((page): page is PreviewManifestPage => Boolean(page))
    : undefined;
  const sheets = Array.isArray(record.sheets)
    ? record.sheets.map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const item = entry as Record<string, unknown>;
        return {
          index: Number(item.index || 0),
          name: String(item.name || 'Sheet'),
          rows: Number(item.rows || 0),
          cols: Number(item.cols || 0)
        };
      }).filter((entry): entry is { index: number; name: string; rows: number; cols: number } => Boolean(entry?.index))
    : undefined;
  return { version, kind: kind as PreviewManifest['kind'], previewCount, paper, pages, sheets };
}

function normalizePaper(value: unknown): PaperInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const widthMm = Number(record.widthMm);
  const heightMm = Number(record.heightMm);
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) return undefined;
  return {
    widthMm,
    heightMm,
    orientation: widthMm >= heightMm ? 'landscape' : 'portrait'
  };
}

function normalizePage(value: unknown): PreviewManifestPage | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const index = Number(record.index);
  const widthPt = Number(record.widthPt);
  const heightPt = Number(record.heightPt);
  if (!Number.isFinite(index) || !Number.isFinite(widthPt) || !Number.isFinite(heightPt) || index < 1 || widthPt <= 0 || heightPt <= 0) {
    return null;
  }
  return { index, widthPt, heightPt };
}

function paperStyle(paper: PaperInfo): CSSProperties {
  return { aspectRatio: `${paper.widthMm} / ${paper.heightMm}` };
}

function extractBodyHtml(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return match ? match[1] : html;
}
