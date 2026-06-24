import { ChevronLeft, ChevronRight, Download, Heart, LoaderCircle, MessageCircle, Printer, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { absoluteApiUrl, setLike } from '../../lib/api';
import { displayFilename, prettyBytes } from '../../lib/filename';
import type { DocumentItem, LightboxPhase } from '../../types/document';
import { CommentsFrame } from '../comments/CommentsFrame';
import { openPrintHandoff } from '../print/printHandoff';
import { DocumentPreview } from './DocumentPreview';

interface Props {
  item: DocumentItem;
  previousItem?: DocumentItem | null;
  nextItem?: DocumentItem | null;
  phase: LightboxPhase;
  sourceRect: DOMRect;
  sourceRadius: number;
  onOpened: () => void;
  onClose: () => void;
  onClosed: () => void;
  onSwitch?: (direction: 1 | -1) => void;
  onPatched: (item: DocumentItem) => void;
  onNotice?: (message: string) => void;
}

type DragMode = 'pending' | 'switch' | 'close';
type GestureState = {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  mode: DragMode;
  startedAtTop: boolean;
  source: 'pointer' | 'touch';
  baseSwitchOffset: number;
};
type PendingSwitch = {
  direction: 1 | -1;
  expectedId: string;
};
type SlideSet = {
  prev: DocumentItem | null;
  current: DocumentItem;
  next: DocumentItem | null;
};

export function Lightbox({
  item,
  previousItem = null,
  nextItem = null,
  phase,
  sourceRect,
  sourceRadius,
  onOpened,
  onClose,
  onClosed,
  onSwitch,
  onPatched,
  onNotice
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const openAnimationStartedRef = useRef(false);
  const closeAnimationStartedRef = useRef(false);
  const callbacksRef = useRef({ onOpened, onClosed });
  const onSwitchRef = useRef(onSwitch);
  const onCloseRef = useRef(onClose);
  const phaseRef = useRef(phase);
  const commentsOpenRef = useRef(false);
  const gestureFrameRef = useRef<number | null>(null);
  const lastGestureWriterRef = useRef<(() => void) | null>(null);
  const activeAnimationsRef = useRef<Animation[]>([]);
  const dragRef = useRef<GestureState | null>(null);
  const pendingSwitchRef = useRef<PendingSwitch | null>(null);
  const isGestureActiveRef = useRef(false);
  const isSwitchingRef = useRef(false);
  const viewportWidthRef = useRef(window.innerWidth);
  const [slides, setSlides] = useState<SlideSet>(() => ({
    prev: previousItem,
    current: item,
    next: nextItem
  }));
  const slidesRef = useRef(slides);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [likePending, setLikePending] = useState(false);
  const [printing, setPrinting] = useState(false);
  const target = useMemo(() => ({
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight
  }), [item.id]);
  const sourceTransform = useMemo(() => {
    const sx = sourceRect.width / Math.max(1, target.width);
    const sy = sourceRect.height / Math.max(1, target.height);
    return `translate3d(${sourceRect.left}px, ${sourceRect.top}px, 0) scale(${sx}, ${sy})`;
  }, [sourceRect, target.height, target.width]);

  useEffect(() => {
    callbacksRef.current = { onOpened, onClosed };
  }, [onClosed, onOpened]);

  useEffect(() => {
    onSwitchRef.current = onSwitch;
  }, [onSwitch]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    commentsOpenRef.current = commentsOpen;
  }, [commentsOpen]);

  useEffect(() => {
    slidesRef.current = slides;
  }, [slides]);

  useEffect(() => {
    const updateViewportWidth = () => {
      viewportWidthRef.current = window.innerWidth;
      if (!isGestureActiveRef.current && !isSwitchingRef.current) {
        const track = trackRef.current;
        if (track) track.style.transform = trackTransform(0, viewportWidthRef.current);
      }
    };
    window.addEventListener('resize', updateViewportWidth);
    return () => window.removeEventListener('resize', updateViewportWidth);
  }, []);

  const rememberAnimation = (animation: Animation) => {
    activeAnimationsRef.current.push(animation);
    const forget = () => {
      activeAnimationsRef.current = activeAnimationsRef.current.filter((current) => current !== animation);
    };
    animation.addEventListener('finish', forget, { once: true });
    animation.addEventListener('cancel', forget, { once: true });
    return animation;
  };

  const commitAndReleaseAnimation = (animation: Animation) => {
    try {
      animation.commitStyles();
    } catch {
      // commitStyles can throw if the animation was cancelled between frames.
    }
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    activeAnimationsRef.current = activeAnimationsRef.current.filter((current) => current !== animation);
  };

  const cancelActiveAnimations = () => {
    const animations = activeAnimationsRef.current;
    activeAnimationsRef.current = [];
    for (const animation of animations) {
      animation.onfinish = null;
      animation.oncancel = null;
      try {
        animation.cancel();
      } catch {
        // Ignore already-finished animations.
      }
    }
  };

  useLayoutEffect(() => {
    const pending = pendingSwitchRef.current;

    if (pending && pending.expectedId === item.id) {
      pendingSwitchRef.current = null;
      isSwitchingRef.current = false;
      const nextSlides = { prev: previousItem, current: item, next: nextItem };
      slidesRef.current = nextSlides;
      setSlides(nextSlides);
      const track = trackRef.current;
      if (track) {
        track.style.transform = trackTransform(0, viewportWidthRef.current);
      }
      return;
    }

    if (pending) {
      if (item.id === slidesRef.current.current.id) return;
      pendingSwitchRef.current = null;
      isSwitchingRef.current = false;
      const nextSlides = { prev: previousItem, current: item, next: nextItem };
      slidesRef.current = nextSlides;
      setSlides(nextSlides);
      const track = trackRef.current;
      if (track) track.style.transform = trackTransform(0, viewportWidthRef.current);
      return;
    }

    if (isGestureActiveRef.current || isSwitchingRef.current) return;

    if (!pending) {
      const current = slidesRef.current;
      if (
        current.current.id === item.id &&
        current.prev?.id === previousItem?.id &&
        current.next?.id === nextItem?.id
      ) {
        return;
      }
      const nextSlides = { prev: previousItem, current: item, next: nextItem };
      slidesRef.current = nextSlides;
      setSlides(nextSlides);
      const track = trackRef.current;
      if (track) {
        track.style.transform = trackTransform(0, viewportWidthRef.current);
      }
    }
  }, [item, nextItem, previousItem]);

  useEffect(() => {
    setLikePending(false);
    setPrinting(false);
  }, [item.id]);

  useEffect(() => {
    const stage = stageRef.current;
    const scrim = scrimRef.current;
    if (!stage || !scrim || phase !== 'opening') return;
    if (openAnimationStartedRef.current) return;
    openAnimationStartedRef.current = true;
    closeAnimationStartedRef.current = false;
    cancelActiveAnimations();
    document.body.classList.add('viewer-lock');
    stage.style.transformOrigin = 'top left';
    stage.style.borderRadius = `${sourceRadius}px`;
    stage.style.transform = sourceTransform;
    stage.style.opacity = '1';
    scrim.style.opacity = '0';
    const track = trackRef.current;
    if (track) track.style.transform = trackTransform(0, viewportWidthRef.current);

    const stageAnimation = rememberAnimation(stage.animate([
      { transform: sourceTransform, borderRadius: `${sourceRadius}px` },
      { transform: 'translate3d(0, 0, 0) scale(1, 1)', borderRadius: '0px' }
    ], { duration: 340, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }));
    const scrimAnimation = rememberAnimation(scrim.animate([{ opacity: 0 }, { opacity: 0.96 }], { duration: 240, fill: 'forwards' }));

    stageAnimation.onfinish = () => {
      commitAndReleaseAnimation(stageAnimation);
      commitAndReleaseAnimation(scrimAnimation);
      stage.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
      stage.style.borderRadius = '0px';
      stage.style.opacity = '1';
      callbacksRef.current.onOpened();
    };
    stageAnimation.oncancel = () => {
      document.body.classList.remove('viewer-lock');
      callbacksRef.current.onClosed();
    };
  }, [phase, sourceRadius, sourceTransform]);

  useEffect(() => {
    const stage = stageRef.current;
    const scrim = scrimRef.current;
    if (!stage || !scrim || phase !== 'closing') return;
    if (closeAnimationStartedRef.current) return;
    closeAnimationStartedRef.current = true;
    cancelActiveAnimations();
    document.body.classList.add('viewer-lock');
    const fromTransform = stage.style.transform || 'translate3d(0, 0, 0) scale(1, 1)';
    const stageAnimation = rememberAnimation(stage.animate([
      { transform: fromTransform, opacity: 1 },
      { transform: fromTransform, opacity: 0 }
    ], { duration: 150, easing: 'ease-out', fill: 'forwards' }));
    const scrimAnimation = rememberAnimation(scrim.animate([{ opacity: Number(getComputedStyle(scrim).opacity) }, { opacity: 0 }], { duration: 175, fill: 'forwards' }));

    stageAnimation.onfinish = () => {
      commitAndReleaseAnimation(stageAnimation);
      commitAndReleaseAnimation(scrimAnimation);
      scrim.style.opacity = '0';
      stage.style.opacity = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove('viewer-lock');
        callbacksRef.current.onClosed();
      }));
    };
    stageAnimation.oncancel = () => {
      document.body.classList.remove('viewer-lock');
      callbacksRef.current.onClosed();
    };
  }, [phase]);

  const closeByGesture = (dy: number) => {
    const layer = readerRef.current;
    const scrim = scrimRef.current;
    if (!layer || !scrim) return;
    const pull = Math.max(0, dy);
    const easedDy = pull < 180 ? pull : 180 + (pull - 180) * 0.52;
    const opacity = Math.max(0.48, 1 - pull / 360);
    const scrimOpacity = Math.max(0.08, 0.96 - pull / 260);
    writeGestureFrame(() => {
      layer.style.transform = `translate3d(0, ${easedDy}px, 0)`;
      layer.style.opacity = String(opacity);
      scrim.style.opacity = String(scrimOpacity);
    });
  };

  const switchByGesture = (gesture: GestureState) => {
    const track = trackRef.current;
    if (!track) return;
    const width = viewportWidthRef.current;
    const limit = width * 0.78;
    const dx = gesture.dx;
    const abs = Math.abs(dx);
    const easedDx = Math.sign(dx) * (abs < limit ? abs : limit + (abs - limit) * 0.22);
    const offset = gesture.baseSwitchOffset + easedDx;
    writeGestureFrame(() => {
      track.style.transform = trackTransform(offset, width);
    });
  };

  const restoreCloseGesture = () => {
    const layer = readerRef.current;
    const scrim = scrimRef.current;
    if (!layer || !scrim) return;
    flushGestureFrame();
    cancelActiveAnimations();
    const stageAnimation = rememberAnimation(layer.animate([
      { transform: layer.style.transform, opacity: layer.style.opacity || 1 },
      { transform: 'translate3d(0, 0, 0)', opacity: 1 }
    ], { duration: 210, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }));
    const scrimAnimation = rememberAnimation(scrim.animate([{ opacity: getComputedStyle(scrim).opacity }, { opacity: 0.96 }], { duration: 160, fill: 'forwards' }));
    stageAnimation.onfinish = () => {
      commitAndReleaseAnimation(stageAnimation);
      commitAndReleaseAnimation(scrimAnimation);
      layer.style.transform = 'translate3d(0, 0, 0)';
      layer.style.opacity = '1';
    };
  };

  const restoreSwitchGesture = () => {
    const track = trackRef.current;
    if (!track) return;
    flushGestureFrame();
    cancelActiveAnimations();
    const animation = rememberAnimation(track.animate([
      { transform: track.style.transform || trackTransform(0, viewportWidthRef.current) },
      { transform: trackTransform(0, viewportWidthRef.current) }
    ], { duration: 210, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }));
    animation.onfinish = () => {
      commitAndReleaseAnimation(animation);
      track.style.transform = trackTransform(0, viewportWidthRef.current);
    };
  };

  const finishSwitchGesture = (direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) {
      onSwitchRef.current?.(direction);
      return;
    }
    flushGestureFrame();
    cancelActiveAnimations();
    const expectedId = direction > 0 ? slidesRef.current.next?.id : slidesRef.current.prev?.id;
    if (!expectedId) {
      restoreSwitchGesture();
      return;
    }
    isSwitchingRef.current = true;
    const width = viewportWidthRef.current;
    const endX = direction > 0 ? -width : width;
    const animation = rememberAnimation(track.animate([
      { transform: track.style.transform || trackTransform(0, width) },
      { transform: trackTransform(endX, width) }
    ], { duration: 150, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', fill: 'forwards' }));
    animation.onfinish = () => {
      commitAndReleaseAnimation(animation);
      pendingSwitchRef.current = { direction, expectedId };
      onSwitchRef.current?.(direction);
    };
    animation.oncancel = () => {
      pendingSwitchRef.current = null;
      isSwitchingRef.current = false;
      track.style.transform = trackTransform(0, viewportWidthRef.current);
    };
  };

  const canBeginCloseGesture = () => (readerRef.current?.scrollTop || 0) <= 1;
  const canSwitchDirection = (direction: 1 | -1) => {
    const currentSlides = slidesRef.current;
    return direction > 0 ? Boolean(currentSlides.next) : Boolean(currentSlides.prev);
  };

  const readTrackOffset = () => {
    const track = trackRef.current;
    const width = viewportWidthRef.current;
    if (!track) return 0;
    const transform = getComputedStyle(track).transform;
    if (!transform || transform === 'none') return 0;
    try {
      return new DOMMatrixReadOnly(transform).m41 + width;
    } catch {
      const match = transform.match(/matrix\(([^)]+)\)/);
      if (!match) return 0;
      const parts = match[1].split(',').map((part) => Number(part.trim()));
      return Number.isFinite(parts[4]) ? parts[4] + width : 0;
    }
  };

  const interruptSwitchAnimation = () => {
    const track = trackRef.current;
    const width = viewportWidthRef.current;
    const offset = readTrackOffset();
    cancelActiveAnimations();
    pendingSwitchRef.current = null;
    isSwitchingRef.current = false;
    if (track) track.style.transform = trackTransform(offset, width);
    return offset;
  };

  const writeGestureFrame = (writer: () => void) => {
    if (gestureFrameRef.current !== null) cancelAnimationFrame(gestureFrameRef.current);
    lastGestureWriterRef.current = writer;
    gestureFrameRef.current = requestAnimationFrame(() => {
      gestureFrameRef.current = null;
      const nextWriter = lastGestureWriterRef.current;
      lastGestureWriterRef.current = null;
      nextWriter?.();
    });
  };

  const flushGestureFrame = () => {
    if (gestureFrameRef.current !== null) {
      cancelAnimationFrame(gestureFrameRef.current);
      gestureFrameRef.current = null;
    }
    const writer = lastGestureWriterRef.current;
    lastGestureWriterRef.current = null;
    writer?.();
  };

  const ignoredGestureTarget = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    return !element || Boolean(element.closest('.lightbox-control, .lightbox-comments'));
  };

  const setGestureModeAttribute = (mode: DragMode | null) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (mode) overlay.dataset.gestureMode = mode;
    else delete overlay.dataset.gestureMode;
  };

  const setGestureMode = (gesture: GestureState, mode: DragMode) => {
    gesture.mode = mode;
    setGestureModeAttribute(mode);
  };

  const beginGesture = (source: 'pointer' | 'touch', id: number, x: number, y: number) => {
    if (phaseRef.current !== 'open' || commentsOpenRef.current || pendingSwitchRef.current) return false;
    const baseSwitchOffset = isSwitchingRef.current ? interruptSwitchAnimation() : 0;
    if (!isSwitchingRef.current) cancelActiveAnimations();
    flushGestureFrame();
    const gesture: GestureState = {
      id,
      x,
      y,
      dx: 0,
      dy: 0,
      mode: baseSwitchOffset ? 'switch' : 'pending',
      startedAtTop: canBeginCloseGesture(),
      source,
      baseSwitchOffset
    };
    dragRef.current = gesture;
    isGestureActiveRef.current = true;
    setGestureModeAttribute(gesture.mode);
    return true;
  };

  const updateGesture = (
    id: number,
    x: number,
    y: number,
    preventDefault: () => void,
    capturePointer?: () => void
  ) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.id !== id || phaseRef.current !== 'open' || commentsOpenRef.current) return;
    const dx = x - gesture.x;
    const dy = y - gesture.y;
    gesture.dx = dx;
    gesture.dy = dy;

    if (gesture.mode === 'pending') {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const direction = dx < 0 ? 1 : -1;
      if (onSwitchRef.current && canSwitchDirection(direction) && absX > (gesture.source === 'touch' ? 7 : 18) && absX > absY * (gesture.source === 'touch' ? 1.08 : 1.35)) {
        preventDefault();
        capturePointer?.();
        setGestureMode(gesture, 'switch');
        switchByGesture(gesture);
        return;
      }
      const closeSlop = gesture.source === 'touch' ? 7 : 24;
      const closeRatio = gesture.source === 'touch' ? 1.08 : 1.35;
      if (gesture.startedAtTop && dy > closeSlop && absY > absX * closeRatio && canBeginCloseGesture()) {
        preventDefault();
        capturePointer?.();
        setGestureMode(gesture, 'close');
        closeByGesture(dy);
      }
      return;
    }

    preventDefault();
    if (gesture.mode === 'switch') switchByGesture(gesture);
    else closeByGesture(Math.max(0, dy));
  };

  const finishGesture = (id: number, cancelled = false, x?: number, y?: number) => {
    const gesture = dragRef.current;
    if (!gesture || gesture.id !== id) return;
    if (typeof x === 'number') gesture.dx = x - gesture.x;
    if (typeof y === 'number') gesture.dy = y - gesture.y;
    const { dx, dy, mode } = gesture;
    dragRef.current = null;
    isGestureActiveRef.current = false;
    setGestureModeAttribute(null);

    if (cancelled) {
      if (mode === 'switch') restoreSwitchGesture();
      if (mode === 'close') restoreCloseGesture();
      return;
    }

    const switchOffset = gesture.baseSwitchOffset + dx;
    if (mode === 'switch' && Math.abs(switchOffset) > 86) {
      const direction = switchOffset < 0 ? 1 : -1;
      if (canSwitchDirection(direction)) finishSwitchGesture(direction);
      else restoreSwitchGesture();
      return;
    }
    if (mode === 'switch') {
      restoreSwitchGesture();
      return;
    }

    const closeThreshold = window.matchMedia('(max-width: 760px)').matches ? 150 : 210;
    if (mode === 'close' && dy > closeThreshold) {
      onCloseRef.current();
      return;
    }
    if (mode === 'close') restoreCloseGesture();
  };

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || ignoredGestureTarget(event.target)) return;
      const touch = event.touches[0];
      beginGesture('touch', -1, touch.clientX, touch.clientY);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      updateGesture(-1, touch.clientX, touch.clientY, () => event.preventDefault());
    };

    const finishTouch = () => {
      finishGesture(-1);
    };

    const cancelTouch = () => {
      finishGesture(-1, true);
    };

    overlay.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    overlay.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    overlay.addEventListener('touchend', finishTouch, { passive: true, capture: true });
    overlay.addEventListener('touchcancel', cancelTouch, { passive: true, capture: true });
    return () => {
      overlay.removeEventListener('touchstart', onTouchStart, { capture: true });
      overlay.removeEventListener('touchmove', onTouchMove, { capture: true });
      overlay.removeEventListener('touchend', finishTouch, { capture: true });
      overlay.removeEventListener('touchcancel', cancelTouch, { capture: true });
    };
  }, []);

  useEffect(() => () => {
    cancelActiveAnimations();
    if (gestureFrameRef.current !== null) {
      cancelAnimationFrame(gestureFrameRef.current);
      gestureFrameRef.current = null;
    }
    lastGestureWriterRef.current = null;
    dragRef.current = null;
    pendingSwitchRef.current = null;
    isGestureActiveRef.current = false;
    isSwitchingRef.current = false;
    setGestureModeAttribute(null);
    document.body.classList.remove('viewer-lock');
  }, []);

  const toggleLike = async () => {
    if (likePending) return;
    const previous = { likedByMe: item.likedByMe, likeCount: item.likeCount };
    const nextLiked = !item.likedByMe;
    const optimisticCount = Math.max(0, item.likeCount + (nextLiked ? 1 : -1));
    setLikePending(true);
    onPatched({ ...item, likedByMe: nextLiked, likeCount: optimisticCount });
    try {
      const result = await setLike(item.id, nextLiked);
      onPatched({ ...item, likedByMe: result.likedByMe, likeCount: result.likeCount });
    } catch {
      onPatched({ ...item, ...previous });
      onNotice?.('喜欢状态更新失败，请稍后再试。');
    } finally {
      setLikePending(false);
    }
  };

  const printDocument = async () => {
    if (printing) return;
    setPrinting(true);
    try {
      await openPrintHandoff(item.id);
    } catch (error) {
      onNotice?.(printErrorText(error));
      setPrinting(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      id="lightbox"
      className={`visible phase-${phase}`}
      onPointerDown={(event) => {
        if (event.pointerType === 'touch') return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (ignoredGestureTarget(event.target)) return;
        const targetElement = event.target as Element;
        if (!targetElement.closest('[data-gesture-stage]')) return;
        beginGesture('pointer', event.pointerId, event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        updateGesture(
          event.pointerId,
          event.clientX,
          event.clientY,
          () => event.preventDefault(),
          () => {
            try {
              (event.currentTarget as Element).setPointerCapture(event.pointerId);
            } catch {
              // Some browsers decline capture once native scrolling has begun.
            }
          }
        );
      }}
      onPointerUp={(event) => {
        finishGesture(event.pointerId, false, event.clientX, event.clientY);
      }}
      onPointerCancel={(event) => {
        finishGesture(event.pointerId, true);
      }}
    >
      <div ref={scrimRef} className="lightbox-scrim" />

      <button
        className={`lightbox-like lightbox-control ${item.likedByMe ? 'liked' : ''} ${likePending ? 'is-pending' : ''}`}
        type="button"
        onClick={() => void toggleLike()}
        aria-label="Like"
        aria-pressed={item.likedByMe}
      >
        <Heart size={21} fill="currentColor" strokeWidth={0} />
        <span>{item.likeCount}</span>
      </button>

      <button className="lightbox-comment lightbox-control" type="button" onClick={() => setCommentsOpen((open) => !open)} aria-label="Comments" aria-pressed={commentsOpen}>
        <MessageCircle size={18} strokeWidth={2.1} />
      </button>

      <div className="lightbox-top-actions">
        <a className="icon-btn lightbox-control" href={absoluteApiUrl(item.downloadUrl)} download aria-label="Download">
          <Download size={18} strokeWidth={2} />
        </a>
        <button className={`icon-btn lightbox-control ${printing ? 'is-loading' : ''}`} type="button" onClick={() => void printDocument()} disabled={printing} aria-label="Print">
          {printing ? <LoaderCircle className="spin-icon" size={18} strokeWidth={2} /> : <Printer size={18} strokeWidth={2} />}
        </button>
        <button className="icon-btn lightbox-control" type="button" onClick={onClose} aria-label="Close">
          <X size={20} strokeWidth={2.1} />
        </button>
      </div>

      {onSwitch && (
        <>
          <button className="icon-btn lightbox-nav lightbox-prev lightbox-control" type="button" onClick={() => onSwitch(-1)} aria-label="Previous">
            <ChevronLeft size={22} strokeWidth={1.9} />
          </button>
          <button className="icon-btn lightbox-nav lightbox-next lightbox-control" type="button" onClick={() => onSwitch(1)} aria-label="Next">
            <ChevronRight size={22} strokeWidth={1.9} />
          </button>
        </>
      )}

      <div ref={stageRef} data-gesture-stage className="lightbox-stage">
        <div ref={trackRef} className="lightbox-track">
          {[
            { item: slides.prev, slot: 'prev' as const },
            { item: slides.current, slot: 'current' as const },
            { item: slides.next, slot: 'next' as const }
          ].map((slide) => (
            <PreviewSlide
              key={slide.item ? slide.item.id : `empty-${slide.slot}`}
              item={slide.item}
              slot={slide.slot}
              readerRef={slide.slot === 'current' ? readerRef : undefined}
              active={slide.slot === 'current'}
              preload={slide.slot !== 'current'}
            />
          ))}
        </div>
      </div>

      <div className="lightbox-meta">
        <strong>{displayFilename(item.filename)}</strong>
        <span>{previewCountLabel(item)} / {prettyBytes(item.sizeBytes)}</span>
      </div>

      <CommentsFrame documentId={item.id} visible={commentsOpen} onClose={() => setCommentsOpen(false)} />
    </div>
  );
}

function PreviewSlide({
  item,
  slot,
  readerRef,
  active,
  preload
}: {
  item: DocumentItem | null;
  slot: 'prev' | 'current' | 'next';
  readerRef?: RefObject<HTMLDivElement | null>;
  active: boolean;
  preload: boolean;
}) {
  return (
    <section className={`lightbox-slide lightbox-slide-${slot}`} aria-hidden={slot === 'current' ? undefined : true}>
      {item ? (
        <DocumentPreview key={item.id} item={item} readerRef={readerRef} active={active} preload={preload} />
      ) : (
        <div className="document-reader document-reader-empty" />
      )}
    </section>
  );
}

function trackTransform(offsetPx: number, viewportWidth = window.innerWidth): string {
  return `translate3d(${offsetPx - viewportWidth}px, 0, 0)`;
}

function previewCountLabel(item: DocumentItem): string {
  const count = item.previewCount ?? item.pageCount;
  if (!count) return 'Preparing preview';
  if (item.previewKind === 'xlsx-table') return `${count} sheets`;
  if (item.previewKind === 'docx-html') return 'HTML preview';
  if (item.previewKind === 'pptx-pdf') return `${count} slides`;
  return `${count} pages`;
}

function printErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('print_handoff_not_configured')) return '打印服务还没有配置 609 handoff secret。';
  if (message.includes('document_not_ready')) return '文档预览还没有准备好，稍后再试。';
  if (message.includes('print_session_failed')) return '609 打印会话创建失败。';
  if (message.includes('print_upload_failed')) return '发送到 609 的文件上传失败。';
  if (message.includes('print_notify_failed')) return '609 打印通知失败。';
  return '发送到 609 失败，请稍后重试。';
}
