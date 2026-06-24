import { useEffect, useMemo, useRef, useState } from 'react';
import { getViewerId } from '../../lib/viewer';

const COMMENTS_ORIGIN = import.meta.env.VITE_NORMALDOCS_COMMENTS_ORIGIN || 'https://comments.pics.example.com';

export function CommentsFrame({ documentId, visible, onClose }: { documentId: string; visible: boolean; onClose: () => void }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [rendered, setRendered] = useState(visible);
  const [frameReady, setFrameReady] = useState(false);
  const url = useMemo(() => {
    const next = new URL('/embed', COMMENTS_ORIGIN);
    next.searchParams.set('preset', 'normaldocs');
    next.searchParams.set('documentId', documentId);
    return next.toString();
  }, [documentId]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== COMMENTS_ORIGIN) return;
      if (!event.data || typeof event.data !== 'object') return;
      const type = (event.data as { type?: unknown }).type;
      if (type === 'comment-ui:ready') setFrameReady(true);
      if (type === 'comment-ui:close') onClose();
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onClose]);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      setFrameReady(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setRendered(false), 190);
    return () => window.clearTimeout(timer);
  }, [visible, url]);

  useEffect(() => {
    if (!visible || !frameRef.current?.contentWindow) return;
    frameRef.current.contentWindow.postMessage({ type: 'normalpics:context', imageId: documentId, documentId, viewerId: getViewerId() }, COMMENTS_ORIGIN);
  }, [documentId, frameReady, visible]);

  if (!rendered) return null;
  return (
    <aside className={`lightbox-comments ${visible ? 'is-open' : 'is-closing'} ${frameReady ? 'is-ready' : 'is-loading'}`}>
      <div className="comments-frame-skeleton" aria-hidden="true">
        <span className="comments-skeleton-line strong" />
        <span className="comments-skeleton-line" />
        <span className="comments-skeleton-card" />
        <span className="comments-skeleton-card short" />
      </div>
      <iframe
        ref={frameRef}
        title="NormalDocs comments"
        className="comments-frame"
        src={url}
        allow="clipboard-write"
        loading="eager"
        onLoad={() => window.setTimeout(() => setFrameReady(true), 180)}
      />
    </aside>
  );
}
