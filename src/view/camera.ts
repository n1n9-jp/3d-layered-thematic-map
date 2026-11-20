import { OrbitView } from '@deck.gl/core';
import { DATA_OUTLINE, DEFAULT_ANGLES, EXTENT, VIEW_LIMITS } from '../config';
import type { ViewState } from '../store';
import { computeLayout, maxScale, paddedCenter } from './layout';
import type { Layout, Padding, Pt, Size } from './layout';

export { DEFAULT_ANGLES };
export type { Layout, Padding, Size };

/**
 * 平行投影の OrbitView。
 * fovy を小さくすると、絵は変えずに near 面でのクリップだけが解消する。
 */
export const VIEW = new OrbitView({ orthographic: true, fovy: 5 });

/** viewState に合成する制限値（コントローラではなく viewState が持つ）。下から見上げないよう minRotationX は正。 */
export const LIMITS = VIEW_LIMITS;
/** 単独表示の視点（真上、北が上）。 */
export const SOLO_ANGLES = { rotationX: 90, rotationOrbit: 0 } as const;

type View4 = Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;

const { minX, minY, maxX, maxY } = EXTENT;
export const CENTER = [(minX + maxX) / 2, (minY + maxY) / 2] as const;
const HALF = (maxX - minX) / 2;

/**
 * 積層の平面の位置と大きさ。中心 (cx, cy)、半分の幅 half（m）。
 * round が true なら円（半径 half）、そうでなければ正方形（一辺 2·half）。既定は描画範囲全体（正方形）。
 */
export interface PlaneBox {
  cx: number;
  cy: number;
  half: number;
  round?: boolean;
  /**
   * 平面の中の、データのある範囲（中心を含む凸多角形、ローカル座標）。平面の外枠より小さい。
   * あれば、ほかの領域（パネルなど）との重なりと、レイヤー名を置く縁は、外枠ではなくこの範囲で決める。
   */
  outline?: readonly (readonly [number, number])[];
}
export const EXTENT_BOX: PlaneBox = { cx: CENTER[0], cy: CENTER[1], half: HALF };
/** 全体の積層の平面。外枠は描画範囲全体、データのある範囲は 23区を囲む多角形。 */
export const DATA_BOX: PlaneBox = { ...EXTENT_BOX, outline: DATA_OUTLINE };

/** 円の外周を折れ線で近似するときの分割数（収まりの計算用）。 */
const FIT_CIRCLE_STEPS = 48;

/** 平面の外形の、水平面上の点。正方形なら4隅、円なら外周の点。 */
function boxOutline(box: PlaneBox): [number, number][] {
  if (box.round) {
    return Array.from({ length: FIT_CIRCLE_STEPS }, (_, k) => {
      const t = (2 * Math.PI * k) / FIT_CIRCLE_STEPS;
      return [box.cx + box.half * Math.cos(t), box.cy + box.half * Math.sin(t)];
    });
  }
  return [
    [box.cx - box.half, box.cy - box.half],
    [box.cx + box.half, box.cy - box.half],
    [box.cx - box.half, box.cy + box.half],
    [box.cx + box.half, box.cy + box.half],
  ];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 描画領域に大きさがあるか（幅も高さも 1px 以上）。ないときは視点の計算も投影もできない。 */
export function hasSize(size: Size | null | undefined): size is Size {
  return !!size && size.width >= 1 && size.height >= 1;
}

function viewport(vs: View4, width: number, height: number) {
  const vp = VIEW.makeViewport({ width, height, viewState: vs });
  if (!vp) throw new Error('viewport を作れませんでした');
  return vp;
}

type Mat2 = [number, number, number, number]; // [a, b, c, d]: 画面 (px, py) = [[a, b], [c, d]] · (世界 x, 世界 y)  （zoom 0 のとき）

/** zoom 0 での、水平面（世界の x, y）から画面（px）への線形写像。 */
function jacobian(rotationX: number, rotationOrbit: number): Mat2 {
  const vp = viewport({ target: [0, 0, 0], rotationX, rotationOrbit, zoom: 0 }, 200, 200);
  const step = 1000;
  const p0 = vp.project([0, 0, 0]);
  const px = vp.project([step, 0, 0]);
  const py = vp.project([0, step, 0]);
  return [(px[0] - p0[0]) / step, (py[0] - p0[0]) / step, (px[1] - p0[1]) / step, (py[1] - p0[1]) / step];
}

function solve([a, b, c, d]: Mat2, sx: number, sy: number): [number, number] {
  const det = a * d - b * c;
  return [(d * sx - b * sy) / det, (-c * sx + a * sy) / det];
}

/**
 * 高さ 0〜top の箱（EXTENT × 積層全体）が、`layout` の領域（padding の内側）に収まり、
 * 避ける長方形と重ならない最大の zoom と、そのときの target。
 * 箱は、領域の中心になるべく近く、避ける長方形と重ならない位置に置く。そのために target を画面の中心から横・縦へずらす。
 *
 * deck.gl の View の `padding` は使わない。平行投影の OrbitView では、padding によるずれが
 * 奥行きに比例して大きくなり、位置が合わなくなるため。
 */
export function fitView(opts: {
  rotationX: number;
  rotationOrbit: number;
  top: number;
  size: Size;
  layout?: Layout;
  /** 積層の平面。既定は描画範囲全体。クローズアップでは、切り出した円を渡す。 */
  box?: PlaneBox;
  /** zoom の範囲。既定は全体の地図の上下限。 */
  zoomLimits?: { min: number; max: number };
}): Pick<ViewState, 'target' | 'zoom'> {
  const { rotationX, rotationOrbit, top, size } = opts;
  if (!hasSize(size)) throw new Error('描画領域に大きさがありません');
  const layout = opts.layout ?? computeLayout(size);
  const { padding, avoid } = layout;
  const box = opts.box ?? EXTENT_BOX;
  const zoomLimits = opts.zoomLimits ?? { min: LIMITS.minZoom, max: LIMITS.maxZoom };
  const center: [number, number, number] = [box.cx, box.cy, top / 2];
  // padding なしの View は、target を画面の中心に置く。箱の角の、そこからの相対位置を zoom 0 で測る。
  const vp = viewport({ target: center, rotationX, rotationOrbit, zoom: 0 }, size.width, size.height);
  const mid = vp.project(center);
  const offsets: Pt[] = [];
  for (const [x, y] of boxOutline(box))
    for (const z of [0, top]) {
      const [px, py] = vp.project([x, y, z]);
      offsets.push([px - mid[0], py - mid[1]]);
    }

  // データのある範囲があれば、ほかの領域との重なりはそれで判定する（外枠の角は、ほかの領域の下に入ってよい）。
  let avoidOffsets: Pt[] | undefined;
  if (box.outline) {
    avoidOffsets = [];
    for (const [x, y] of box.outline)
      for (const z of [0, top]) {
        const [px, py] = vp.project([x, y, z]);
        avoidOffsets.push([px - mid[0], py - mid[1]]);
      }
  }
  const innerOf = (p: Padding) => ({ left: p.left, top: p.top, right: size.width - p.right, bottom: size.height - p.bottom });
  // 置きたい中心。layout.center があれば、見えるデータのある範囲の中心をそこへ（外枠の中心は、倍率に応じてその分ずれる）。
  const centered = paddedCenter(size, padding);
  let pref: Pt | ((s: number) => Pt) = centered;
  if (layout.center && avoidOffsets) {
    const xs = avoidOffsets.map((o) => o[0]);
    const dataMidX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const want = layout.center;
    pref = (s) => [want[0] - s * dataMidX, want[1]];
  }
  const { scale, center: place } = maxScale(offsets, pref, innerOf(padding), avoid, { avoidOffsets });
  const zoom = clamp(Math.log2(scale), zoomLimits.min, zoomLimits.max);
  // 箱の中心（= target）は画面の中心に来る。これを、置く位置のずれのぶんだけ target を動かして直す。
  const [dx, dy] = solve(jacobian(rotationX, rotationOrbit), place[0] - size.width / 2, place[1] - size.height / 2);
  const s = 2 ** zoom;
  return { zoom, target: [center[0] - dx / s, center[1] - dy / s, center[2]] };
}

/** 点 (cx, cy) から向き (dx, dy)（単位ベクトル）へ伸ばした半直線が、凸多角形の縁と交わるまでの距離。点が多角形の内側にあるとき、ただ1つに決まる。 */
export function rayToPolygon(cx: number, cy: number, dx: number, dy: number, poly: readonly (readonly [number, number])[]): number {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const ex = bx - ax;
    const ey = by - ay;
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-12) continue;
    // c + t·d = a + u·e を解く
    const t = ((ax - cx) * ey - (ay - cy) * ex) / det;
    const u = ((ax - cx) * dy - (ay - cy) * dx) / det;
    if (t > best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
  }
  return best;
}

/**
 * 全体の積層（データのある範囲 `DATA_BOX`）の視点。
 * 拡大率と位置は、右端の情報の列（幅 columnWidth の領域とレイヤー名の余白）を避けて、積層が収まる最大のもの。
 * 列は中身の有無にかかわらず常に同じ幅を占めるので、探針の有無・固定の前後で、地図の大きさも位置も変わらない。
 * size は描画領域（右上のパネルの左側の全体）の大きさ。
 */
export function fitStack(opts: {
  rotationX: number;
  rotationOrbit: number;
  top: number;
  size: Size;
  columnWidth: number;
}): Pick<ViewState, 'target' | 'zoom'> {
  const { size, columnWidth, ...angles } = opts;
  return fitView({ ...angles, size, box: DATA_BOX, layout: computeLayout(size, columnWidth) });
}

/**
 * 高さ z の平面の「画面上の右側」の縁の位置。
 * 平面の中心から、画面の右向きに対応する水平方向へ伸ばした半直線が、縁と交わる点（連続して動く）。
 * box は平面の位置と大きさ（既定は描画範囲全体）。
 */
export function labelAnchors(rotationX: number, rotationOrbit: number, zs: number[], box: PlaneBox = EXTENT_BOX): [number, number, number][] {
  const [a, b, c, d] = jacobian(clamp(rotationX, 1, 90), rotationOrbit);
  let [dx, dy] = solve([a, b, c, d], 1, 0);
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const r = box.outline ? rayToPolygon(box.cx, box.cy, dx, dy, box.outline) : box.round ? box.half : box.half / Math.max(Math.abs(dx), Math.abs(dy));
  return zs.map((z) => [box.cx + dx * r, box.cy + dy * r, z]);
}

/** 目標の rotationOrbit に最も近い、360度の整数倍だけ違う角度。 */
export function nearestAngle(target: number, from: number): number {
  return target + 360 * Math.round((from - target) / 360);
}

/** 表示確認用：与えた viewState で点を画面へ投影する。 */
export function projectPoint(vs: View4, size: Size, p: [number, number, number]): [number, number] {
  if (!hasSize(size)) throw new Error('描画領域に大きさがありません');
  const [x, y] = viewport(vs, size.width, size.height).project(p);
  return [x, y];
}

/**
 * 画面上の縦位置 ys（px）を、互いに gap 以上離す。動かす距離の二乗和が最小になる配置（隣り合うものはまとめて中心を保つ）。
 * 戻り値は ys と同じ並び。
 */
export function spreadLabels(ys: number[], gap: number): number[] {
  const idx = ys.map((_, i) => i).sort((a, b) => ys[a] - ys[b] || b - a);
  const blocks: { sum: number; n: number }[] = [];
  idx.forEach((i, rank) => {
    blocks.push({ sum: ys[i] - rank * gap, n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.n <= last.sum / last.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: prev.sum + last.sum, n: prev.n + last.n });
    }
  });
  const out = new Array<number>(ys.length);
  let rank = 0;
  for (const b of blocks)
    for (let k = 0; k < b.n; k++, rank++) out[idx[rank]] = b.sum / b.n + rank * gap;
  return out;
}
