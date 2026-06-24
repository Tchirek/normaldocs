import { Download, LoaderCircle, Printer, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  visible: boolean;
  count: number;
  total: number;
  deleteDisabled?: boolean;
  printVisible: boolean;
  onClear: () => void;
  onSelectAll: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onPrint: () => Promise<void> | void;
}

export function SelectionBar({ visible, count, total, deleteDisabled = false, printVisible, onClear, onSelectAll, onDownload, onDelete, onPrint }: Props) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!printVisible) setPrinting(false);
  }, [printVisible]);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const beginDeleteHold = () => {
    if (deleteDisabled || count === 0) return;
    firedRef.current = false;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      onDelete();
      clearTimer();
    }, 3000);
  };

  const endDeleteHold = () => {
    clearTimer();
  };

  const handlePrint = async () => {
    if (!printVisible || printing) return;
    setPrinting(true);
    try {
      await onPrint();
    } catch {
      setPrinting(false);
    }
  };

  return (
    <div id="selection-dock" className={visible ? 'visible' : ''}>
      <button
        className={`selection-print-button ${printVisible ? 'visible' : ''} ${printing ? 'is-loading' : ''}`}
        type="button"
        onClick={() => void handlePrint()}
        disabled={!printVisible || printing}
        aria-label="Print at 609"
        title="Print at 609"
      >
        {printing ? <LoaderCircle className="spin-icon" size={20} strokeWidth={2.05} /> : <Printer size={20} strokeWidth={2.05} />}
      </button>
      <div id="selection-bar" aria-label="Selection toolbar">
        <button
          className="selection-count"
          type="button"
          onClick={onSelectAll}
          title={count === total && total > 0 ? 'Restore previous selection' : 'Select all'}
          aria-label={count === total && total > 0 ? 'Clear selected all state' : 'Select all documents'}
        >
          <span className="selection-count-current">{count}</span>
          <span className="selection-count-total">{total}</span>
        </button>
        <button className="selection-action" type="button" onClick={onDownload} disabled={count === 0} aria-label="Download selected">
          <Download size={17} strokeWidth={2.1} />
        </button>
        <button
          className="selection-action selection-close-action"
          type="button"
          onPointerDown={beginDeleteHold}
          onPointerUp={endDeleteHold}
          onPointerCancel={endDeleteHold}
          onPointerLeave={endDeleteHold}
          onClick={(event) => {
            if (firedRef.current) {
              event.preventDefault();
              firedRef.current = false;
              return;
            }
            onClear();
          }}
          aria-label="Exit selection"
          title="Hold for 3 seconds to delete"
        >
          <X size={18} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}
