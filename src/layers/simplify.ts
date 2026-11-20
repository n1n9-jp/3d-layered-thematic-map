import type { Position } from '../types';

/**
 * 描画用に折れ線を間引く（Douglas–Peucker 法）。
 * 元の頂点だけを残し、残した線から元の頂点までの距離が `tolerance`（m）を超えないようにする。
 * 端点は必ず残す。始点と終点が同じ座標の閉じた線（リング）は、閉じたまま返す。
 * 探針の参照（`sample`）には使わない。描画用の複製を作るためだけの処理。
 */
export function simplifyPath(path: readonly Position[], tolerance: number): Position[] {
  const pts = dropRepeats(path);
  if (pts.length < 3 || !(tolerance > 0)) return pts;
  if (!isClosed(pts)) return douglasPeucker(pts, tolerance);

  // 閉じた線は、始点から最も遠い頂点で2本に分けて、それぞれ間引く。
  let far = 1;
  let best = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = douglasPeucker(pts.slice(0, far + 1), tolerance);
  const b = douglasPeucker(pts.slice(far), tolerance);
  const ring = [...a, ...b.slice(1)];
  // 小さな輪が3点（面積0）以下に潰れるなら、元の形を残す。
  return ring.length >= 4 ? ring : pts;
}

/** 線の集まりをまとめて間引く。 */
export function simplifyPaths(paths: readonly (readonly Position[])[], tolerance: number): Position[][] {
  return paths.map((p) => simplifyPath(p, tolerance));
}

/** 頂点の総数。 */
export function countVertices(paths: readonly (readonly Position[])[]): number {
  let n = 0;
  for (const p of paths) n += p.length;
  return n;
}

/** 連続して同じ座標の頂点を1つにする（長さ0の線分は、継ぎ目の描画を乱すだけ）。 */
function dropRepeats(path: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const p of path) {
    const q = out[out.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
  }
  return out;
}

function isClosed(pts: readonly Position[]): boolean {
  const a = pts[0];
  const b = pts[pts.length - 1];
  return pts.length >= 4 && a[0] === b[0] && a[1] === b[1];
}

/** 線分 (a, b) と点 p の距離の2乗。 */
function segDistSq(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/** 開いた線の間引き。再帰を使わず、長い線でもスタックを溢れさせない。 */
function douglasPeucker(pts: readonly Position[], tolerance: number): Position[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const hi = stack.pop() as number;
    const lo = stack.pop() as number;
    let worst = -1;
    let idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDistSq(pts[i], pts[lo], pts[hi]);
      if (d > worst) {
        worst = d;
        idx = i;
      }
    }
    if (idx >= 0 && worst > tol2) {
      keep[idx] = 1;
      stack.push(lo, idx, idx, hi);
    }
  }
  const out: Position[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
