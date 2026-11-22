/**
 * 浸水想定の格子（洪水・高潮 × 深さ・継続時間）。標高と同じ 50 m 格子（720×720、行は北から南、列は西から東）。
 * 純粋な計算（読み込みの fetch と deck.gl の描画は `../flood.ts`）。
 */
import { pointInCircle } from '../../lib/circleClip';
import type { Circle } from '../../lib/circleClip';
import { gridCell } from '../../lib/grid';
import { isUsableLine, lineLength, lineTouchesBox, pointAt } from '../../lib/section';
import type { LayerOptions } from '../../config';
import type { ProbeValue, SectionLine, SectionSeries } from '../../types';
import { NONE, OUTSIDE, checkRanksMeta, classAt, colorOf, depthLabel, floodScheme, labelOf, riverDurationLabel, tideDurationLabel } from './classes';
import type { FloodRanksMeta, FloodScheme, RGB } from './classes';

export interface FloodMeta extends FloodRanksMeta {
  width: number;
  height: number;
  cellSize: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  files: { riverDepth: string; tideDepth: string; riverDuration: string; tideDuration: string };
}

/** 4つの格子（Uint8）。値は 0 = 浸水なし、1〜、255 = 23区の外。 */
export interface FloodData {
  width: number;
  height: number;
  cellSize: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  riverDepth: Uint8Array;
  tideDepth: Uint8Array;
  riverDuration: Uint8Array;
  tideDuration: Uint8Array;
  /** subset の結果のとき、切り出した円。この円の外のセルは 255（23区の外と同じ）にしてある */
  clip?: Circle;
}

/** flood.json と4つの bin から作る。バイト数とランクの表が合わなければ例外。 */
export function buildFloodData(meta: FloodMeta, bins: { riverDepth: ArrayBuffer; tideDepth: ArrayBuffer; riverDuration: ArrayBuffer; tideDuration: ArrayBuffer }): FloodData {
  const mismatch = checkRanksMeta(meta);
  if (mismatch) throw new Error(`flood.json のランクの表が、画面の定義と合いません：${mismatch}`);
  const n = meta.width * meta.height;
  for (const [k, b] of Object.entries(bins))
    if (b.byteLength !== n) throw new Error(`flood の ${k} のサイズが ${meta.width}x${meta.height} Uint8 と合いません`);
  const { width, height, cellSize, minX, minY, maxX, maxY } = meta;
  return {
    width,
    height,
    cellSize,
    minX,
    minY,
    maxX,
    maxY,
    riverDepth: new Uint8Array(bins.riverDepth),
    tideDepth: new Uint8Array(bins.tideDepth),
    riverDuration: new Uint8Array(bins.riverDuration),
    tideDuration: new Uint8Array(bins.tideDuration),
  };
}

/** 想定と見るもの（options）に対する、各セルの段の位置を読む関数が使う、2つの格子。 */
function gridsOf(data: FloodData, scheme: FloodScheme): [Uint8Array, Uint8Array] {
  return scheme.view === 'depth' ? [data.riverDepth, data.tideDepth] : [data.riverDuration, data.tideDuration];
}

/** セル i の段の位置（0 = 浸水なし、1〜）。23区の外は null。 */
export function positionAt(data: FloodData, scheme: FloodScheme, i: number): number | null {
  const [r, t] = gridsOf(data, scheme);
  return scheme.position(r[i], t[i]);
}

export function schemeOf(options: Pick<LayerOptions, 'floodScenario' | 'floodView'>): FloodScheme {
  return floodScheme(options.floodScenario, options.floodView);
}

/* ---------- 画像 ---------- */

const images = new WeakMap<FloodData, Map<FloodScheme, ImageData>>();

/** 想定と見るものに対する、格子の画像（RGBA。23区の外は透明）。データと組ごとに1回だけ作る。 */
export function floodImage(data: FloodData, scheme: FloodScheme): ImageData {
  let byScheme = images.get(data);
  if (!byScheme) images.set(data, (byScheme = new Map()));
  let img = byScheme.get(scheme);
  if (!img) {
    img = new ImageData(floodPixels(data, scheme), data.width, data.height);
    byScheme.set(scheme, img);
  }
  return img;
}

/** 格子 → RGBA のバイト列。 */
export function floodPixels(data: FloodData, scheme: FloodScheme): Uint8ClampedArray<ArrayBuffer> {
  const n = data.width * data.height;
  const out = new Uint8ClampedArray(new ArrayBuffer(n * 4));
  // 位置 → 色は、段の数だけなので、先に引いておく。
  const palette: RGB[] = [scheme.none.color, ...scheme.classes.map((c) => c.color)];
  for (let i = 0; i < n; i++) {
    const p = positionAt(data, scheme, i);
    if (p === null) continue; // 23区の外は透明
    const c = palette[p] ?? scheme.none.color;
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return out;
}

/* ---------- 切り出し ---------- */

/**
 * 円を囲む正方形の範囲を、格子のセルに合わせて切り出す。セルの中心が円の外（縁の上は中）のセルは 255（23区の外と同じ）にする。
 * 円が格子と重ならないときは、範囲内のいちばん近いセル1個（255）の格子にする（幅・高さを 0 にしない）。
 */
export function subsetFlood(data: FloodData, cx: number, cy: number, radius: number): FloodData {
  const { cellSize, width, height } = data;
  const valid = Number.isFinite(cx) && Number.isFinite(cy) && radius >= 0;
  const rawC0 = valid ? Math.floor((cx - radius - data.minX) / cellSize) : 0;
  const rawC1 = valid ? Math.floor((cx + radius - data.minX) / cellSize) : -1;
  const rawR0 = valid ? Math.floor((data.maxY - (cy + radius)) / cellSize) : 0;
  const rawR1 = valid ? Math.floor((data.maxY - (cy - radius)) / cellSize) : -1;
  const overlaps = rawC1 >= 0 && rawC0 <= width - 1 && rawR1 >= 0 && rawR0 <= height - 1;
  const c0 = Math.min(Math.max(rawC0, 0), width - 1);
  const r0 = Math.min(Math.max(rawR0, 0), height - 1);
  const c1 = overlaps ? Math.min(rawC1, width - 1) : c0;
  const r1 = overlaps ? Math.min(rawR1, height - 1) : r0;
  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const mk = () => new Uint8Array(w * h).fill(OUTSIDE);
  const out = { riverDepth: mk(), tideDepth: mk(), riverDuration: mk(), tideDuration: mk() };
  if (overlaps) {
    const r2 = radius * radius;
    for (let row = r0; row <= r1; row++) {
      const dy = data.maxY - (row + 0.5) * cellSize - cy;
      if (dy * dy > r2) continue;
      for (let col = c0; col <= c1; col++) {
        const dx = data.minX + (col + 0.5) * cellSize - cx;
        if (dx * dx + dy * dy > r2) continue;
        const from = row * width + col;
        const to = (row - r0) * w + (col - c0);
        out.riverDepth[to] = data.riverDepth[from];
        out.tideDepth[to] = data.tideDepth[from];
        out.riverDuration[to] = data.riverDuration[from];
        out.tideDuration[to] = data.tideDuration[from];
      }
    }
  }
  const minX = data.minX + c0 * cellSize;
  const maxY = data.maxY - r0 * cellSize;
  return { width: w, height: h, cellSize, minX, maxX: minX + w * cellSize, maxY, minY: maxY - h * cellSize, ...out, clip: { cx, cy, r: radius } };
}

/* ---------- 値（探針・集計） ---------- */

/** 地点 (x, y) を含むセルの添字。格子の外、切り出した円の外は null。 */
export function cellIndexAt(data: FloodData, x: number, y: number): number | null {
  if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return null;
  const c = gridCell(data, x, y);
  return c ? c.row * data.width + c.col : null;
}

/** 深さのランクの読み。23区の外は null。 */
function depthText(rank: number): string | null {
  return rank === OUTSIDE ? null : depthLabel(rank);
}

/** 継続時間のランクの読み。ランク 0 で深さが 0.5m 未満（ランク 1）のときは、継続時間の値がない理由を添える。 */
function durationText(rank: number, depthRank: number, label: (r: number) => string): string | null {
  if (rank === OUTSIDE) return null;
  if (rank !== NONE) return label(rank);
  if (depthRank === 1) return 'なし（浸水が 0.5m 未満）';
  return depthRank === OUTSIDE ? null : 'なし';
}

/**
 * 探針の値。切り替えにかかわらず、洪水の深さ・高潮の深さ・それぞれの継続時間の4つを、ランクの名前で返す。
 * 格子の外、23区の外は、値なし（null）。
 */
export function sampleFlood(data: FloodData, x: number, y: number): ProbeValue[] {
  const i = cellIndexAt(data, x, y);
  const rd = i === null ? OUTSIDE : data.riverDepth[i];
  const td = i === null ? OUTSIDE : data.tideDepth[i];
  const rt = i === null ? OUTSIDE : data.riverDuration[i];
  const tt = i === null ? OUTSIDE : data.tideDuration[i];
  return [
    { label: '洪水の深さ', value: depthText(rd) },
    { label: '高潮の深さ', value: depthText(td) },
    { label: '洪水の継続', value: durationText(rt, rd, riverDurationLabel) },
    { label: '高潮の継続', value: durationText(tt, td, tideDurationLabel) },
  ];
}

/** 段ごとの面積の割合（%）。23区内（格子の値が 255 でない）のセルだけを数える。 */
export interface ClassShare {
  position: number;
  label: string;
  color: RGB;
  cells: number;
  /** 全セルに対する割合（0〜100） */
  percent: number;
}

export function classShares(data: FloodData, scheme: FloodScheme): { total: number; shares: ClassShare[] } {
  const counts = new Array<number>(scheme.classes.length + 1).fill(0);
  let total = 0;
  const n = data.width * data.height;
  for (let i = 0; i < n; i++) {
    const p = positionAt(data, scheme, i);
    if (p === null) continue;
    counts[p]++;
    total++;
  }
  const shares = counts.map((cells, position) => ({
    position,
    label: labelOf(scheme, position),
    color: colorOf(scheme, position),
    cells,
    percent: total > 0 ? (100 * cells) / total : 0,
  }));
  return { total, shares };
}

/** 面積の割合の表示（小数1桁。0 でないのに 0.1% 未満なら「0.1% 未満」）。 */
export function percentText(p: number): string {
  if (p > 0 && p < 0.05) return '0.1% 未満';
  return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
}

/**
 * クローズアップの集計：円の中の面積を、段（深さか継続時間）ごとの割合で。割合が 0 の段は出さない。
 * 円の中に23区の外しかないときは、値なし。
 */
export function summarizeFlood(data: FloodData, options: LayerOptions): ProbeValue[] {
  const scheme = schemeOf(options);
  const { total, shares } = classShares(data, scheme);
  if (total === 0) return [{ label: scheme.title, value: null }];
  // 深い・長い段を先に。浸水なしは最後。
  const rows = shares
    .filter((s) => s.cells > 0)
    .sort((a, b) => (a.position === 0 ? 1 : b.position === 0 ? -1 : b.position - a.position))
    .map((s) => ({ label: s.label, value: percentText(s.percent) }));
  return rows;
}

/* ---------- 断面 ---------- */

/** 断面で値を取る間隔（m）。標高と同じ。 */
export const FLOOD_SECTION_STEP = 25;

/**
 * 線に沿った、段の位置の階段状の系列。値は段の位置（0 = 浸水なし、1〜）で、23区の外は null。
 * 同じ段が続く間は1つの段にまとめ、段の境目は隣り合う標本の中間に置く。
 * 縦軸は段のラベル（`ranks`）で読む。
 */
export function sectionFlood(data: FloodData, line: SectionLine, options: LayerOptions): SectionSeries {
  const scheme = schemeOf(options);
  const series: SectionSeries = {
    kind: 'series',
    label: scheme.view === 'depth' ? '浸水の深さ' : '浸水の継続',
    unit: '',
    points: [],
    domain: [0, scheme.classes.length],
    color: (v) => colorOf(scheme, Math.round(v)),
    ranks: scheme.classes.map((c, i) => ({ value: i + 1, short: c.short, label: c.label })),
  };
  if (!isUsableLine(line) || !lineTouchesBox(line, data)) return series;
  const len = lineLength(line);
  const valueAt = (d: number): number | null => {
    const { x, y } = pointAt(line, d);
    const i = cellIndexAt(data, x, y);
    return i === null ? null : positionAt(data, scheme, i);
  };
  const steps = Math.floor(len / FLOOD_SECTION_STEP);
  const samples: { d: number; v: number | null }[] = [];
  for (let i = 0; i <= steps; i++) samples.push({ d: i * FLOOD_SECTION_STEP, v: valueAt(i * FLOOD_SECTION_STEP) });
  if (len - steps * FLOOD_SECTION_STEP > 1e-9) samples.push({ d: len, v: valueAt(len) });

  // 同じ値が続く標本を1つの段にする。段は、始点（d = 0）から終点（d = 長さ）まで隙間なく続く。
  let start = 0;
  let from = 0;
  const pts = series.points;
  for (let k = 1; k <= samples.length; k++) {
    if (k < samples.length && samples[k].v === samples[start].v) continue;
    const to = k < samples.length ? (samples[k - 1].d + samples[k].d) / 2 : len;
    pts.push({ d: from, value: samples[start].v }, { d: to, value: samples[start].v });
    from = to;
    start = k;
  }
  return series;
}

/** 段の位置 → 名前（断面の読み取り用）。 */
export function positionLabel(options: Pick<LayerOptions, 'floodScenario' | 'floodView'>, position: number): string {
  return labelOf(schemeOf(options), position);
}

export { classAt };
