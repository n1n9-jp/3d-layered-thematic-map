/**
 * 均等な格子バケットによる空間索引（点・線分・多角形）。
 * 座標はローカルのメートル座標。結果の `index` は、構築時に渡した配列の添字。
 */
import type { Position, Ring } from '../types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** リングの番号として扱える上限。これを超える遠方は、リングを進めず全セルを走査する。 */
const MAX_RING = 2 ** 30;

/** セル番号 q が [0, n) の外にあるとき、その範囲までのセル数。範囲内なら 0。 */
function gap(q: number, n: number): number {
  return q < 0 ? -q : q > n - 1 ? q - (n - 1) : 0;
}

/** 格子バケット。セルは疎な Map に持つ。 */
class BucketGrid {
  readonly cells = new Map<number, number[]>();
  readonly nx: number;
  readonly ny: number;

  constructor(
    readonly bounds: Bounds,
    readonly cellSize: number,
  ) {
    this.nx = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / cellSize) + 1);
    this.ny = Math.max(1, Math.floor((bounds.maxY - bounds.minY) / cellSize) + 1);
  }

  col(x: number): number {
    return Math.floor((x - this.bounds.minX) / this.cellSize);
  }
  row(y: number): number {
    return Math.floor((y - this.bounds.minY) / this.cellSize);
  }
  inRange(c: number, r: number): boolean {
    return c >= 0 && c < this.nx && r >= 0 && r < this.ny;
  }
  get(c: number, r: number): number[] | undefined {
    return this.inRange(c, r) ? this.cells.get(r * this.nx + c) : undefined;
  }
  add(c: number, r: number, item: number): void {
    const key = r * this.nx + c;
    const list = this.cells.get(key);
    if (list) list.push(item);
    else this.cells.set(key, [item]);
  }
  /** bbox にかかる全セルへ登録する。 */
  addBox(minX: number, minY: number, maxX: number, maxY: number, item: number): void {
    const c0 = this.col(minX);
    const c1 = this.col(maxX);
    const r0 = this.row(minY);
    const r1 = this.row(maxY);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.add(c, r, item);
  }

  /**
   * (x, y) を中心に、チェビシェフ距離 k のリングを内側から順に走査する。
   * visit(item) の結果を見て、done(k) が true になるか、リングが格子を覆いきった時点で止める。
   * done(k) は「リング k までを見終えた」時点で呼ぶ。未走査のセルは (x, y) から k * cellSize 以上離れている。
   *
   * 走査は格子の範囲と交わるセルだけに限る。(x, y) が格子の外にあるときは、格子に届く最初のリングから始める。
   * 座標が有限でないとき、または要素が無いときは何も走査しない。
   */
  scanRings(x: number, y: number, visit: (item: number) => void, done: (k: number) => boolean): void {
    if (this.cells.size === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const { nx, ny } = this;
    const qc = this.col(x);
    const qr = this.row(y);
    // 格子に届く最初のリング。それより内側のリングは格子と交わらない。
    const first = Math.max(gap(qc, nx), gap(qr, ny));
    // 読み飛ばしたリングで done が真になっていたはずなら、見つからずに終わる（done は k について単調）。
    if (first > 0 && done(first - 1)) return;
    if (first > MAX_RING) {
      // 添字が倍精度の整数で表せない遠方。リングを進められないので、全セルを一度ずつ見る。
      for (const list of this.cells.values()) for (const item of list) visit(item);
      return;
    }
    for (let k = first; ; k++) {
      if (k === 0) this.visitCell(qc, qr, visit);
      else {
        const c0 = Math.max(qc - k, 0);
        const c1 = Math.min(qc + k, nx - 1);
        const r0 = Math.max(qr - k + 1, 0);
        const r1 = Math.min(qr + k - 1, ny - 1);
        if (qr - k >= 0 && qr - k < ny) for (let c = c0; c <= c1; c++) this.visitCell(c, qr - k, visit);
        if (qr + k >= 0 && qr + k < ny) for (let c = c0; c <= c1; c++) this.visitCell(c, qr + k, visit);
        if (qc - k >= 0 && qc - k < nx) for (let r = r0; r <= r1; r++) this.visitCell(qc - k, r, visit);
        if (qc + k >= 0 && qc + k < nx) for (let r = r0; r <= r1; r++) this.visitCell(qc + k, r, visit);
      }
      if (done(k)) return;
      if (qc - k < 0 && qc + k >= nx && qr - k < 0 && qr + k >= ny) return;
    }
  }
  private visitCell(c: number, r: number, visit: (item: number) => void): void {
    const list = this.get(c, r);
    if (list) for (const item of list) visit(item);
  }
}

function boundsOf(xs: Iterable<number>, ys: Iterable<number>): Bounds {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const x of xs) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  for (const y of ys) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** 既定のセルサイズ：範囲の長辺を、要素数の平方根個に割る。 */
function autoCellSize(b: Bounds, n: number): number {
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY);
  return Math.max(1, extent / Math.max(1, Math.ceil(Math.sqrt(n))));
}

/* ------------------------------------------------------------------ */
/* 点                                                                  */
/* ------------------------------------------------------------------ */

export interface PointHit {
  index: number;
  distance: number;
}

export interface PointIndex {
  /** 中心 (x, y) から半径 r 以内の点の添字（距離の昇順）。 */
  within(x: number, y: number, r: number): PointHit[];
  /** 最も近い点。点が無い、または maxDistance を超える場合は null。 */
  nearest(x: number, y: number, maxDistance?: number): PointHit | null;
}

export function createPointIndex(points: readonly Position[], cellSize?: number): PointIndex {
  // 座標が有限でない点は索引に載せない（添字は元の配列のまま）。
  const usable = points.map((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const bounds = boundsOf(
    points.filter((_, i) => usable[i]).map((p) => p[0]),
    points.filter((_, i) => usable[i]).map((p) => p[1]),
  );
  const size = cellSize ?? autoCellSize(bounds, points.length);
  const grid = new BucketGrid(bounds, size);
  points.forEach((p, i) => {
    if (usable[i]) grid.add(grid.col(p[0]), grid.row(p[1]), i);
  });

  return {
    within(x, y, r) {
      const hits: PointHit[] = [];
      if (!(r >= 0) || points.length === 0) return hits;
      const c0 = Math.max(0, grid.col(x - r));
      const c1 = Math.min(grid.nx - 1, grid.col(x + r));
      const r0 = Math.max(0, grid.row(y - r));
      const r1 = Math.min(grid.ny - 1, grid.row(y + r));
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const list = grid.get(col, row);
          if (!list) continue;
          for (const i of list) {
            const d = Math.hypot(points[i][0] - x, points[i][1] - y);
            if (d <= r) hits.push({ index: i, distance: d });
          }
        }
      }
      return hits.sort((a, b) => a.distance - b.distance || a.index - b.index);
    },
    nearest(x, y, maxDistance = Infinity) {
      if (!(maxDistance >= 0)) return null;
      let best: PointHit | null = null;
      grid.scanRings(
        x,
        y,
        (i) => {
          const d = Math.hypot(points[i][0] - x, points[i][1] - y);
          if (!Number.isFinite(d)) return;
          if (!best || d < best.distance || (d === best.distance && i < best.index)) best = { index: i, distance: d };
        },
        (k) => (best !== null && best.distance <= k * size) || k * size > maxDistance,
      );
      const found = best as PointHit | null;
      return found && found.distance <= maxDistance ? found : null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 線分                                                                */
/* ------------------------------------------------------------------ */

/** 線分 [x1, y1, x2, y2]。 */
export type Segment = readonly [number, number, number, number];

export interface SegmentHit {
  index: number;
  distance: number;
  /** 線分上の最近点 */
  x: number;
  y: number;
}

/** 点 (px, py) から線分への最近点と距離。 */
export function closestPointOnSegment(
  px: number,
  py: number,
  seg: Segment,
): { x: number; y: number; distance: number } {
  const [x1, y1, x2, y2] = seg;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  const x = x1 + t * dx;
  const y = y1 + t * dy;
  return { x, y, distance: Math.hypot(px - x, py - y) };
}

export interface SegmentIndex {
  /** 最も近い線分とその距離。線分が無い、または maxDistance を超える場合は null。 */
  nearest(x: number, y: number, maxDistance?: number): SegmentHit | null;
}

/** 線分は bbox にかかるすべてのセルに登録する（短い線分の集まりを想定）。 */
export function createSegmentIndex(segments: readonly Segment[], cellSize?: number): SegmentIndex {
  // 座標が有限でない線分は索引に載せない（添字は元の配列のまま）。
  const usable = segments.map((s) => s.every(Number.isFinite));
  const live = segments.filter((_, i) => usable[i]);
  const bounds = boundsOf(
    live.flatMap((s) => [s[0], s[2]]),
    live.flatMap((s) => [s[1], s[3]]),
  );
  const size = cellSize ?? autoCellSize(bounds, segments.length);
  const grid = new BucketGrid(bounds, size);
  segments.forEach((s, i) => {
    if (usable[i]) grid.addBox(Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3]), i);
  });

  return {
    nearest(x, y, maxDistance = Infinity) {
      if (!(maxDistance >= 0)) return null;
      let best: SegmentHit | null = null;
      grid.scanRings(
        x,
        y,
        (i) => {
          const c = closestPointOnSegment(x, y, segments[i]);
          if (!Number.isFinite(c.distance)) return;
          if (!best || c.distance < best.distance || (c.distance === best.distance && i < best.index))
            best = { index: i, distance: c.distance, x: c.x, y: c.y };
        },
        (k) => (best !== null && best.distance <= k * size) || k * size > maxDistance,
      );
      const found = best as SegmentHit | null;
      return found && found.distance <= maxDistance ? found : null;
    },
  };
}

/** LineString（頂点列）の集まりから、隣り合う頂点ごとの線分列を作る。 */
export function segmentsFromLines(lines: readonly (readonly Position[])[]): Segment[] {
  const out: Segment[] = [];
  for (const line of lines)
    for (let i = 0; i + 1 < line.length; i++) out.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  return out;
}

/* ------------------------------------------------------------------ */
/* 多角形                                                              */
/* ------------------------------------------------------------------ */

/** 多角形 = 外周＋穴のリング列（GeoJSON の Polygon の coordinates と同じ）。偶奇規則で判定する。 */
export type PolygonRings = readonly Ring[];

export function pointInPolygon(x: number, y: number, polygon: PolygonRings): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export interface PolygonIndex {
  /** (x, y) を含む多角形の添字（昇順）。 */
  containing(x: number, y: number): number[];
}

export function createPolygonIndex(polygons: readonly PolygonRings[], cellSize?: number): PolygonIndex {
  const boxes = polygons.map((poly) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const ring of poly)
      for (const p of ring) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
    return boundsOf(xs, ys);
  });
  const bounds = boundsOf(
    boxes.flatMap((b) => [b.minX, b.maxX]),
    boxes.flatMap((b) => [b.minY, b.maxY]),
  );
  const size = cellSize ?? autoCellSize(bounds, polygons.length);
  const grid = new BucketGrid(bounds, size);
  boxes.forEach((b, i) => grid.addBox(b.minX, b.minY, b.maxX, b.maxY, i));

  return {
    containing(x, y) {
      const list = grid.get(grid.col(x), grid.row(y));
      if (!list) return [];
      return list.filter((i) => pointInPolygon(x, y, polygons[i])).sort((a, b) => a - b);
    },
  };
}
