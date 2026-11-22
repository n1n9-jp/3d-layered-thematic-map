/**
 * 断面（2点を結ぶ線に沿った値の取り出し）の共通の関数。座標はローカルのメートル座標（x が東、y が北）。
 *
 * - 線 `SectionLine` は a→b の向きを持つ。「線に沿った距離」d は a からの距離（m）。
 * - 線の進行方向に向かって左が正、右が負（`offset`）。x が東・y が北なので、a→b が東向きなら北が左（正）。
 */
import type { SectionLine } from '../types';

/** 線の長さ（m）。 */
export function lineLength(line: SectionLine): number {
  return Math.hypot(line.bx - line.ax, line.by - line.ay);
}

/** 向きを逆にした線（b→a）。 */
export function reverseLine(line: SectionLine): SectionLine {
  return { ax: line.bx, ay: line.by, bx: line.ax, by: line.ay };
}

/** 線の両端と長さが有限で、長さが正か。 */
export function isUsableLine(line: SectionLine): boolean {
  const len = lineLength(line);
  return Number.isFinite(len) && len > 0;
}

/** 線に沿って a から距離 d（m）の地点。長さ 0 の線では a。d は線の外（負、長さ超え）でも延長線上の地点を返す。 */
export function pointAt(line: SectionLine, d: number): { x: number; y: number } {
  const len = lineLength(line);
  if (!(len > 0)) return { x: line.ax, y: line.ay };
  const t = d / len;
  return { x: line.ax + (line.bx - line.ax) * t, y: line.ay + (line.by - line.ay) * t };
}

export interface Projection {
  /** 垂線の足の、線に沿った距離（m）。a からの距離で、0 未満や長さ超えのときは線の外 */
  d: number;
  /** 地点から線への距離（m）に符号を付けたもの。進行方向に向かって左が正、右が負 */
  offset: number;
  /** 垂線の足の地点 */
  x: number;
  y: number;
}

/**
 * 地点 (px, py) から、線を延長した直線への垂線の足。足が線分の内側かは `0 <= d <= lineLength(line)` で判定する。
 * 長さ 0 の線では null。
 */
export function projectOnLine(line: SectionLine, px: number, py: number): Projection | null {
  const dx = line.bx - line.ax;
  const dy = line.by - line.ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const rx = px - line.ax;
  const ry = py - line.ay;
  const d = (rx * dx + ry * dy) / len + 0; // + 0 は、-0 を 0 に直す
  const offset = (dx * ry - dy * rx) / len + 0; // 進行方向と (a→p) の外積。左が正
  return { d, offset, x: line.ax + (dx / len) * d, y: line.ay + (dy / len) * d };
}

export interface LineSegmentHit {
  /** 線に沿った距離（m）。0〜長さ */
  d: number;
  /** 線分の上の位置（0 = 始点、1 = 終点） */
  u: number;
  x: number;
  y: number;
}

/**
 * 線（a→b、両端を含む）と線分 (x1, y1)→(x2, y2)（両端を含む）の交点。平行（重なりを含む）か、交わらなければ null。
 * 折れ線の頂点で二重に数えないために、呼び出し側は必要に応じて hit.u（線分の上の位置）の端を除く。
 */
export function intersectLineSegment(
  line: SectionLine,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): LineSegmentHit | null {
  const rx = line.bx - line.ax;
  const ry = line.by - line.ay;
  const sx = x2 - x1;
  const sy = y2 - y1;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const qx = x1 - line.ax;
  const qy = y1 - line.ay;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  if (!(t >= 0 && t <= 1 && u >= 0 && u <= 1)) return null;
  return { d: t * Math.hypot(rx, ry), u, x: line.ax + rx * t, y: line.ay + ry * t };
}

/**
 * 線を延長した直線が、リング（多角形の輪郭）の内側を通る区間を、線に沿った距離 [d0, d1]（0〜長さに収める）で返す。
 * 頂点を通るときも、辺に重なるときも、二重に数えない（頂点は、直線の左側にあるか否かで辺を分ける）。
 * リングは閉じていても、閉じていなくてもよい。
 */
export function lineInsideRing(line: SectionLine, ring: readonly (readonly [number, number])[]): [number, number][] {
  const rx = line.bx - line.ax;
  const ry = line.by - line.ay;
  const len = Math.hypot(rx, ry);
  const n = ring.length;
  if (!(len > 0) || n < 3) return [];
  // 頂点が直線のどちら側か（外積）。
  const side = new Float64Array(n);
  for (let i = 0; i < n; i++) side[i] = rx * (ring[i][1] - line.ay) - ry * (ring[i][0] - line.ax);
  const ts: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const si = side[i];
    const sj = side[j];
    if (si > 0 === sj > 0) continue;
    const k = sj / (sj - si); // 辺 j→i の上の、直線と交わる位置
    const px = ring[j][0] + (ring[i][0] - ring[j][0]) * k;
    const py = ring[j][1] + (ring[i][1] - ring[j][1]) * k;
    ts.push(((px - line.ax) * rx + (py - line.ay) * ry) / len); // 線に沿った距離
  }
  ts.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const d0 = Math.max(ts[i], 0);
    const d1 = Math.min(ts[i + 1], len);
    if (d1 > d0) out.push([d0, d1]);
  }
  return out;
}

/**
 * 線が、多角形（外周と穴のリングの列。偶奇規則）の内側を通る区間を、線に沿った距離 [d0, d1]（0〜長さに収める）で返す。
 * 穴の中は除く。距離の昇順。
 */
export function lineInsidePolygon(line: SectionLine, rings: readonly (readonly (readonly [number, number])[])[]): [number, number][] {
  const events: number[] = [];
  for (const ring of rings) for (const [a, b] of lineInsideRing(line, ring)) events.push(a, b);
  events.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < events.length; i += 2) if (events[i + 1] > events[i]) out.push([events[i], events[i + 1]]);
  return out;
}

/** 線が、軸に平行な長方形（縁を含む）と交わるか。 */
export function lineTouchesBox(
  line: SectionLine,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = line.bx - line.ax;
  const dy = line.by - line.ay;
  const clip = (p: number, q: number): boolean => {
    // 条件 p·t <= q
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, line.ax - box.minX) &&
    clip(dx, box.maxX - line.ax) &&
    clip(-dy, line.ay - box.minY) &&
    clip(dy, box.maxY - line.ay)
  );
}

/** 線と円（縁を含む）が重なる区間を、線に沿った距離 [d0, d1] で返す。重ならなければ null。 */
export function lineInsideCircle(
  line: SectionLine,
  cx: number,
  cy: number,
  r: number,
): [number, number] | null {
  const dx = line.bx - line.ax;
  const dy = line.by - line.ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  const ux = dx / len;
  const uy = dy / len;
  const fx = line.ax - cx;
  const fy = line.ay - cy;
  const b = fx * ux + fy * uy;
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const d0 = Math.max(-b - s, 0);
  const d1 = Math.min(-b + s, len);
  return d1 >= d0 ? [d0, d1] : null;
}

/* ------------------------------------------------------------------ */
/* 線の近くにある要素だけを調べる索引                                   */
/* ------------------------------------------------------------------ */

/** 既定のセルの大きさ（m）。道路の線分・250 m メッシュ・駅や施設の点のどれにも、これで十分に絞れる。 */
export const SECTION_CELL_SIZE = 250;
/** セル数の上限（範囲が広すぎるとき、セルを粗くする）。 */
const MAX_CELLS = 4_000_000;
/** セルの境界での取りこぼしを防ぐ余白（m）。 */
const EPS = 1e-6;

export interface BoxIndex {
  /**
   * 線から pad（m）以内にある可能性のある要素の添字を、1つずつ（重複なしで）visit に渡す。
   * pad = 0 なら、線が通るセルの要素。要素の bbox が線から離れていても、同じセルにあれば渡すことがある
   * （絞り込みの粗いふるい。厳密な判定は呼び出し側で行う）。
   */
  near(line: SectionLine, pad: number, visit: (item: number) => void): void;
  /** 要素の数（添字は 0 〜 count-1） */
  readonly count: number;
  /** 要素の bbox すべてを囲む範囲。要素がなければ null */
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * 要素の bbox（4つ組 [minX, minY, maxX, maxY] を要素の順に並べた配列）から、均等な格子の索引を作る。
 * 座標が有限でない要素は載せない（添字は配列のまま）。
 */
export function createBoxIndex(boxes: ArrayLike<number>, cellSize: number = SECTION_CELL_SIZE): BoxIndex {
  const n = Math.floor(boxes.length / 4);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const usable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x0 = boxes[4 * i];
    const y0 = boxes[4 * i + 1];
    const x1 = boxes[4 * i + 2];
    const y1 = boxes[4 * i + 3];
    if (!(Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(x1) && Number.isFinite(y1))) continue;
    usable[i] = 1;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  if (minX === Infinity) {
    return { near() {}, count: n, bounds: null };
  }
  const bounds = { minX, minY, maxX, maxY };
  // セルが多すぎるときは粗くする
  let cs = Math.max(cellSize, 1e-3);
  while (((maxX - minX) / cs + 1) * ((maxY - minY) / cs + 1) > MAX_CELLS) cs *= 2;
  const nx = Math.floor((maxX - minX) / cs) + 1;
  const ny = Math.floor((maxY - minY) / cs) + 1;
  const col = (x: number) => Math.floor((x - minX) / cs);
  const row = (y: number) => Math.floor((y - minY) / cs);

  // セルごとの要素を、個数を数えてから詰める（CSR 形式）
  const start = new Int32Array(nx * ny + 1);
  for (let i = 0; i < n; i++) {
    if (!usable[i]) continue;
    const c1 = col(boxes[4 * i + 2]);
    const r1 = row(boxes[4 * i + 3]);
    for (let r = row(boxes[4 * i + 1]); r <= r1; r++)
      for (let c = col(boxes[4 * i]); c <= c1; c++) start[r * nx + c + 1]++;
  }
  for (let k = 0; k < nx * ny; k++) start[k + 1] += start[k];
  const items = new Int32Array(start[nx * ny]);
  const fill = start.slice(0, nx * ny);
  for (let i = 0; i < n; i++) {
    if (!usable[i]) continue;
    const c1 = col(boxes[4 * i + 2]);
    const r1 = row(boxes[4 * i + 3]);
    for (let r = row(boxes[4 * i + 1]); r <= r1; r++)
      for (let c = col(boxes[4 * i]); c <= c1; c++) items[fill[r * nx + c]++] = i;
  }

  // 同じ要素が複数のセルに載っているので、問い合わせごとの通し番号で重複を除く
  const seen = new Int32Array(n);
  let stamp = 0;

  return {
    count: n,
    bounds,
    near(line, pad, visit) {
      const { ax, ay, bx, by } = line;
      if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by)) || !(pad >= 0)) return;
      const p = pad + EPS;
      // 線（を pad だけ太らせたもの）が範囲に届かなければ何もしない
      if (Math.max(ax, bx) + p < minX || Math.min(ax, bx) - p > maxX) return;
      if (Math.max(ay, by) + p < minY || Math.min(ay, by) - p > maxY) return;
      if (++stamp === 0x7fffffff) {
        seen.fill(0);
        stamp = 1;
      }
      const c0 = Math.max(0, col(Math.min(ax, bx) - p));
      const c1 = Math.min(nx - 1, col(Math.max(ax, bx) + p));
      const dx = bx - ax;
      const dy = by - ay;
      for (let c = c0; c <= c1; c++) {
        // この列（pad の余白つき）の中で、線が通る y の範囲
        const xl = minX + c * cs - p;
        const xr = minX + (c + 1) * cs + p;
        let ylo: number;
        let yhi: number;
        if (dx === 0) {
          ylo = Math.min(ay, by);
          yhi = Math.max(ay, by);
        } else {
          const ta = Math.min(1, Math.max(0, (xl - ax) / dx));
          const tb = Math.min(1, Math.max(0, (xr - ax) / dx));
          const ya = ay + dy * ta;
          const yb = ay + dy * tb;
          ylo = Math.min(ya, yb);
          yhi = Math.max(ya, yb);
        }
        const r0 = Math.max(0, row(ylo - p));
        const r1 = Math.min(ny - 1, row(yhi + p));
        for (let r = r0; r <= r1; r++) {
          const cell = r * nx + c;
          for (let k = start[cell], end = start[cell + 1]; k < end; k++) {
            const item = items[k];
            if (seen[item] === stamp) continue;
            seen[item] = stamp;
            visit(item);
          }
        }
      }
    },
  };
}
