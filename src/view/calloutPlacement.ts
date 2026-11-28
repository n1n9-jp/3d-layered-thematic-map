/**
 * 札（コールアウト）の置き場所を、画面の上で決める純粋な計算。
 * 札は、目印（anchor）から引いた短い線（引き出し線）の先に置く。札どうし、札と引き出し線、引き出し線どうしが重ならず、
 * 重ねてはいけない場所（帯・右の列・レイヤー名・ほかの段のデータの範囲）にもかからない置き場所を、目印のまわりの候補から探す。
 * 座標は画面（px、描画領域の左上が原点）。React・deck.gl に依存しない。
 *
 * 視点や段の高さが変わるたびに呼ぶ（マウスの移動では呼ばない）ので、軽く保つ：候補は 向き 24 × 距離 11 通り、多角形の判定は辺ごとの射影を
 * あらかじめ求めておき、札ごとに費用の小さい候補だけを組み合わせる。
 */
import type { Pt, Rect } from './layout';

export type { Pt, Rect };

export interface CalloutItem {
  id: string;
  /** 引き出し線の根元（区の目印）の画面上の位置 */
  anchor: Pt;
  /** 札の大きさ（px。枠と余白を含む。見えている札そのもの） */
  w: number;
  h: number;
}

export interface CalloutObstacles {
  /** 札が収まる領域 */
  bounds: Rect;
  /** 札が重なってはいけない長方形（題と切り替えの帯、右の列、レイヤー名） */
  rects: readonly Rect[];
  /** 札が重なってはいけない凸多角形（ほかの段のデータのある範囲） */
  polys: readonly (readonly Pt[])[];
  /** なるべく重ならないほうがよい凸多角形（同じ段のデータのある範囲。印や区の上に札が乗らないように） */
  soft: readonly (readonly Pt[])[];
  /** 引き出し線がなるべく通らないほうがよい凸多角形（別の高さにある、ほかの段のデータのある範囲。線が別の段の地物を指しているように見えないように） */
  leaderAvoid?: readonly (readonly Pt[])[];
}

export interface PlacedCallout {
  id: string;
  rect: Rect;
  anchor: Pt;
  /** 引き出し線の、札の側の端（札の縁の上で、目印にいちばん近い点） */
  attach: Pt;
}

export interface CalloutResult {
  /** 置けたもの（入力の順） */
  placed: PlacedCallout[];
  /** 置ける候補が1つもなかったもの */
  missing: string[];
  /** 置けたものどうしに、重なりが残っているか（残っていれば、呼び出し側は札を小さくするなどで試し直す） */
  conflict: boolean;
}

/** 目印と札の縁との最小の隙間と、候補の距離の刻み（px）、向きの刻み（度）。 */
export const CALLOUT_DISTANCES = [12, 24, 40, 60, 85, 115, 150, 195, 250, 320, 400] as const;
const ANGLE_STEP = 15;
/** 札どうしの余白、引き出し線と札の余白（px）。 */
const LABEL_MARGIN = 4;
const LINE_MARGIN = 2;
/** 札と、重ねてはいけないもの（帯・列・レイヤー名・ほかの段のデータ）との最小の隙間（px）。文字の大きさの見積りの誤差を吸収する。 */
const KEEP_OUT_MARGIN = 4;
/** 各項の重み。重なりは、引き出し線の長さ（px）より桁違いに重くして、重なる配置を選ばせない。 */
const W_LABEL_OVERLAP = 100000;
const W_ANCHOR_COVER = 100000;
const W_LINE_ON_LABEL = 50000;
const W_LINE_CROSS = 30000;
const W_SOFT = 600;
/** 引き出し線が、ほかの段のデータのある範囲の中を通る、1 px あたりの費用。 */
const W_LEADER_OTHER = 3;
/** 座標降下の最大の巡回数。 */
const MAX_ROUNDS = 10;
/** 札ごとに、費用の小さい候補だけを組み合わせる数。これで重なりが解けなければ、全部の候補で試し直す。 */
const KEEP_BEST = 48;

const inflate = (r: Rect, m: number): Rect => ({ left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m });
const rectsOverlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const within = (r: Rect, b: Rect) => r.left >= b.left && r.top >= b.top && r.right <= b.right && r.bottom <= b.bottom;
const containsPoint = (r: Rect, p: Pt) => p[0] > r.left && p[0] < r.right && p[1] > r.top && p[1] < r.bottom;

/** 長方形の中で、点 p にいちばん近い点。 */
export function nearestOnRect(r: Rect, p: Pt): Pt {
  return [Math.min(r.right, Math.max(r.left, p[0])), Math.min(r.bottom, Math.max(r.top, p[1]))];
}

/** 線分 (a, b) が長方形 r を（縁をかすめるだけでなく）通るか。Liang–Barsky。 */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
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
  return clip(-dx, a[0] - r.left) && clip(dx, r.right - a[0]) && clip(-dy, a[1] - r.top) && clip(dy, r.bottom - a[1]) && t1 - t0 > 1e-9;
}

/** 線分 (a, b) と (c, d) が、端点以外で交わるか。 */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (o: Pt, p: Pt, q: Pt) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 判定を速くするために、辺ごとの値をあらかじめ求めた凸多角形。 */
interface Convex {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 辺ごと：内向きの法線 (nx, ny)、辺の始点 (px, py)、多角形の頂点の、法線への射影の最小・最大 */
  edges: { nx: number; ny: number; px: number; py: number; pmin: number; pmax: number }[];
}

function prepConvex(poly: readonly Pt[]): Convex {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  const sign = area >= 0 ? 1 : -1;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const edges = poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const nx = -sign * (q[1] - p[1]);
    const ny = sign * (q[0] - p[0]);
    let pmin = Infinity;
    let pmax = -Infinity;
    for (const v of poly) {
      const d = nx * v[0] + ny * v[1];
      if (d < pmin) pmin = d;
      if (d > pmax) pmax = d;
    }
    return { nx, ny, px: p[0], py: p[1], pmin, pmax };
  });
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), edges };
}

/** 凸多角形と長方形が（接するだけでなく）重なるか。分離軸判定（多角形の辺の法線）。 */
function convexHitsRect(c: Convex, r: Rect): boolean {
  if (c.maxX <= r.left || c.minX >= r.right || c.maxY <= r.top || c.minY >= r.bottom) return false;
  for (const e of c.edges) {
    // 長方形の4隅の、法線への射影の最小・最大
    const a = e.nx * r.left;
    const b = e.nx * r.right;
    const c0 = e.ny * r.top;
    const c1 = e.ny * r.bottom;
    const cmin = Math.min(a, b) + Math.min(c0, c1);
    const cmax = Math.max(a, b) + Math.max(c0, c1);
    if (e.pmax <= cmin || cmax <= e.pmin) return false;
  }
  return true;
}

/** 線分 (a, b) の、凸多角形の内側にある部分の長さ。Cyrus–Beck の線分切り取り。 */
function segmentInside(c: Convex, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const e of c.edges) {
    const num = e.nx * (a[0] - e.px) + e.ny * (a[1] - e.py);
    const den = e.nx * dx + e.ny * dy;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return 0;
      continue;
    }
    const t = -num / den;
    if (den > 0) {
      if (t > t0) t0 = t;
    } else if (t < t1) t1 = t;
    if (t0 >= t1) return 0;
  }
  return Math.hypot(dx, dy) * Math.max(0, t1 - t0);
}

/** 線分 (a, b) の、凸多角形の内側にある部分の長さ（多角形の向きによらない）。 */
export function segmentInsideConvex(a: Pt, b: Pt, poly: readonly Pt[]): number {
  return segmentInside(prepConvex(poly), a, b);
}

interface Candidate {
  rect: Rect;
  /** 札どうしの重なりの判定に使う、余白を足した長方形 */
  pad: Rect;
  /** 引き出し線と札の重なりの判定に使う、余白を足した長方形 */
  linePad: Rect;
  /** 目印が覆われていないかの判定に使う、余白を足した長方形 */
  coverPad: Rect;
  attach: Pt;
  /** 札ごとの費用（引き出し線の長さ、同じ段のデータの範囲にかかる分）。ほかの札との関係は含まない */
  own: number;
}

/** 札 it の候補。重ねてはいけない場所にかかるものは、最初から除く。費用の小さい順。 */
function candidatesOf(it: CalloutItem, o: CalloutObstacles, prepared: { polys: Convex[]; soft: Convex[]; leaderAvoid: Convex[] }): Candidate[] {
  const out: Candidate[] = [];
  const [ax, ay] = it.anchor;
  const keepOut = o.rects.map((r) => inflate(r, KEEP_OUT_MARGIN));
  for (let deg = 0; deg < 360; deg += ANGLE_STEP) {
    const t = (deg * Math.PI) / 180;
    const dx = Math.cos(t);
    const dy = Math.sin(t);
    const support = Math.abs(dx) * (it.w / 2) + Math.abs(dy) * (it.h / 2);
    for (const r of CALLOUT_DISTANCES) {
      const cx = ax + dx * (r + support);
      const cy = ay + dy * (r + support);
      const rect: Rect = { left: cx - it.w / 2, top: cy - it.h / 2, right: cx + it.w / 2, bottom: cy + it.h / 2 };
      if (!within(rect, o.bounds)) continue;
      if (keepOut.some((k) => rectsOverlap(rect, k))) continue;
      const padded = inflate(rect, KEEP_OUT_MARGIN);
      if (prepared.polys.some((p) => convexHitsRect(p, padded))) continue;
      const attach = nearestOnRect(rect, it.anchor);
      const len = Math.hypot(attach[0] - ax, attach[1] - ay);
      const soft = prepared.soft.some((p) => convexHitsRect(p, rect)) ? W_SOFT : 0;
      let across = 0;
      for (const p of prepared.leaderAvoid) across += segmentInside(p, it.anchor, attach);
      out.push({
        rect,
        pad: inflate(rect, LABEL_MARGIN / 2),
        linePad: inflate(rect, LINE_MARGIN),
        coverPad: inflate(rect, LABEL_MARGIN),
        attach,
        own: len + soft + W_LEADER_OTHER * across,
      });
    }
  }
  return out.sort((a, b) => a.own - b.own);
}

/** 候補 a（札 i）と候補 b（札 j）の組の、重なりの費用。 */
function pairCost(items: readonly CalloutItem[], i: number, a: Candidate, j: number, b: Candidate): number {
  let c = 0;
  if (rectsOverlap(a.pad, b.pad)) c += W_LABEL_OVERLAP;
  if (containsPoint(a.coverPad, items[j].anchor)) c += W_ANCHOR_COVER;
  if (containsPoint(b.coverPad, items[i].anchor)) c += W_ANCHOR_COVER;
  if (segmentHitsRect(items[i].anchor, a.attach, b.linePad)) c += W_LINE_ON_LABEL;
  if (segmentHitsRect(items[j].anchor, b.attach, a.linePad)) c += W_LINE_ON_LABEL;
  if (segmentsCross(items[i].anchor, a.attach, items[j].anchor, b.attach)) c += W_LINE_CROSS;
  return c;
}

/** 候補 cands（札ごと、費用の小さい順）から、重なりのない組み合わせを探す。座標降下を、巡回の順を変えて2回行い、費用の小さいほうを採る。 */
function solve(items: readonly CalloutItem[], cands: readonly Candidate[][], live: readonly number[]): { pick: Map<number, number>; cost: number } {
  const run = (order: readonly number[]) => {
    const pick = new Map<number, number>();
    for (const i of order) pick.set(i, 0); // 費用の小さい順なので、先頭が、札ごとの最良
    const costAgainst = (i: number, k: number) => {
      let c = cands[i][k].own;
      for (const j of live) if (j !== i) c += pairCost(items, i, cands[i][k], j, cands[j][pick.get(j) as number]);
      return c;
    };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false;
      for (const i of order) {
        let best = pick.get(i) as number;
        let bestCost = costAgainst(i, best);
        for (let k = 0; k < cands[i].length; k++) {
          if (cands[i][k].own >= bestCost) break; // 以降は、自分の費用だけで、いまより高い
          const c = costAgainst(i, k);
          if (c < bestCost - 1e-9) {
            best = k;
            bestCost = c;
          }
        }
        if (best !== pick.get(i)) {
          pick.set(i, best);
          changed = true;
        }
      }
      if (!changed) break;
    }
    let cost = 0;
    for (const i of order) {
      cost += cands[i][pick.get(i) as number].own;
      for (const j of order) if (j > i) cost += pairCost(items, i, cands[i][pick.get(i) as number], j, cands[j][pick.get(j) as number]);
    }
    return { pick, cost };
  };
  const a = run(live);
  const b = run([...live].reverse());
  return b.cost < a.cost ? b : a;
}

/**
 * 札を置く。各札の候補（目印のまわりの向きと距離）から、引き出し線が短く、重なりのない組み合わせを探す。
 * 札は高々数枚なので、まず札ごとに最良の候補を選び、1枚ずつ、ほかを固定して選び直す（座標降下）。
 */
export function placeCallouts(items: readonly CalloutItem[], o: CalloutObstacles): CalloutResult {
  const prepared = {
    polys: o.polys.map(prepConvex),
    soft: o.soft.map(prepConvex),
    leaderAvoid: (o.leaderAvoid ?? []).map(prepConvex),
  };
  const all = items.map((it) => candidatesOf(it, o, prepared));
  const live = items.map((_, i) => i).filter((i) => all[i].length > 0);
  const missing = items.filter((_, i) => all[i].length === 0).map((it) => it.id);

  // 費用の小さい候補だけで解く。重なりが残れば、全部の候補で解き直す。
  let cands = all.map((c) => c.slice(0, KEEP_BEST));
  let { pick, cost } = solve(items, cands, live);
  // 重なりの重みは、引き出し線の長さ（高々数百 px）より桁違いに大きい。費用がそれ以上なら、重なりが残っている。
  if (cost >= W_LINE_CROSS && all.some((c) => c.length > KEEP_BEST)) {
    cands = all;
    ({ pick, cost } = solve(items, cands, live));
  }
  const placed: PlacedCallout[] = live.map((i) => {
    const c = cands[i][pick.get(i) as number];
    return { id: items[i].id, rect: c.rect, anchor: items[i].anchor, attach: c.attach };
  });
  return { placed, missing, conflict: cost >= W_LINE_CROSS };
}
