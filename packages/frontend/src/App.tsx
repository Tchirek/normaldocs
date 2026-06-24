import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentCard } from './features/library/DocumentCard';
import { Lightbox } from './features/lightbox/Lightbox';
import { useLightboxMachine } from './features/lightbox/useLightboxMachine';
import { openPrintHandoff } from './features/print/printHandoff';
import { SelectionBar } from './features/selection/SelectionBar';
import { UploadButton } from './features/upload/UploadButton';
import {
  absoluteApiUrl,
  clearDeleteToken,
  deleteDocument,
  getDeleteToken,
  listDocuments,
  recordDocumentView,
  requestDeleteToken,
  retryDocument
} from './lib/api';
import type { DocumentItem } from './types/document';

const MASONRY_GAP = 3;
const CENTRE_URL = 'https://centre.example.com/';
type SelectionEntry = 'toolbar' | 'checkbox' | null;

function openCentre(): void {
  const opened = window.open(CENTRE_URL, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

export function App() {
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [brandReady, setBrandReady] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionEntry, setSelectionEntry] = useState<SelectionEntry>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [allServerSelected, setAllServerSelected] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePin, setDeletePin] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [columnCount, setColumnCount] = useState(() => getColumnCount());
  const [toast, setToast] = useState<string | null>(null);
  const [lightbox, dispatchLightbox] = useLightboxMachine();

  const cursorRef = useRef<number | null>(null);
  const loadingRef = useRef(false);
  const queryRef = useRef('');
  const selectAllSnapshotRef = useRef<Set<string> | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const lightboxItemIdRef = useRef<string | null>(null);
  const lightboxPhaseRef = useRef(lightbox.phase);
  const itemsRef = useRef<DocumentItem[]>([]);
  const activeIndexRef = useRef(-1);

  const selectedCount = allServerSelected ? Math.max(totalCount, selected.size) : selected.size;
  const selectedItems = useMemo(() => items.filter((item) => selected.has(item.id)), [items, selected]);
  const printCandidate = !allServerSelected && selectedItems.length === 1 && selectedItems[0].status === 'ready' ? selectedItems[0] : null;
  const activeIndex = useMemo(() => items.findIndex((item) => item.id === lightbox.item?.id), [items, lightbox.item?.id]);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectionMode(false);
    setSelectionEntry(null);
    setAllServerSelected(false);
    selectAllSnapshotRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ready = async () => {
      try {
        await document.fonts?.load('400 14px "Bungee"');
      } catch {
        // Keep the shell usable even if the display font cannot be fetched.
      }
      if (!cancelled) setBrandReady(true);
    };
    void ready();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    const update = () => setColumnCount(getColumnCount());
    window.addEventListener('resize', update, { passive: true });
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('select-mode', selectionMode);
    return () => document.body.classList.remove('select-mode');
  }, [selectionMode]);

  useEffect(() => {
    lightboxItemIdRef.current = lightbox.item?.id || null;
  }, [lightbox.item?.id]);

  useEffect(() => {
    lightboxPhaseRef.current = lightbox.phase;
  }, [lightbox.phase]);

  const loadPage = useCallback(async (reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await listDocuments(reset ? null : cursorRef.current, queryRef.current);
      setItems((current) => reset ? page.items : mergeDocuments(current, page.items));
      setTotalCount(page.total ?? page.items.length);
      cursorRef.current = page.nextCursor;
      setCursor(page.nextCursor);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文档列表加载失败。');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    cursorRef.current = null;
    setCursor(null);
    clearSelection();
    void loadPage(true);
  }, [clearSelection, loadPage, query]);

  useEffect(() => {
    if (!allServerSelected) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const item of items) next.add(item.id);
      return next;
    });
  }, [allServerSelected, items]);

  useEffect(() => {
    const onScroll = () => {
      if (loadingRef.current || cursorRef.current === null) return;
      if (window.innerHeight + window.scrollY > document.body.offsetHeight - 900) void loadPage(false);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadPage]);

  const columns = useMemo(() => layoutDocuments(items, columnCount), [items, columnCount]);

  const upsertItem = (patched: DocumentItem) => {
    setItems((current) => upsertDocument(current, patched));
    setTotalCount((current) => Math.max(current, items.some((item) => item.id === patched.id) ? current : current + 1));
    if (lightbox.item?.id === patched.id) dispatchLightbox({ type: 'SWITCH', item: patched });
  };

  const reportView = useCallback(async (document: DocumentItem) => {
    if (document.status !== 'ready') return;
    try {
      const result = await recordDocumentView(document.id);
      const patched = { ...document, viewCount: result.viewCount };
      setItems((current) => upsertDocument(current, patched));
      if (lightboxItemIdRef.current === document.id) dispatchLightbox({ type: 'SWITCH', item: patched });
    } catch {
      // View counts are intentionally best-effort; reading must never be blocked by telemetry.
    }
  }, []);

  const openDocument = useCallback((document: DocumentItem, source: HTMLElement) => {
    if (lightboxPhaseRef.current !== 'closed') return;
    lightboxPhaseRef.current = 'opening';
    const sourceRect = source.getBoundingClientRect();
    const radius = Number.parseFloat(getComputedStyle(source).borderRadius || '0');
    dispatchLightbox({ type: 'OPEN', item: document, sourceRect, sourceRadius: radius });
    void reportView(document);
  }, [reportView]);

  const toggleSelection = (id: string) => {
    const entry = selectionEntry ?? 'checkbox';
    if (!selectionMode) {
      setSelectionMode(true);
      setSelectionEntry('checkbox');
    }
    setAllServerSelected(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectAllSnapshotRef.current = null;
      if (next.size === 0 && entry === 'checkbox') {
        setSelectionMode(false);
        setSelectionEntry(null);
      }
      return next;
    });
  };

  const selectAll = () => {
    if (totalCount === 0) return;
    setSelectionMode(true);
    setSelectionEntry((entry) => entry ?? 'toolbar');
    if (allServerSelected) {
      const restored = new Set(selectAllSnapshotRef.current || []);
      selectAllSnapshotRef.current = null;
      setAllServerSelected(false);
      setSelected(restored);
      if (restored.size === 0 && selectionEntry === 'checkbox') {
        setSelectionMode(false);
        setSelectionEntry(null);
      }
      return;
    }
    selectAllSnapshotRef.current = new Set(selected);
    setAllServerSelected(true);
    setSelected(new Set(items.map((item) => item.id)));
  };

  const printDocument = useCallback(async (id: string) => {
    try {
      await openPrintHandoff(id);
    } catch (error) {
      showToast(printErrorText(error));
      throw error;
    }
  }, [showToast]);

  const handleLightboxOpened = useCallback(() => {
    dispatchLightbox({ type: 'OPENED' });
  }, []);

  const handleLightboxClose = useCallback(() => {
    dispatchLightbox({ type: 'CLOSE' });
  }, []);

  const handleLightboxClosed = useCallback(() => {
    dispatchLightbox({ type: 'CLOSED' });
  }, []);

  const handleLightboxSwitch = useCallback((direction: 1 | -1) => {
    const next = itemsRef.current[activeIndexRef.current + direction];
    if (!next) return;
    dispatchLightbox({ type: 'SWITCH', item: next });
    void reportView(next);
  }, [reportView]);

  const downloadSelected = () => {
    const docs = items.filter((item) => selected.has(item.id));
    if (allServerSelected && selected.size < totalCount) {
      showToast('正在下载已加载的文档；完整打包下载稍后接入。');
    }
    docs.forEach((item, index) => {
      window.setTimeout(() => {
        const link = document.createElement('a');
        link.href = absoluteApiUrl(item.downloadUrl);
        link.download = item.filename;
        link.rel = 'noopener';
        document.body.append(link);
        link.click();
        link.remove();
      }, index * 120);
    });
  };

  const runDeleteSelected = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const results = await Promise.allSettled(ids.map((id) => deleteDocument(id)));
      const deleted = ids.filter((_, index) => results[index].status === 'fulfilled');
      const unauthorized = results.some((result) => result.status === 'rejected' && /unauthorized|delete_token_required/.test(String(result.reason)));
      const notConfigured = results.some((result) => result.status === 'rejected' && /delete_auth_not_configured/.test(String(result.reason)));
      if (notConfigured) throw new Error('delete_auth_not_configured');
      if (unauthorized) {
        clearDeleteToken();
        setDeleteDialogOpen(true);
        throw new Error('unauthorized');
      }
      if (deleted.length > 0) {
        setItems((current) => current.filter((item) => !deleted.includes(item.id)));
        setTotalCount((current) => Math.max(0, current - deleted.length));
        setSelected((current) => {
          const next = new Set(current);
          for (const id of deleted) next.delete(id);
          return next;
        });
      }
      if (deleted.length === ids.length) {
        setDeleteDialogOpen(false);
        setDeletePin('');
        clearSelection();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delete_failed';
      setDeleteError(deleteErrorText(message));
    } finally {
      setDeleting(false);
    }
  };

  const requestDelete = () => {
    if (selected.size === 0) return;
    if (getDeleteToken()) void runDeleteSelected();
    else {
      setDeleteError(null);
      setDeleteDialogOpen(true);
    }
  };

  const submitDeletePin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!deletePin.trim()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await requestDeleteToken(deletePin.trim());
      await runDeleteSelected();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delete_failed';
      setDeleteError(deleteErrorText(message));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main id="app-shell">
      <header id="toolbar" aria-label="NormalDocs toolbar">
        <button
          className={`brand ${brandReady ? 'brand-ready' : ''}`}
          type="button"
          aria-label="NormalWorkspace"
          title="NormalWorkspace"
          onClick={openCentre}
        >
          <span className="brand-normal">Normal</span><span className="brand-docs">Docs</span>
        </button>

        <form className={`toolbar-search ${queryInput ? 'has-value' : ''}`} role="search" onSubmit={(event) => event.preventDefault()}>
          <Search size={15} strokeWidth={1.9} aria-hidden="true" />
          <input
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder=""
            aria-label="Search documents"
          />
          {queryInput && (
            <button className="search-clear" type="button" onClick={() => setQueryInput('')} aria-label="Clear search">
              <X size={14} strokeWidth={2.3} />
            </button>
          )}
        </form>

        <div id="toolbar-actions">
          <button
            className={`icon-btn toolbar-select ${selectionMode ? 'is-active' : ''}`}
            type="button"
            onClick={() => {
              if (selectionMode) clearSelection();
              else {
                setSelectionMode(true);
                setSelectionEntry('toolbar');
              }
            }}
            title={selectionMode ? 'Exit selection' : 'Select images'}
            aria-label={selectionMode ? 'Exit selection' : 'Select images'}
          >
            <SlidersHorizontal size={18} strokeWidth={1.9} />
          </button>
          <UploadButton onUploaded={upsertItem} />
        </div>
      </header>

      <section id="gallery" aria-label="Document library">
        {items.length > 0 && (
          <div className="gallery-masonry" style={{ gap: MASONRY_GAP }}>
            {columns.map((column, index) => (
              <div className="gallery-column" key={`column-${index}`} style={{ gap: MASONRY_GAP }}>
                {column.map((item) => (
                  <DocumentCard
                    key={item.id}
                    item={item}
                    selected={selected.has(item.id)}
                    selectionMode={selectionMode}
                    onOpen={openDocument}
                    onToggleSelect={toggleSelection}
                    onRetry={(id) => retryDocument(id).then(() => loadPage(true))}
                    onPrint={printDocument}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {items.length === 0 && !loading && (
          <div className="empty-state">
            <p>No documents yet</p>
            <span>Upload PDF, Word, PowerPoint, or Excel files. The daemon will generate previews automatically.</span>
          </div>
        )}

        {loading && <div className="loading-state">Loading...</div>}
      </section>

      <SelectionBar
        visible={selectionMode || selectedCount > 0}
        count={selectedCount}
        total={totalCount}
        onClear={clearSelection}
        onSelectAll={selectAll}
        onDownload={downloadSelected}
        onDelete={requestDelete}
        onPrint={() => (printCandidate ? printDocument(printCandidate.id) : undefined)}
        printVisible={Boolean(printCandidate)}
      />

      {deleteDialogOpen && (
        <DeletePinDialog
          pin={deletePin}
          error={deleteError}
          busy={deleting}
          selectedCount={selectedCount}
          onPinChange={setDeletePin}
          onCancel={() => {
            if (deleting) return;
            setDeleteDialogOpen(false);
            setDeleteError(null);
            setDeletePin('');
          }}
          onSubmit={submitDeletePin}
        />
      )}

      {lightbox.item && lightbox.sourceRect && lightbox.phase !== 'closed' && (
        <Lightbox
          item={lightbox.item}
          previousItem={activeIndex > 0 ? items[activeIndex - 1] : null}
          nextItem={activeIndex >= 0 && activeIndex < items.length - 1 ? items[activeIndex + 1] : null}
          phase={lightbox.phase}
          sourceRect={lightbox.sourceRect}
          sourceRadius={lightbox.sourceRadius}
          onOpened={handleLightboxOpened}
          onClose={handleLightboxClose}
          onClosed={handleLightboxClosed}
          onPatched={upsertItem}
          onNotice={showToast}
          onSwitch={handleLightboxSwitch}
        />
      )}
      {toast && <div className="app-toast" role="status">{toast}</div>}
    </main>
  );
}

function DeletePinDialog({
  pin,
  error,
  busy,
  selectedCount,
  onPinChange,
  onCancel,
  onSubmit
}: {
  pin: string;
  error: string | null;
  busy: boolean;
  selectedCount: number;
  onPinChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <div className="pin-overlay" role="dialog" aria-modal="true" aria-label="Delete documents">
      <form className="pin-panel" onSubmit={onSubmit}>
        <h2>Delete {selectedCount} documents</h2>
        <input
          autoFocus
          type="password"
          value={pin}
          onChange={(event) => onPinChange(event.target.value)}
          placeholder="Delete key"
          disabled={busy}
        />
        {error && <span className="pin-error">{error}</span>}
        <div className="pin-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || !pin.trim()}>{busy ? 'Deleting...' : 'Confirm'}</button>
        </div>
      </form>
    </div>
  );
}

function getColumnCount(): number {
  if (typeof window === 'undefined') return 4;
  if (window.innerWidth <= 600) return 2;
  if (window.innerWidth <= 920) return 3;
  return 4;
}

function layoutDocuments(items: DocumentItem[], columnCount: number): DocumentItem[][] {
  const columns = Array.from({ length: columnCount }, () => [] as DocumentItem[]);
  const heights = Array.from({ length: columnCount }, () => 0);
  for (const item of items) {
    const ratio = item.aspectRatio && item.aspectRatio > 0 ? item.aspectRatio : 210 / 297;
    let target = 0;
    for (let index = 1; index < heights.length; index += 1) {
      if (heights[index] < heights[target]) target = index;
    }
    columns[target].push(item);
    heights[target] += 1 / ratio;
  }
  return columns;
}

function mergeDocuments(current: DocumentItem[], incoming: DocumentItem[]): DocumentItem[] {
  const map = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return Array.from(map.values()).sort((a, b) => b.uploadedAt - a.uploadedAt || b.id.localeCompare(a.id));
}

function upsertDocument(current: DocumentItem[], incoming: DocumentItem): DocumentItem[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index === -1) return mergeDocuments([incoming, ...current], []);
  const next = current.slice();
  next[index] = { ...current[index], ...incoming };
  return next;
}

function deleteErrorText(message: string): string {
  if (message.includes('delete_auth_not_configured')) return 'Delete key is not configured.';
  if (message.includes('unauthorized')) return 'Delete key is incorrect or expired.';
  return 'Delete failed. Please try again later.';
}

function printErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('print_handoff_not_configured')) return '打印服务还没有配置 609 handoff secret。';
  if (message.includes('document_not_ready')) return '文档还没准备好，稍后再试。';
  if (message.includes('print_session_failed')) return '609 打印会话创建失败。';
  if (message.includes('print_upload_failed')) return '发送到 609 的文件上传失败。';
  if (message.includes('print_notify_failed')) return '609 打印通知失败。';
  return '发送到 609 失败，请稍后重试。';
}
