/**
 * 断面の線を引く・動かす操作の、純粋な計算。
 * - 線を引く手順（クリックで始点、もう一度クリックで終点、外をクリックで引き直し）
 * - 全体の地図の上のカーソルが、切り口の線のどこに近いか（右のグラフへの連動）
 * - 端点・線そのものをつかめるかの判定と、ドラッグで動かした後の線
 * DOM と deck.gl には依存しない（画面への投影は関数で受け取る）。
 */
import { EXTENT } from '../config';
import { lineLength } from '../lib/section';
import { dragProbePoint, hitProbeMark } from '../probe/markDrag';
import type { MarkGrab, Project } from '../probe/markDrag';
import { intersectHorizontalPlane, rayFromPixel } from '../probe/ray';
import type { SectionLine } from '../types';

type Pt = { x: number; y: number };

/** 線の最小の長さ（m）。これより短い線は引けない（同じ場所のクリックや、端点の重なりを避ける）。 */
export const MIN_SECTION_LENGTH = 300;

/* ---------- 線を引く手順 ---------- */

/** 線を引く途中の状態。start は、始点だけ置いて終点を待っている地点。 */
export interface DrawState {
  line: SectionLine | null;
  start: Pt | null;
}

/**
 * 平面の地点 p をクリックしたときの、次の状態（端点や線の上のクリックは、つかむ操作として別に扱う）。
 * - 始点を置いたあと：p が始点から MIN_SECTION_LENGTH 以上離れていれば、終点として線を決める。近すぎれば何もしない。
 * - それ以外（線がないとき、線があるとき）：p を新しい始点にする。線があれば消す（引き直し）。
 */
export function clickSection(state: DrawState, p: Pt): DrawState {
  if (state.start) {
    const { start } = state;
    if (Math.hypot(p.x - start.x, p.y - start.y) < MIN_SECTION_LENGTH) return state;
    return { line: { ax: start.x, ay: start.y, bx: p.x, by: p.y }, start: null };
  }
  return { line: null, start: { x: p.x, y: p.y } };
}

/** Esc：線も、置きかけの始点も消す。 */
export function clearSection(): DrawState {
  return { line: null, start: null };
}

/** 始点を置いたあとの、カーソルまでの線の下書き。 */
export function draftLine(start: Pt, cursor: Pt): SectionLine {
  return { ax: start.x, ay: start.y, bx: cursor.x, by: cursor.y };
}

/** URL クエリ `section=<ax>,<ay>,<bx>,<by>` の線。数値でない・4つでない・長さが MIN_SECTION_LENGTH 未満なら null。 */
export function sectionFromQuery(value: string | null): SectionLine | null {
  if (value === null) return null;
  const parts = value.split(',');
  if (parts.length !== 4 || parts.some((s) => s.trim() === '')) return null;
  const [ax, ay, bx, by] = parts.map(Number);
  const line = { ax, ay, bx, by };
  if (![ax, ay, bx, by].every(Number.isFinite)) return null;
  return lineLength(line) >= MIN_SECTION_LENGTH ? line : null;
}

/** 線を URL クエリの値（`section=` の右）にする。 */
export function sectionToQuery(line: SectionLine): string {
  return [line.ax, line.ay, line.bx, line.by].map((v) => Math.round(v)).join(',');
}

/* ---------- 画面上の位置と線 ---------- */

/** 切り口の線を投影するときの高さ。z は、線が載っている段の平面の高さ（つかんで動かすときの平面）、at は、投影する高さ。 */
export interface LineHeight {
  /** その高さの線が載っている段の平面の高さ */
  plane: number;
  /** 線を投影する高さ。段の平面（plane と同じ）か、その上に立てたグラフの中ほど・上端 */
  at: number;
}

type Scr = readonly [number, number];

/** 点 p から線分 ab までの距離と、線分の上の位置 t（0 = a、1 = b）。 */
function nearOnSegment(p: Scr, a: Scr, b: Scr): { dist: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return { dist: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

/**
 * 画素 (px, py) が、切り口の線（各高さに投影した線分のどれか）の近く（maxPx 以内）にあるときの、線に沿った距離（m）。
 * 複数の高さのうち、いちばん近いもの。近くなければ null。
 */
export function distanceAlongLine(opts: {
  project: Project;
  line: SectionLine;
  heights: readonly LineHeight[];
  px: number;
  py: number;
  maxPx: number;
}): { d: number; dist: number } | null {
  const { project, line, heights, px, py, maxPx } = opts;
  const len = lineLength(line);
  if (!(len > 0)) return null;
  let best: { d: number; dist: number } | null = null;
  for (const h of heights) {
    const a = project([line.ax, line.ay, h.at]);
    const b = project([line.bx, line.by, h.at]);
    const { dist, t } = nearOnSegment([px, py], [a[0], a[1]], [b[0], b[1]]);
    if (dist <= maxPx && (!best || dist < best.dist)) best = { d: t * len, dist };
  }
  return best;
}

/* ---------- つかんで動かす ---------- */

/** つかんだもの。端点（a か b）は、つかんだ段の高さ z と、つかんだ位置から印の中心までのずれ。線そのもの（body）は、つかんだときの地点 anchor と元の線。 */
export type SectionGrab =
  | { kind: 'a' | 'b'; grab: MarkGrab }
  | { kind: 'body'; plane: number; anchor: Pt; line: SectionLine };

/** 線そのものをつかめる、線からの距離（px）。線の太さ（2 px）と縁取りより少し広い。 */
const LINE_GRAB_PX = 6;

/**
 * 画素 (px, py) が、端点の印（各段の輪と、それらを貫く垂直線）か、線そのものの上かを判定する。端点のほうを優先する。
 * 端点を探す高さは、段の平面の高さ planes。線そのものは heights（立てたグラフの中ほどや上端を含む）に投影して調べる。
 */
export function hitSection(opts: {
  project: Project;
  viewport: Parameters<typeof rayFromPixel>[0];
  line: SectionLine;
  planes: readonly number[];
  heights: readonly LineHeight[];
  px: number;
  py: number;
}): SectionGrab | null {
  const { project, viewport, line, planes, heights, px, py } = opts;
  const ga = hitProbeMark({ project, probe: { x: line.ax, y: line.ay }, zs: planes, px, py });
  const gb = hitProbeMark({ project, probe: { x: line.bx, y: line.by }, zs: planes, px, py });
  if (ga || gb) {
    const da = ga ? Math.hypot(ga.offset[0], ga.offset[1]) : Infinity;
    const db = gb ? Math.hypot(gb.offset[0], gb.offset[1]) : Infinity;
    return da <= db ? { kind: 'a', grab: ga as MarkGrab } : { kind: 'b', grab: gb as MarkGrab };
  }
  // 線そのもの：いちばん近い高さを求め、その段の平面に当たる地点を、動かす基準にする。
  let nearest: { h: LineHeight; dist: number } | null = null;
  for (const h of heights) {
    const a = project([line.ax, line.ay, h.at]);
    const b = project([line.bx, line.by, h.at]);
    const { dist } = nearOnSegment([px, py], [a[0], a[1]], [b[0], b[1]]);
    if (dist <= LINE_GRAB_PX && (!nearest || dist < nearest.dist)) nearest = { h, dist };
  }
  if (!nearest) return null;
  const hit = intersectHorizontalPlane(rayFromPixel(viewport, px, py), nearest.h.plane);
  if (!hit) return null;
  return { kind: 'body', plane: nearest.h.plane, anchor: { x: hit.x, y: hit.y }, line };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 線を (dx, dy) だけ平行に動かす。両端が描画範囲（EXTENT）に収まるよう、動かす量を制限する（形と向きは変わらない）。 */
export function translateLine(line: SectionLine, dx: number, dy: number): SectionLine {
  const lo = (min: number, a: number, b: number) => min - Math.min(a, b);
  const hi = (max: number, a: number, b: number) => max - Math.max(a, b);
  const mx = clamp(dx, lo(EXTENT.minX, line.ax, line.bx), hi(EXTENT.maxX, line.ax, line.bx));
  const my = clamp(dy, lo(EXTENT.minY, line.ay, line.by), hi(EXTENT.maxY, line.ay, line.by));
  return { ax: line.ax + mx, ay: line.ay + my, bx: line.bx + mx, by: line.by + my };
}

/**
 * つかんだものを、カーソルが画素 (px, py) にあるときの線にする。
 * 端点は、つかんだ位置と印のずれを保って動く（描画範囲に収める）。もう一方の端点に MIN_SECTION_LENGTH より近づく位置へは動かさない。
 * 線そのものは、つかんだ地点からのカーソルの動きのぶんだけ、平行に動く。視線が平面と平行なら null。
 */
export function dragSection(
  viewport: Parameters<typeof rayFromPixel>[0],
  px: number,
  py: number,
  grab: SectionGrab,
  current: SectionLine,
): SectionLine | null {
  if (grab.kind === 'body') {
    const hit = intersectHorizontalPlane(rayFromPixel(viewport, px, py), grab.plane);
    if (!hit) return null;
    return translateLine(grab.line, hit.x - grab.anchor.x, hit.y - grab.anchor.y);
  }
  const p = dragProbePoint(viewport, px, py, grab.grab);
  if (!p) return null;
  const next: SectionLine =
    grab.kind === 'a' ? { ...current, ax: p.x, ay: p.y } : { ...current, bx: p.x, by: p.y };
  return lineLength(next) < MIN_SECTION_LENGTH ? null : next;
}
