import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { LayerId } from '../config';
import { registry } from '../layers';
import { useMapStore } from '../store';
import type { LayerStatus } from '../store';
import { displayOrder, dropIndex, stepTarget, storeIndexFromDisplay } from './layerOrder';
import './LayerPanel.css';

interface DragState {
  id: LayerId;
  /** ドラッグ中の行を除いた並びの中での挿入位置 */
  over: number;
  /** 掴んだ位置からの縦方向の移動量（px） */
  dy: number;
}

interface DragRef {
  id: LayerId;
  startY: number;
  from: number;
  /** ドラッグ中の行を除いた各行の中心Y */
  centers: number[];
}

const STATUS_TEXT: Partial<Record<LayerStatus, string>> = {
  idle: '読み込み待ち',
  loading: '読み込み中…',
  error: '読み込み失敗',
};

/** レイヤーの一覧。最上段が先頭。並べ替え・表示切替・単独表示を受け持つ。 */
export default function LayerPanel() {
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const status = useMapStore((s) => s.status);
  const moveLayer = useMapStore((s) => s.moveLayer);
  const setVisible = useMapStore((s) => s.setVisible);
  const setSolo = useMapStore((s) => s.setSolo);

  const shown = useMemo(() => displayOrder(order), [order]);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<LayerId, HTMLLIElement>());
  const dragRef = useRef<DragRef | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState('');
  /** 並べ替え後に戻すフォーカス（`<id>:<部品>`）。行がDOM上で動くとフォーカスが外れるため。 */
  const refocus = useRef<string | null>(null);

  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    refocus.current = null;
    rootRef.current?.querySelector<HTMLElement>(`[data-focus-key="${key}"]`)?.focus();
  }, [order]);

  const announceMove = useCallback((id: LayerId) => {
    const pos = displayOrder(useMapStore.getState().order).indexOf(id) + 1;
    setAnnounce(`${registry[id].label}を上から${pos}段目へ移動`);
  }, []);

  const step = useCallback(
    (id: LayerId, dir: -1 | 1, part: 'up' | 'down' | 'grip') => {
      const to = stepTarget(useMapStore.getState().order, id, dir);
      if (to === null) return;
      refocus.current = `${id}:${part}`;
      moveLayer(id, to);
      announceMove(id);
    },
    [moveLayer, announceMove],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  const onGripPointerDown = (e: PointerEvent<HTMLButtonElement>, id: LayerId) => {
    if (e.button !== 0 || dragRef.current) return;
    const from = shown.indexOf(id);
    const centers = shown
      .filter((x) => x !== id)
      .map((x) => {
        const r = rowEls.current.get(x)!.getBoundingClientRect();
        return r.top + r.height / 2;
      });
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { id, startY: e.clientY, from, centers };
    setDrag({ id, over: from, dy: 0 });
  };

  const onGripPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ id: d.id, over: dropIndex(d.centers, e.clientY), dy: e.clientY - d.startY });
  };

  const onGripPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const over = dropIndex(d.centers, e.clientY);
    endDrag();
    if (over !== d.from) {
      refocus.current = `${d.id}:grip`;
      moveLayer(d.id, storeIndexFromDisplay(shown.length, over));
      announceMove(d.id);
    }
  };

  const onGripKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: LayerId) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      step(id, e.key === 'ArrowUp' ? -1 : 1, 'grip');
    }
  };

  // Esc でドラッグを取り消す
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') endDrag();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging, endDrag]);

  // 挿入位置の目印を付ける行
  const rest = drag ? shown.filter((x) => x !== drag.id) : [];
  const dropBefore = drag && drag.over < rest.length ? rest[drag.over] : null;
  const dropAfter = drag && drag.over >= rest.length ? rest[rest.length - 1] : null;

  return (
    <div className="lp" ref={rootRef}>
      <div className="lp-head">
        <span className="lp-title">レイヤー</span>
        <span className="lp-hint">上が最上段</span>
      </div>

      {solo && (
        <button type="button" className="lp-back" onClick={() => setSolo(null)}>
          積層表示に戻る
        </button>
      )}

      <ol className="lp-list">
        {shown.map((id, i) => {
          const mod = registry[id];
          const st = status[id];
          const isSolo = solo === id;
          const isDragged = drag?.id === id;
          const cls = [
            'lp-row',
            !visible[id] && 'lp-hidden',
            isSolo && 'lp-solo',
            isDragged && 'lp-dragging',
            dropBefore === id && 'lp-drop-before',
            dropAfter === id && 'lp-drop-after',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={id}
              className={cls}
              ref={(el) => {
                if (el) rowEls.current.set(id, el);
                else rowEls.current.delete(id);
              }}
              style={isDragged ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              <div className="lp-line">
                <button
                  type="button"
                  className="lp-grip"
                  data-focus-key={`${id}:grip`}
                  aria-label={`${mod.label}を並べ替え（ドラッグ、または上下キー）`}
                  title="ドラッグ、または上下キーで並べ替え"
                  onPointerDown={(e) => onGripPointerDown(e, id)}
                  onPointerMove={onGripPointerMove}
                  onPointerUp={onGripPointerUp}
                  onPointerCancel={endDrag}
                  onKeyDown={(e) => onGripKeyDown(e, id)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <label className="lp-name">
                  <input
                    type="checkbox"
                    checked={visible[id]}
                    onChange={(e) => setVisible(id, e.target.checked)}
                    data-focus-key={`${id}:visible`}
                  />
                  <span>{mod.label}</span>
                </label>
                <button
                  type="button"
                  className="lp-icon"
                  data-focus-key={`${id}:up`}
                  aria-label={`${mod.label}を1段上へ`}
                  aria-disabled={i === 0}
                  onClick={() => step(id, -1, 'up')}
                >
                  <span aria-hidden="true">▲</span>
                </button>
                <button
                  type="button"
                  className="lp-icon"
                  data-focus-key={`${id}:down`}
                  aria-label={`${mod.label}を1段下へ`}
                  aria-disabled={i === shown.length - 1}
                  onClick={() => step(id, 1, 'down')}
                >
                  <span aria-hidden="true">▼</span>
                </button>
              </div>

              <div className="lp-line lp-sub">
                <button
                  type="button"
                  className="lp-solo-btn"
                  aria-pressed={isSolo}
                  onClick={() => setSolo(isSolo ? null : id)}
                >
                  {isSolo ? '単独表示中' : '単独表示'}
                </button>
                {STATUS_TEXT[st] && (
                  <span className={`lp-status lp-status-${st}`} role={st === 'error' ? 'alert' : 'status'}>
                    {STATUS_TEXT[st]}
                  </span>
                )}
              </div>

              {mod.legend.length > 0 && (
                <ul className="lp-legend">
                  {mod.legend.map((l) => (
                    <li key={l.label}>
                      <span className="lp-swatch" style={{ background: `rgb(${l.color.join(',')})` }} />
                      {l.label}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      <div className="lp-sr" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
