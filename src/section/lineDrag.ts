/**
 * 断面の線の端点（印）と線そのものを、全体の地図の上でつかんで動かす操作。
 * `installMarkDrag`（探針の印）と同じ作りで、つかめるのは「断面」で線があるときだけ。
 *
 * ポインタを押したとき、端点か線の上なら、その操作を視点の操作（deck.gl のコントローラ）には渡さず、線の移動にする。
 * それ以外は何もせず、これまでどおり視点の回転になる。離した後に来る click は、新しい線の始点と取り違えないよう止める。
 */
import { createFrameThrottle, MARK_CURSOR } from '../probe/markDrag';
import type { MarkCursor, Project } from '../probe/markDrag';
import type { rayFromPixel } from '../probe/ray';
import type { SectionLine } from '../types';
import { dragSection, hitSection } from './interaction';
import type { LineHeight, SectionGrab } from './interaction';

type Viewport = Parameters<typeof rayFromPixel>[0] & { project: Project };

export interface SectionDragHost {
  getViewport(): Viewport | null;
  /** つかめる状態（「断面」で、線がある）のときの、線と、表示中の段の高さ。そうでなければ null。 */
  getTarget(): { line: SectionLine; planes: number[]; heights: LineHeight[] } | null;
  /** つかんで動かした先の線を反映する。呼ぶ頻度は、描画のフレームに合わせて間引かれる。 */
  setLine(line: SectionLine): void;
  setCursor(c: MarkCursor | null): void;
}

export function installSectionDrag(el: HTMLElement, host: SectionDragHost): () => void {
  let grab: SectionGrab | null = null;
  let pointerId: number | null = null;
  let hovering = false;
  let current: SectionLine | null = null;
  const throttle = createFrameThrottle<SectionLine>((l) => host.setLine(l));

  const local = (e: MouseEvent | PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const hit = (e: MouseEvent | PointerEvent): SectionGrab | null => {
    const t = host.getTarget();
    const vp = host.getViewport();
    if (!t || !vp) return null;
    const { px, py } = local(e);
    return hitSection({ project: (p) => vp.project(p), viewport: vp, line: t.line, planes: t.planes, heights: t.heights, px, py });
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || grab) return;
    const g = hit(e);
    if (!g) return;
    grab = g;
    current = host.getTarget()?.line ?? null;
    pointerId = e.pointerId;
    e.stopPropagation(); // deck.gl のコントローラへ渡さない
    e.preventDefault();
    host.setCursor(MARK_CURSOR.dragging);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  const blockLegacy = (e: Event) => {
    if (grab) e.stopPropagation();
  };
  const onMove = (e: PointerEvent) => {
    if (!grab || e.pointerId !== pointerId || !current) return;
    const vp = host.getViewport();
    if (!vp) return;
    const { px, py } = local(e);
    const next = dragSection(vp, px, py, grab, current);
    if (next) {
      // 端点は、もう一方の端点を含む現在の線に対して決める。連続して動かすので、反映した線を次の基準にする。
      if (grab.kind !== 'body') current = next;
      throttle.push(next);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!grab || e.pointerId !== pointerId) return;
    throttle.flush();
    grab = null;
    pointerId = null;
    current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    hovering = hit(e) !== null;
    host.setCursor(hovering ? MARK_CURSOR.hover : null);
    const stop = (ev: Event) => ev.stopPropagation();
    el.addEventListener('click', stop, { capture: true, once: true });
    window.setTimeout(() => el.removeEventListener('click', stop, true), 0);
  };
  const onHover = (e: PointerEvent) => {
    if (grab || e.buttons !== 0) return;
    const over = hit(e) !== null;
    if (over !== hovering) {
      hovering = over;
      host.setCursor(over ? MARK_CURSOR.hover : null);
    }
  };
  const onLeave = () => {
    if (grab || !hovering) return;
    hovering = false;
    host.setCursor(null);
  };

  el.addEventListener('pointerdown', onDown, true);
  el.addEventListener('mousedown', blockLegacy, true);
  el.addEventListener('touchstart', blockLegacy, true);
  el.addEventListener('pointermove', onHover);
  el.addEventListener('pointerleave', onLeave);
  return () => {
    el.removeEventListener('pointerdown', onDown, true);
    el.removeEventListener('mousedown', blockLegacy, true);
    el.removeEventListener('touchstart', blockLegacy, true);
    el.removeEventListener('pointermove', onHover);
    el.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    throttle.cancel();
  };
}
