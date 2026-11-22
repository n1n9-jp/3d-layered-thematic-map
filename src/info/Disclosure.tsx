import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * 開閉できる見出し（アコーディオン）。見出しは button 要素で、aria-expanded が付く。閉じているあいだは、中身をDOMに置かない。
 * 開閉の状態は呼び出し側（store）が持つ。scrollIntoView を付けると、開いたときに見出しが見える位置までスクロールする。
 */
export default function Disclosure({
  id,
  open,
  onToggle,
  title,
  testId,
  scrollIntoView = false,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  testId: string;
  scrollIntoView?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open && scrollIntoView) root.current?.scrollIntoView({ block: 'start' });
  }, [open, scrollIntoView]);
  return (
    <section className="acc" data-testid={testId} data-open={open} ref={root}>
      <button type="button" className="acc-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={onToggle} data-testid={`${testId}-toggle`}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
      </button>
      {open && (
        <div id={`${id}-body`} className="acc-body" data-testid={`${testId}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}
