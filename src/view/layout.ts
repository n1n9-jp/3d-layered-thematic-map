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

/** 外形 offsets の、中心から見た x・y の範囲。 */
function extent(offsets: readonly Pt[]) {
  const xs = offsets.map((p) => p[0]);
  const ys = offsets.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** 長方形の4隅。 */
const cornersOf = (r: Rect): Pt[] => [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];

/**
 * 外形を、長方形 r に重ならないよう、法線 n の直線の「n の向きの側」に置く条件で、置ける最大の倍率。
 * 外形を倍率 s・中心 c に置くと、外形の頂点は c + s·h。すべてが n·p ≥ max(r の n·p) を満たす条件は、c について線形：
 *   n·c ≥ hR − s·min(n·h)
 * 中心 c は倍率 s で決まる範囲 [loX, hiX] × [loY, hiY] に動くので、n·c の最大値は s の一次式 A − s·B になり、s は閉じた式で求まる。
 */
function scaleAlong(n: Pt, r: Rect, ext: ReturnType<typeof extent>, offsets: readonly Pt[], inner: Rect, sInner: number): number {
  const A = n[0] * (n[0] >= 0 ? inner.right : inner.left) + n[1] * (n[1] >= 0 ? inner.bottom : inner.top);
  const B = n[0] * (n[0] >= 0 ? ext.maxX : ext.minX) + n[1] * (n[1] >= 0 ? ext.maxY : ext.minY);
  let mn = Infinity;
  for (const [x, y] of offsets) mn = Math.min(mn, n[0] * x + n[1] * y);
  const hR = Math.max(...cornersOf(r).map((c) => n[0] * c[0] + n[1] * c[1]));
  const denom = B - mn;
  if (denom <= 1e-12) return sInner;
  return Math.min(sInner, Math.max(0, (A - hR) / denom));
}

/** 凸多角形 poly の、n·p ≥ b の側だけを残す（Sutherland–Hodgman）。 */
function clipHalfPlane(poly: readonly Pt[], n: Pt, b: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const c = poly[(i + 1) % poly.length];
    const da = n[0] * a[0] + n[1] * a[1] - b;
    const dc = n[0] * c[0] + n[1] * c[1] - b;
    if (da >= 0) out.push(a);
    if ((da > 0 && dc < 0) || (da < 0 && dc > 0)) {
      const t = da / (da - dc);
      out.push([a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])]);
    }
  }
  return out;
}

/** 点 p から線分 ab への最も近い点。 */
function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

/** 凸多角形（頂点列）の中の、p にいちばん近い点。p が内側なら p。 */
function nearestInConvex(poly: readonly Pt[], p: Pt): Pt {
  if (poly.length === 1) return poly[0];
  let inside = poly.length >= 3;
  let sign = 0;
  for (let i = 0; inside && i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cr) <= 1e-12) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) inside = false;
  }
  if (inside) return p;
  let best = poly[0];
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = nearestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** 避ける長方形ごとの分離線の向き（法線）を決めるときの角度の刻み（度）と、最大倍率からの許容幅。 */
const ANGLE_STEP_DEG = 1;
const PLATEAU = 0.1;
/** 数値の誤差で、収まるはずの外形がわずかにはみ出さないよう、求めた倍率にかける係数。 */
const SAFETY = 1 - 1e-7;
/**
 * 避けるときは、分離線の条件で置ける最大の倍率より少し小さくする。
 * 最大ちょうどでは、置ける中心の集まりが1点に潰れ、線の向きがわずかに変わるだけで、その点が領域の別の角へ跳ぶ。
 * 少し小さくすれば、置ける範囲に幅が残り、中心は連続的に動く。
 */
const SLACK = 0.99;

/**
 * 外形 offsets（zoom 0 での、箱の中心からの相対位置。点対称）を、領域 inner に収め、avoid の長方形のどれにも重ならないように置く。
 * 倍率はなるべく大きく、中心はなるべく pref の近くにする。
 *
 * 避け方は「長方形と外形を分ける直線の向き」を1つ決め、外形をその直線の片側に置く条件にする。
 * この条件のもとでは、置ける中心の集まりが凸多角形になるので、倍率が決まれば、pref にいちばん近い中心が1つに決まる。
 * 向きは、置ける最大の倍率が最も大きい向きの近くで決める。最大に近い向き（最大の 95% 以上）の重み付き平均なので、
 * 間隔・画面の大きさ・視点の角度を連続的に変えるとき、向き・倍率・中心がどれも連続的に変わる。
 * （「いま pref に近い置き場所」を毎回選び直す方式では、避ける場所が上から右へ入れ替わる瞬間に中心が跳ぶ。）
 *
 * 避けるのが不可能なとき（領域が避ける長方形に覆われているなど）は、避けずに領域だけに収める。
 */
export function maxScale(offsets: readonly Pt[], pref: Pt, inner: Rect, avoid: readonly Rect[]): { scale: number; center: Pt } {
  const ext = extent(offsets);
  const w = ext.maxX - ext.minX;
  const h = ext.maxY - ext.minY;
  const hi = Math.max(1e-6, Math.min((inner.right - inner.left) / Math.max(w, 1e-6), (inner.bottom - inner.top) / Math.max(h, 1e-6)));
  const rectAt = (s: number) => ({
    left: inner.left - ext.minX * s,
    right: inner.right - ext.maxX * s,
    top: inner.top - ext.minY * s,
    bottom: inner.bottom - ext.maxY * s,
  });
  const clampInto = (r: Rect): Pt => [Math.min(r.right, Math.max(r.left, pref[0])), Math.min(r.bottom, Math.max(r.top, pref[1]))];
  const fallback = () => ({ scale: hi * SAFETY, center: clampInto(rectAt(hi * SAFETY)) });
  if (avoid.length === 0) return fallback();

  // 長方形ごとに、分離線の法線を決める。
  const normals: Pt[] = [];
  let sMax = hi;
  for (const r of avoid) {
    const dirs: { n: Pt; s: number }[] = [];
    let best = 0;
    for (let deg = 0; deg < 360; deg += ANGLE_STEP_DEG) {
      const t = (deg * Math.PI) / 180;
      const n: Pt = [Math.cos(t), Math.sin(t)];
      const s = scaleAlong(n, r, ext, offsets, inner, hi);
      dirs.push({ n, s });
      best = Math.max(best, s);
    }
    if (best <= hi * 1e-3) return fallback();
    let vx = 0;
    let vy = 0;
    for (const { n, s } of dirs) {
      const wt = Math.max(0, s - (1 - PLATEAU) * best);
      vx += wt * n[0];
      vy += wt * n[1];
    }
    const len = Math.hypot(vx, vy);
    const n: Pt = len > 1e-12 ? [vx / len, vy / len] : dirs.reduce((a, b) => (b.s > a.s ? b : a)).n;
    normals.push(n);
    sMax = Math.min(sMax, scaleAlong(n, r, ext, offsets, inner, hi));
  }

  const constraints = avoid.map((r, k) => {
    const n = normals[k];
    let mn = Infinity;
    for (const [x, y] of offsets) mn = Math.min(mn, n[0] * x + n[1] * y);
    const hR = Math.max(...cornersOf(r).map((c) => n[0] * c[0] + n[1] * c[1]));
    return { n, mn, hR };
  });
  const regionAt = (s: number): Pt[] => {
    const r = rectAt(s);
    let poly: Pt[] = cornersOf(r);
    if (r.left > r.right || r.top > r.bottom) return [];
    for (const { n, mn, hR } of constraints) {
      poly = clipHalfPlane(poly, n, hR - s * mn);
      if (poly.length === 0) return [];
    }
    return poly;
  };

  let s = sMax * SLACK;
  let region = regionAt(s);
  if (region.length === 0) {
    // 長方形が複数あるとき、個別に決めた向きでは同時に置けない場合がある。置ける倍率まで下げる。
    let lo = 0;
    let up = s;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + up) / 2;
      if (regionAt(mid).length > 0) lo = mid;
      else up = mid;
    }
    s = lo * SAFETY;
    region = regionAt(s);
    if (region.length === 0 || s <= hi * 1e-3) return fallback();
  }
  return { scale: s, center: nearestInConvex(region, pref) };
}
