/**
 * 固定した探針の印（各段の輪と垂直線）をつかんで動かす操作。
 * 純粋な計算（つかんだかどうかの判定、画面上の位置から地点を求める処理、描画のフレームに合わせた間引き）と、
 * それらを DOM のポインタ操作につなぐ `installMarkDrag` からなる。
 */
import { EXTENT } from '../config';
import { intersectHorizontalPlane, rayFromPixel } from './ray';
import type { Vec3 } from './ray';

/** 輪の半径（px）。描画（probeMarkLayers）と同じ。つかめる範囲は、輪の縁取りと指のずれのぶん、これより少し広くとる。 */
export const RING_RADIUS_PX = 11;
const RING_GRAB_PX = RING_RADIUS_PX + 4;
/** 垂直線の中心から、つかめる範囲の幅の半分（px）。線の太さ（3 px）と縁取りより少し広い。 */
const LINE_GRAB_PX = 6;

type Pt = readonly [number, number];

/** 世界の点を画面の画素（左上原点）へ写す関数。 */
export type Project = (p: Vec3) => readonly number[];

/** 点 p から線分 ab までの距離。 */
function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 印をつかんだ結果。z は、つかんだ段の高さ。offset は、つかんだ画素から、その段の印の中心までのずれ（px）。 */
export interface MarkGrab {
  z: number;
  offset: [number, number];
}

/**
 * 画素 (px, py) が、固定した探針 probe の印の上かを判定する。印は、各段（高さ zs）の輪と、それらを貫く垂直線。
 * 輪の中心から RING_GRAB_PX 以内、または垂直線（いちばん下の輪からいちばん上の輪まで）から LINE_GRAB_PX 以内ならつかめる。
 * つかんだ段は、画面上でカーソルにいちばん近い輪の段（垂直線をつかんだときも同じ）。
 * つかめなければ null。
 */
export function hitProbeMark(opts: {
  project: Project;
  probe: { x: number; y: number };
  zs: readonly number[];
  px: number;
  py: number;
}): MarkGrab | null {
  const { project, probe, zs, px, py } = opts;
  if (zs.length === 0) return null;
  const centers = zs.map((z) => {
    const [x, y] = project([probe.x, probe.y, z]);
    return { z, x, y, d: Math.hypot(px - x, py - y) };
  });
  const nearest = centers.reduce((a, b) => (b.d < a.d ? b : a));
  const lowest = centers.reduce((a, b) => (b.z < a.z ? b : a));
  const highest = centers.reduce((a, b) => (b.z > a.z ? b : a));
  const onRing = nearest.d <= RING_GRAB_PX;
  const onLine = highest.z > lowest.z && distanceToSegment([px, py], [lowest.x, lowest.y], [highest.x, highest.y]) <= LINE_GRAB_PX;
  if (!onRing && !onLine) return null;
  return { z: nearest.z, offset: [nearest.x - px, nearest.y - py] };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * つかんだ印を、カーソルが画素 (px, py) にあるときの地点。つかんだときのずれを保つので、印は、つかんだ位置のままカーソルに付いてくる。
 * 高さ grab.z の平面と、視線との交点を、描画範囲（EXTENT）に収めたもの。視線が平面と平行なら null。
 */
export function dragProbePoint(
  viewport: Parameters<typeof rayFromPixel>[0],
  px: number,
  py: number,
  grab: MarkGrab,
): { x: number; y: number } | null {
  const hit = intersectHorizontalPlane(rayFromPixel(viewport, px + grab.offset[0], py + grab.offset[1]), grab.z);
  if (!hit) return null;
  return { x: clamp(hit.x, EXTENT.minX, EXTENT.maxX), y: clamp(hit.y, EXTENT.minY, EXTENT.maxY) };
}

/**
 * 値の更新を、描画のフレーム（requestAnimationFrame）に合わせて間引く。
 * `push` は最新の値を覚えるだけで、フレームごとに最後の値で1回だけ `apply` を呼ぶ。`flush` は、待っている値をすぐ適用する。
 */
export function createFrameThrottle<T>(
  apply: (v: T) => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  let pending: { v: T } | null = null;
  let id: number | null = null;
  const run = () => {
    id = null;
    if (!pending) return;
    const { v } = pending;
    pending = null;
    apply(v);
  };
  return {
    push(v: T) {
      pending = { v };
      if (id === null) id = raf(run);
    },
    flush() {
      if (id !== null) {
        caf(id);
        id = null;
      }
      run();
    },
    cancel() {
      if (id !== null) caf(id);
      id = null;
      pending = null;
    },
  };
}

/**
 * 印の上のカーソル。平面の上の既定のカーソル（視点を回せる手のひら）とは違う形にして、印だけは別の操作（位置を動かす）だと分かるようにする。
 */
export const MARK_CURSOR = { hover: 'move', dragging: 'grabbing' } as const;
export type MarkCursor = (typeof MARK_CURSOR)[keyof typeof MARK_CURSOR];

/** installMarkDrag に渡す、状態の読み書き。 */
export interface MarkDragHost {
  /** 現在の画面の変換（描画の補間中なら、補間中のもの）。まだなければ null。 */
  getViewport(): (Parameters<typeof rayFromPixel>[0] & { project: Project }) | null;
  /** 固定中の探針と、表示中の段の高さ。固定していなければ null。 */
  getMarks(): { probe: { x: number; y: number }; zs: number[] } | null;
  /** つかんで動かした先の地点を反映する。呼ぶ頻度は、描画のフレームに合わせて間引かれる。 */
  setPoint(p: { x: number; y: number }): void;
  /** カーソルの形を変える：印の上（つかめる）、つかんで動かしている間、それ以外（null。視点の操作の形に戻す）。 */
  setCursor(c: MarkCursor | null): void;
}

/**
 * el の中の描画領域で、印をつかんで動かせるようにする。解除関数を返す。
 *
 * ポインタを押したとき、印の上なら、その操作を視点の操作（deck.gl のコントローラ）には渡さず、印の移動にする。
 * 印の上でなければ何もせず、これまでどおり視点の回転になる。
 * 押している間は、window でポインタの移動を追う（el の外へ出ても続く）。離したときに、待っている最後の地点を反映する。
 * 印をつかんで離した後に来る click は、平面の外のクリックと取り違えて固定を解除しないよう、止める。
 */
export function installMarkDrag(el: HTMLElement, host: MarkDragHost): () => void {
  let grab: MarkGrab | null = null;
  let pointerId: number | null = null;
  let hovering = false;
  const throttle = createFrameThrottle<{ x: number; y: number }>((p) => host.setPoint(p));

  const local = (e: MouseEvent | PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };
  const hit = (e: MouseEvent | PointerEvent) => {
    const marks = host.getMarks();
    const vp = host.getViewport();
    if (!marks || !vp) return null;
    const { px, py } = local(e);
    return hitProbeMark({ project: (p) => vp.project(p), probe: marks.probe, zs: marks.zs, px, py });
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || grab) return;
    const g = hit(e);
    if (!g) return;
    grab = g;
    pointerId = e.pointerId;
    e.stopPropagation(); // deck.gl のコントローラへ渡さない
    e.preventDefault();
    host.setCursor(MARK_CURSOR.dragging);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  // 旧来のマウス・タッチのイベントを使う入力にも、同じ操作を渡さない。
  const blockLegacy = (e: Event) => {
    if (grab) e.stopPropagation();
  };
  const onMove = (e: PointerEvent) => {
    if (!grab || e.pointerId !== pointerId) return;
    const vp = host.getViewport();
    if (!vp) return;
    const { px, py } = local(e);
    const p = dragProbePoint(vp, px, py, grab);
    if (p) throttle.push(p);
  };
  const onUp = (e: PointerEvent) => {
    if (!grab || e.pointerId !== pointerId) return;
    throttle.flush();
    grab = null;
    pointerId = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    // 離した位置が、まだ印の上ならつかめる形に戻す。
    hovering = hit(e) !== null;
    host.setCursor(hovering ? MARK_CURSOR.hover : null);
    // 続けて来る click を止める（すぐ後の1回だけ）。
    const stop = (ev: Event) => ev.stopPropagation();
    el.addEventListener('click', stop, { capture: true, once: true });
    window.setTimeout(() => el.removeEventListener('click', stop, true), 0);
  };
  // 印の上にカーソルが来たら、つかめることが分かる形にする。
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
