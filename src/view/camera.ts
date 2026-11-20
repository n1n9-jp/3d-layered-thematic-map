import { OrbitView } from '@deck.gl/core';
import { EXTENT } from '../config';
import type { ViewState } from '../store';

/**
 * 平行投影の OrbitView。
 * fovy を小さくすると、絵は変えずに near 面でのクリップだけが解消する。
 */
export const VIEW = new OrbitView({ orthographic: true, fovy: 5 });

/** viewState に合成する制限値（コントローラではなく viewState が持つ）。下から見上げないよう minRotationX は正。 */
export const LIMITS = { minZoom: -9, maxZoom: -1, minRotationX: 8, maxRotationX: 90 } as const;

/** 初期視点の角度。 */
export const DEFAULT_ANGLES = { rotationX: 25, rotationOrbit: 45 } as const;
/** 単独表示の視点（真上、北が上）。 */
export const SOLO_ANGLES = { rotationX: 90, rotationOrbit: 0 } as const;

/** 画面に収めるときの余白（px）。右はレイヤー名のぶん広くとる。 */
export const PAD = { left: 32, right: 132, vertical: 48 } as const;

export interface Size {
  width: number;
  height: number;
}

type View4 = Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;

const { minX, minY, maxX, maxY } = EXTENT;
export const CENTER = [(minX + maxX) / 2, (minY + maxY) / 2] as const;
const HALF = (maxX - minX) / 2;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
 * 高さ 0〜top の箱（EXTENT × 積層全体）が余白つきで画面に収まる target と zoom。
 * 箱は画面上で、レイヤー名のぶんを右に空けて中央に置く。
 */
export function fitView(opts: { rotationX: number; rotationOrbit: number; top: number; size: Size }): Pick<ViewState, 'target' | 'zoom'> {
  const { rotationX, rotationOrbit, top, size } = opts;
  const center: [number, number, number] = [CENTER[0], CENTER[1], top / 2];
  const vp = viewport({ target: center, rotationX, rotationOrbit, zoom: 0 }, size.width, size.height);

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of [minX, maxX])
    for (const y of [minY, maxY])
      for (const z of [0, top]) {
        const [px, py] = vp.project([x, y, z]);
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }

  const availW = Math.max(1, size.width - PAD.left - PAD.right);
  const availH = Math.max(1, size.height - 2 * PAD.vertical);
  const scale = Math.min(availW / Math.max(1e-6, x1 - x0), availH / Math.max(1e-6, y1 - y0));
  const zoom = clamp(Math.log2(scale), LIMITS.minZoom, LIMITS.maxZoom);

  // 箱の中心（= target）が画面の中心に来る。これを、余白の左右差のぶん横へずらす。
  const shiftPx = (PAD.left - PAD.right) / 2;
  const [dx, dy] = solve(jacobian(rotationX, rotationOrbit), shiftPx, 0);
  const s = 2 ** zoom;
  return { zoom, target: [center[0] - dx / s, center[1] - dy / s, center[2]] };
}

/**
 * 高さ z の平面の「画面上の右側」の縁の位置。
 * 平面の中心から、画面の右向きに対応する水平方向へ伸ばした半直線が、縁と交わる点（連続して動く）。
 */
export function labelAnchors(rotationX: number, rotationOrbit: number, zs: number[]): [number, number, number][] {
  const [a, b, c, d] = jacobian(clamp(rotationX, 1, 90), rotationOrbit);
  let [dx, dy] = solve([a, b, c, d], 1, 0);
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const r = HALF / Math.max(Math.abs(dx), Math.abs(dy));
  return zs.map((z) => [CENTER[0] + dx * r, CENTER[1] + dy * r, z]);
}

/** 目標の rotationOrbit に最も近い、360度の整数倍だけ違う角度。 */
export function nearestAngle(target: number, from: number): number {
  return target + 360 * Math.round((from - target) / 360);
}

/** 表示確認用：与えた viewState で点を画面へ投影する。 */
export function projectPoint(vs: View4, size: Size, p: [number, number, number]): [number, number] {
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
