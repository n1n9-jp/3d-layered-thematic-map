/**
 * 円による切り出し。座標はローカルのメートル座標。
 * 「円の中」は縁の上を含む（中心からの距離 ≤ 半径）。
 */
import type { Position } from '../types';

/** 中心 (cx, cy)・半径 r（m）の円。 */
export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/** 点 (x, y) が円の中（縁の上を含む）にあるか。 */
export function pointInCircle(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 線分 A→B のうち円の中にある部分の媒介変数の区間 [t0, t1]（0〜1）。円の中を通らなければ null。 */
function insideInterval(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  r2: number,
): [number, number] | null {
  const fx = ax - cx;
  const fy = ay - cy;
  const gx = bx - cx;
  const gy = by - cy;
  const c = fx * fx + fy * fy - r2;
  const aIn = c <= 0;
  const bIn = gx * gx + gy * gy <= r2;
  if (aIn && bIn) return [0, 1]; // 円は凸なので、両端が中なら全体が中
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a === 0) return null; // 長さ0で、円の外
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (aIn) return [0, clamp01((-b + Math.sqrt(Math.max(disc, 0))) / (2 * a))]; // 中から出ていく
  if (bIn) return [clamp01((-b - Math.sqrt(Math.max(disc, 0))) / (2 * a)), 1]; // 外から入ってくる
  if (disc <= 0) return null; // 通らない、または接するだけ（長さ0）
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / (2 * a);
  const t1 = (-b + s) / (2 * a);
  // 両端が外なので、解は両方とも (0, 1) の中か、両方とも外
  return t0 > 0 && t1 < 1 ? [t0, t1] : null;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 折れ線を円で切り、円の中にある部分だけを、折れ線の配列で返す。
 * - 円の縁をまたぐ線分は、縁との交点で切る。円を出入りする線は、複数の折れ線に分かれる。
 * - 長さ0の部分（円に接するだけ、縁の上の1頂点だけ触れる、長さ0の線分）は返さない。
 * - 始点と終点が同じ座標の閉じた輪郭は、始点が円の中にあれば、始点をまたぐ2つの部分を1本につなげて返す。
 * - 全体が円の中なら、元の頂点列のコピー1本。入力は変更しない。
 */
export function clipPolylineToCircle(
  path: readonly Position[],
  cx: number,
  cy: number,
  radius: number,
): Position[][] {
  const out: Position[][] = [];
  const n = path.length;
  if (n < 2 || !(radius >= 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return out;
  const r2 = radius * radius;

  let cur: Position[] | null = null;
  const flush = () => {
    if (cur && cur.length >= 2) out.push(cur);
    cur = null;
  };
  const push = (piece: Position[], p: Position) => {
    const last = piece[piece.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) piece.push(p);
  };

  for (let i = 0; i + 1 < n; i++) {
    const A = path[i];
    const B = path[i + 1];
    const iv = insideInterval(A[0], A[1], B[0], B[1], cx, cy, r2);
    if (!iv) {
      flush();
      continue;
    }
    const [t0, t1] = iv;
    const entry: Position = t0 === 0 ? A : [A[0] + (B[0] - A[0]) * t0, A[1] + (B[1] - A[1]) * t0];
    const exit: Position = t1 === 1 ? B : [A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1];
    if (t0 > 0) flush();
    if (!cur) cur = [];
    push(cur, entry);
    push(cur, exit);
    if (t1 < 1) flush();
  }
  flush();

  // 閉じた輪郭で、始点が円の中にあれば、始点をまたぐ最後と最初の部分をつなぐ。
  const first = path[0];
  const lastPt = path[n - 1];
  const closed = n >= 4 && first[0] === lastPt[0] && first[1] === lastPt[1];
  if (closed && out.length >= 2 && pointInCircle(first[0], first[1], cx, cy, radius)) {
    const tail = out.pop() as Position[];
    out[0] = tail.concat(out[0].slice(1));
  }
  return out;
}
