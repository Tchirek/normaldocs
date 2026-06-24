import { AlertCircle, Check, FileText, Heart, LoaderCircle, MessageCircle, Printer, RotateCcw } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { displayFilename, extensionLabel, prettyBytes } from '../../lib/filename';
import type { DocumentItem } from '../../types/document';

interface Props {
  item: DocumentItem;
  selected: boolean;
  selectionMode: boolean;
  onOpen: (item: DocumentItem, source: HTMLElement) => void;
  onToggleSelect: (id: string) => void;
  onRetry: (id: string) => void;
  onPrint: (id: string) => Promise<void> | void;
}

export function DocumentCard({ item, selected, selectionMode, onOpen, onToggleSelect, onRetry, onPrint }: Props) {
  const ready = item.status === 'ready' && item.thumbUrl;
  const ratio = item.aspectRatio && item.aspectRatio > 0 ? item.aspectRatio : 210 / 297;
  const checkOnLight = useLightCorner(item.blurUpBase64);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    setImageLoaded(false);
    setPrinting(false);
  }, [item.id, item.thumbUrl]);

  const handlePrint = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (printing) return;
    setPrinting(true);
    try {
      await onPrint(item.id);
    } catch {
      setPrinting(false);
    }
  };

  return (
    <article
      className={`photo-item document-item ${selected ? 'is-selected' : ''} ${selectionMode ? 'is-selectable' : ''} status-${item.status}`}
      style={{ aspectRatio: ratio }}
      data-document-id={item.id}
    >
      <button
        className={`photo-check ${checkOnLight ? 'photo-check-on-light' : ''}`}
        data-selected={selected}
        type="button"
        aria-label="Select document"
        onClick={(event) => {
          event.stopPropagation();
          onToggleSelect(item.id);
        }}
      >
        <Check size={14} strokeWidth={3.1} aria-hidden="true" />
      </button>

      <button
        className="document-open"
        type="button"
        onClick={(event) => {
          if (selectionMode) {
            onToggleSelect(item.id);
            return;
          }
          onOpen(item, event.currentTarget.closest<HTMLElement>('.photo-item') || event.currentTarget);
        }}
      >
        {ready ? (
          <>
            {item.blurUpBase64 && <img className="photo-placeholder" src={item.blurUpBase64} alt="" draggable={false} />}
            <img
              className={`photo-image ${imageLoaded ? 'is-loaded' : ''}`}
              src={item.thumbUrl || ''}
              alt=""
              draggable={false}
              onLoad={(event) => {
                const img = event.currentTarget;
                if ('decode' in img) {
                  img.decode().catch(() => undefined).finally(() => setImageLoaded(true));
                } else {
                  setImageLoaded(true);
                }
              }}
            />
          </>
        ) : (
          <DocumentPlaceholder item={item} />
        )}

        <div className="photo-caption">
          <span className="document-ext" data-ext-kind={extensionKind(item.filename)}>{extensionLabel(item.filename)}</span>
          <strong>{displayFilename(item.filename)}</strong>
          <small>{captionMeta(item)}</small>
        </div>
      </button>

      <div className="photo-engagement-counts" aria-hidden="true">
        {item.likeCount > 0 && (
          <Badge own={item.likedByMe} icon={<Heart size={11} fill="currentColor" strokeWidth={2.1} />} value={item.likeCount} />
        )}
        {item.commentCount > 0 && (
          <Badge icon={<MessageCircle size={11} fill="currentColor" strokeWidth={2.1} />} value={item.commentCount} />
        )}
      </div>

      <div className={`document-card-actions ${printing ? 'is-busy' : ''}`}>
        {item.status === 'failed' && (
          <button className="document-card-action" type="button" onClick={() => onRetry(item.id)} aria-label="Retry processing">
            <RotateCcw size={15} strokeWidth={2.2} />
          </button>
        )}
        {ready && (
          <button className={`document-card-action ${printing ? 'is-loading' : ''}`} type="button" onClick={handlePrint} disabled={printing} aria-label="Print">
            {printing ? <LoaderCircle className="spin-icon" size={15} strokeWidth={2.2} /> : <Printer size={15} strokeWidth={2.2} />}
          </button>
        )}
      </div>
    </article>
  );
}

function DocumentPlaceholder({ item }: { item: DocumentItem }) {
  const failed = item.status === 'failed';
  const processing = item.status === 'processing' || item.status === 'uploading' || item.status === 'pending';
  return (
    <div className={`document-placeholder ${processing ? 'shimmer' : ''}`}>
      <div className="document-placeholder-inner">
        {failed ? <AlertCircle size={32} strokeWidth={1.7} /> : <FileText size={34} strokeWidth={1.6} />}
        <span>{failed ? 'Processing failed' : statusText(item.status)}</span>
      </div>
    </div>
  );
}

function Badge({ icon, value, own = false }: { icon: React.ReactNode; value: number; own?: boolean }) {
  return (
    <span className={`photo-count-badge ${own ? 'is-own' : ''}`}>
      {icon}
      <span>{value}</span>
    </span>
  );
}

function captionMeta(item: DocumentItem): string {
  return `${formatViews(item.viewCount)} / ${prettyBytes(item.sizeBytes)}`;
}

function formatViews(value: number): string {
  const count = Math.max(0, Math.trunc(value || 0));
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M views`;
  if (count >= 10_000) return `${Math.round(count / 1000)}K views`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K views`;
  return `${count} ${count === 1 ? 'view' : 'views'}`;
}

function extensionKind(filename: string): 'pdf' | 'doc' | 'xlsx' | 'ppt' | 'other' {
  const ext = extensionLabel(filename).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xlsx';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  return 'other';
}

function statusText(status: DocumentItem['status']): string {
  switch (status) {
    case 'uploading':
      return 'Uploading';
    case 'pending':
      return 'Waiting';
    case 'processing':
      return 'Generating preview';
    case 'failed':
      return 'Processing failed';
    default:
      return 'Preparing';
  }
}

function useLightCorner(blurDataUrl: string | null): boolean {
  const [light, setLight] = useState(false);

  useEffect(() => {
    if (!blurDataUrl) {
      setLight(false);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || !img.naturalWidth || !img.naturalHeight) return;
      const canvas = document.createElement('canvas');
      const width = Math.min(12, img.naturalWidth);
      const height = Math.min(12, img.naturalHeight);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(img, 0, 0, width, height);
      const data = context.getImageData(0, 0, Math.max(1, Math.floor(width * 0.42)), Math.max(1, Math.floor(height * 0.42))).data;
      let total = 0;
      for (let index = 0; index < data.length; index += 4) {
        total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      }
      if (!cancelled) setLight(total / (data.length / 4) > 210);
    };
    img.src = blurDataUrl;
    return () => {
      cancelled = true;
    };
  }, [blurDataUrl]);

  return light;
}
