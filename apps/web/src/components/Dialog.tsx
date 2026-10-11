import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './Dialog.module.css';

interface DialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly busy?: boolean;
}

export function Dialog({ open, title, onClose, children, busy = false }: DialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus], button, input, select, textarea');
      first?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [busy, onClose, open]);

  if (!open) return null;
  return (
    <div className={styles.backdrop} role="presentation">
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={styles.header}>
          <div>
            <span className={styles.kicker}>REELFORGE / ACTION</span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className={styles.closeButton} type="button" aria-label="Đóng hộp thoại" onClick={onClose} disabled={busy}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
