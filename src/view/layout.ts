/**
 * 画面の配置（純粋な計算）。
 * 描画領域は、右上のパネル（間隔スライダーとレイヤー一覧）の左側。
 * その中で、左下の探針パネルを避けて積層を置くための余白と、避ける長方形を決める。
 * 座標は描画領域の左上が原点。
 */

export interface Size {
  width: number;
  height: number;
}
/** 描画領域の端からの余白（px）。 */
export interface Padding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
/** 画面上の長方形（px、左上が原点）。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type Pt = readonly [number, number];

const EPS = 1e-6;

/** 右上のパネルの寸法（px）。内容の幅、padding（片側）、画面の端との隙間。 */
export const PANEL = { width: 220, padding: 12, margin: 12 } as const;
/** 右上のパネルが右端から占める幅（px）。積層の描画領域はこの左側。 */
export const RIGHT_PANEL_W = PANEL.width + 2 * PANEL.padding + PANEL.margin;
/** 平面の右脇に出るレイヤー名のぶんの、描画領域の右端からの余白（px）。 */
export const LABEL_ROOM = 80;
/** 画面の端との最小の隙間（px）。 */
export const GUTTER = 24;
/** 左下の探針パネル（固定表示時の最大の高さを見込む）が占める幅と高さ（px）。 */
export const PROBE_PANEL = { width: 330, height: 360 } as const;

export interface Layout {
  /** 積層の中心を置く領域を決める余白。 */
  padding: Padding;
  /** 積層が重ならないようにする長方形。 */
  avoid: Rect[];
}

const MIN_SAFE = 160;

/** size は描画領域の大きさ。 */
export function computeLayout(size: Size): Layout {
  const right = Math.min(LABEL_ROOM, Math.max(GUTTER, size.width - GUTTER - MIN_SAFE));
  const padding: Padding = { left: GUTTER, right, top: GUTTER, bottom: GUTTER };
  const avoid: Rect[] = [
    { left: 0, top: size.height - PROBE_PANEL.height, right: PROBE_PANEL.width, bottom: size.height },
  ];
  return { padding, avoid };
}

/** padding の内側の領域の中心。 */
export function paddedCenter(size: Size, p: Padding): [number, number] {
  return [(p.left + size.width - p.right) / 2, (p.top + size.height - p.bottom) / 2];
}

/** 点集合の凸包（反時計回り、y 軸は画面下向きでも向きは問わない）。 */
export function convexHull(points: readonly Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (seq: Pt[]) => {
    const h: Pt[] = [];
    for (const p of seq) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...build(pts), ...build([...pts].reverse())];
}

/** 凸多角形と長方形が（接するだけでなく）重なるか。分離軸判定。1e-6 px 未満の重なりは接しているとみなす。 */
export function convexIntersectsRect(poly: readonly Pt[], r: Rect): boolean {
  if (poly.length === 0) return false;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  if (Math.max(...xs) <= r.left + EPS || Math.min(...xs) >= r.right - EPS) return false;
  if (Math.max(...ys) <= r.top + EPS || Math.min(...ys) >= r.bottom - EPS) return false;
  const corners: Pt[] = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const nx = b[1] - a[1];
    const ny = a[0] - b[0];
    if (nx === 0 && ny === 0) continue;
    const dots = (ps: readonly Pt[]) => ps.map((p) => p[0] * nx + p[1] * ny);
    const pd = dots(poly);
    const cd = dots(corners);
    const tol = EPS * Math.hypot(nx, ny);
    if (Math.max(...pd) <= Math.min(...cd) + tol || Math.max(...cd) <= Math.min(...pd) + tol) return false;
  }
  return true;
}

const within = (v: number, lo: number, hi: number) => v >= lo - EPS && v <= hi + EPS;

/** 凸多角形の内部（境界を除く）に点があるか。 */
function strictlyInside(poly: readonly Pt[], p: Pt): boolean {
  if (poly.length < 3) return false;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sign = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) <= EPS) return false;
  }
  return true;
}

/**
 * 外形 offsets（zoom 0 での、箱の中心からの相対位置）を倍率 s にしたとき、その中心を置ける場所。
 * 領域 inner に収まり、avoid のどれにも重ならない位置のうち、希望の位置 pref にいちばん近いもの。なければ null。
 *
 * 外形を倍率 s で位置 c に置いたとき長方形 r と重なるのは、c が「r から外形を引いた集合（ミンコフスキー和）」の内側にあるとき。
 * この集合は凸多角形なので、pref がその内側なら、境界上の最も近い点（辺への射影、頂点、置ける範囲の縁との交点）を選ぶ。
 */
export function placeBox(offsets: readonly Pt[], s: number, pref: Pt, inner: Rect, avoid: readonly Rect[]): Pt | null {
  let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
  for (const [x, y] of offsets) {
    loX = Math.max(loX, inner.left - x * s);
    hiX = Math.min(hiX, inner.right - x * s);
    loY = Math.max(loY, inner.top - y * s);
    hiY = Math.min(hiY, inner.bottom - y * s);
  }
  if (loX > hiX + EPS || loY > hiY + EPS) return null;
  const clampX = (v: number) => Math.min(hiX, Math.max(loX, v));
  const clampY = (v: number) => Math.min(hiY, Math.max(loY, v));
  const start: Pt = [clampX(pref[0]), clampY(pref[1])];

  const hull = convexHull(offsets);
  const forbidden = avoid.map((r) => {
    const sums: Pt[] = [];
    for (const [rx, ry] of [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]] as const)
      for (const [hx, hy] of hull) sums.push([rx - s * hx, ry - s * hy]);
    return convexHull(sums);
  });
  const blocked = (p: Pt) => forbidden.some((q) => strictlyInside(q, p));
  if (!blocked(start)) return start;

  const cands: Pt[] = [[loX, loY], [hiX, loY], [hiX, hiY], [loX, hiY]];
  for (const q of forbidden)
    for (let i = 0; i < q.length; i++) {
      const a = q[i];
      const b = q[(i + 1) % q.length];
      cands.push(a);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      if (len2 > 0) {
        const t = Math.min(1, Math.max(0, ((start[0] - a[0]) * dx + (start[1] - a[1]) * dy) / len2));
        cands.push([a[0] + t * dx, a[1] + t * dy]);
      }
      for (const x of [loX, hiX]) if (dx !== 0) { const t = (x - a[0]) / dx; if (within(t, 0, 1)) cands.push([x, a[1] + t * dy]); }
      for (const y of [loY, hiY]) if (dy !== 0) { const t = (y - a[1]) / dy; if (within(t, 0, 1)) cands.push([a[0] + t * dx, y]); }
    }
  let best: Pt | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    if (!within(c[0], loX, hiX) || !within(c[1], loY, hiY) || blocked(c)) continue;
    const d = (c[0] - start[0]) ** 2 + (c[1] - start[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [clampX(c[0]), clampY(c[1])];
    }
  }
  return best;
}

/**
 * 外形 offsets を領域 inner に収め、avoid と重ならないようにできる最大の倍率と、そのときの中心の位置。
 * 中心はなるべく pref に近い位置。避ける領域に阻まれて置けないときは、避けずに領域だけに収める。
 */
export function maxScale(offsets: readonly Pt[], pref: Pt, inner: Rect, avoid: readonly Rect[]): { scale: number; center: Pt } {
  const xs = offsets.map((p) => p[0]);
  const ys = offsets.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const hi = Math.max(1e-6, Math.min((inner.right - inner.left) / Math.max(w, 1e-6), (inner.bottom - inner.top) / Math.max(h, 1e-6)));

  const top = placeBox(offsets, hi, pref, inner, avoid);
  if (top) return { scale: hi, center: top };
  // 倍率を上げるほど置ける場所は減る（単調）。
  const floor = hi * 1e-3;
  if (!placeBox(offsets, floor, pref, inner, avoid)) return { scale: hi, center: placeBox(offsets, hi, pref, inner, []) ?? pref };
  let lo = floor;
  let up = hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + up) / 2;
    if (placeBox(offsets, mid, pref, inner, avoid)) lo = mid;
    else up = mid;
  }
  return { scale: lo, center: placeBox(offsets, lo, pref, inner, avoid) as Pt };
}
