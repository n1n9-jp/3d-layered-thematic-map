/**
 * 断面の表示の、純粋な計算。
 * - 右の列のグラフの座標の換算（線に沿った距離 d ⇄ 画面の x）と目盛り
 * - カーソルの位置の値（系列の値、いちばん近い交差や地物）
 * - 面グラフの形（色ごとの四角形、上の縁の折れ線）と、地図の中に立てるグラフの高さ
 * - レイヤーごとの1行の要約
 * deck.gl・React には依存しない。
 */
import type { LayerId } from '../config';
import { pointAt } from '../lib/section';
import type { SectionLine, SectionMarks, SectionSeries, SectionTrack } from '../types';

type Rgb = [number, number, number];
export type SeriesPoint = SectionSeries['points'][number];
export type Mark = SectionMarks['marks'][number];

/* ---------- 距離 ⇄ 画面の x ---------- */

/** グラフの横軸。left は、描画領域（グラフの外枠）の左端から、線の始点（d = 0）までの距離（px）。width は、始点から終点までの幅（px）。 */
export interface XScale {
  left: number;
  width: number;
  /** 線の長さ（m） */
  length: number;
}

export function dToX(s: XScale, d: number): number {
  return s.left + (s.length > 0 ? (d / s.length) * s.width : 0);
}

/** x（px）に対応する、線に沿った距離（m）。始点から終点までの外（左右の余白）は null。 */
export function xToD(s: XScale, x: number): number | null {
  if (!(s.width > 0) || !(s.length > 0)) return null;
  const t = (x - s.left) / s.width;
  if (!(t >= 0 && t <= 1)) return null;
  return t * s.length;
}

/* ---------- 目盛り ---------- */

/** range を count 個ほどに分ける、切りのよい刻み（1, 2, 5 × 10^n）。 */
export function niceStep(range: number, count: number): number {
  if (!(range > 0) || !(count > 0)) return 1;
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/** [lo, hi] の中の、step の倍数。 */
function multiplesIn(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  for (let k = first; k * step <= hi + step * 1e-9; k++) out.push(k * step + 0);
  return out;
}

/** 縦軸の目盛り（3つほど）。段（ランク）の系列は、すべての段（ラベルの重なりは、描く側で間引く）。 */
export function valueTicks(domain: readonly [number, number], ranks?: SectionSeries['ranks']): number[] {
  if (ranks) return ranks.map((r) => r.value);
  const [lo, hi] = domain;
  return multiplesIn(lo, hi, niceStep(hi - lo, 3));
}

/** 横軸の目盛り。線の長さ length（m）に対し、km で切りのよい間隔で 4〜8 本ほど。label は km の数字。 */
export function distanceTicks(length: number): { d: number; label: string }[] {
  if (!(length > 0)) return [];
  const stepKm = niceStep(length / 1000, 8);
  const dec = stepKm < 1 ? (stepKm < 0.1 ? 2 : 1) : 0;
  return multiplesIn(0, length / 1000, stepKm).map((km) => ({ d: km * 1000, label: km === 0 ? '0' : km.toFixed(dec) }));
}

/* ---------- 書式 ---------- */

/** 線の長さの表示（km、小数1桁）。 */
export function formatLength(m: number): string {
  return `${(m / 1000).toFixed(1)} km`;
}

/** 線に沿った距離の表示（km、小数1桁。1 km 未満の線でも読めるよう、短いときは m）。 */
export function formatAlong(m: number, length: number): string {
  return length < 3000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

const num = (v: number) => Math.round(v).toLocaleString('ja-JP');

/* ---------- カーソルの位置の値 ---------- */

/**
 * 系列の、線に沿った距離 d の値。いちばん近い点の値（標高は 25 m 間隔の標本、人口密度は階段の段）。
 * 系列の端（最初の点から最後の点まで）の外、点がないときは null。値がない区間も null。
 */
export function valueAt(series: SectionSeries, d: number): number | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  if (d < pts[0].d - 1e-6 || d > pts[pts.length - 1].d + 1e-6) return null;
  // d 以上になる最初の点
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d < d) lo = mid + 1;
    else hi = mid;
  }
  const next = pts[lo];
  const prev = pts[Math.max(0, lo - 1)];
  return Math.abs(d - prev.d) < Math.abs(next.d - d) ? prev.value : next.value;
}

/** 距離 d にいちばん近い交差や地物（tolerance m 以内）。同じ距離なら、線に近いほう。なければ null。 */
export function nearestMark(marks: readonly Mark[], d: number, tolerance: number): Mark | null {
  let best: Mark | null = null;
  let bestGap = Infinity;
  for (const m of marks) {
    const gap = Math.abs(m.d - d);
    if (gap > tolerance) continue;
    if (gap < bestGap || (gap === bestGap && best && Math.abs(m.offset) < Math.abs(best.offset))) {
      best = m;
      bestGap = gap;
    }
  }
  return best;
}

/** 線から離れた地物（駅、学校、病院）か。交差（道路、鉄道）は false。 */
const NEAR_CATEGORIES: ReadonlySet<string> = new Set(['station', 'school', 'hospital', 'shelter-usable', 'shelter-other']);
export function isNearMark(m: Pick<Mark, 'category'>): boolean {
  return NEAR_CATEGORIES.has(m.category);
}

/** 地物の名前の表示。名前がなければ種別。 */
export function markText(m: Mark): string {
  const side = m.offset > 0 ? '左' : '右';
  const where = isNearMark(m) ? `・線の${side} ${Math.round(Math.abs(m.offset))} m` : '';
  const flooded = m.exposed ? '・浸水が想定される区域' : '';
  return m.name ? `${m.name}（${m.categoryLabel}${where}${flooded}）` : `${m.categoryLabel}${where}${flooded}`;
}

/** 系列の値の文字列。段（ランク）の系列は、段の名前（0 は「浸水なし」）。数値の系列は、桁区切りと単位。 */
export function seriesValueText(t: SectionSeries, v: number): string {
  if (t.ranks) return v === 0 ? 'なし' : (t.ranks.find((r) => r.value === v)?.label ?? '—');
  return `${num(v)} ${t.unit}`;
}

/** カーソル位置 d の、そのレイヤーの値の文字列。値がなければ null。 */
export function readoutText(tracks: readonly SectionTrack[], d: number, toleranceM: number): string | null {
  const marks: Mark[] = [];
  for (const t of tracks) {
    if (t.kind === 'series') {
      const v = valueAt(t, d);
      return v === null ? null : `${t.label} ${seriesValueText(t, v)}`;
    }
    marks.push(...t.marks);
  }
  const m = nearestMark(marks, d, toleranceM);
  return m ? markText(m) : null;
}

/* ---------- 面グラフの形 ---------- */

/** 値 v を、縦軸の範囲 domain の中の 0〜1 に収めた位置。 */
export function normalize(v: number, domain: readonly [number, number]): number {
  const span = domain[1] - domain[0];
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (v - domain[0]) / span));
}

/** 値が、縦軸の上端を超えているか。 */
export const isCapped = (v: number, domain: readonly [number, number]): boolean => v > domain[1];

/** 面グラフの1区間（隣り合う2点の間）。色は区間の値の平均に対する、そのレイヤーの配色。 */
export interface BandQuad {
  d0: number;
  d1: number;
  /** 縦軸の範囲の中の位置（0〜1）。両端 */
  t0: number;
  t1: number;
  color: Rgb;
  /** 縦軸の上端を超えている区間か */
  capped: boolean;
}

/**
 * 系列から、面グラフの区間を作る。隣り合う2点がどちらも値を持ち、距離が離れているときだけ区間にする
 * （値がない区間と、階段の段差の（幅のない）縦の辺は、区間にならない）。
 * 面積のない区間（高さが両端とも 0）も作る（色の確認や、描かない判断は呼び出し側で行う）。
 */
export function bandQuads(series: SectionSeries): BandQuad[] {
  const out: BandQuad[] = [];
  const { points: pts, domain } = series;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.value === null || b.value === null || !(b.d > a.d)) continue;
    out.push({
      d0: a.d,
      d1: b.d,
      t0: normalize(a.value, domain),
      t1: normalize(b.value, domain),
      color: series.color((a.value + b.value) / 2),
      capped: isCapped(a.value, domain) || isCapped(b.value, domain),
    });
  }
  return out;
}

/** 面グラフの上の縁。値がある区間ごとの折れ線（階段状の系列では、段差の縦の辺も含む）。 */
export interface EdgeRun {
  points: { d: number; t: number; capped: boolean }[];
}

export function edgeRuns(series: SectionSeries): EdgeRun[] {
  const runs: EdgeRun[] = [];
  let cur: EdgeRun | null = null;
  for (const p of series.points) {
    if (p.value === null) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { points: [] };
      runs.push(cur);
    }
    cur.points.push({ d: p.d, t: normalize(p.value, series.domain), capped: isCapped(p.value, series.domain) });
  }
  return runs;
}

/** 色ごとにまとめた区間。同じ色の区間を1つの塗りにして、描く要素の数を減らす。 */
export function groupByColor(quads: readonly BandQuad[]): { color: Rgb; quads: BandQuad[] }[] {
  const groups = new Map<string, { color: Rgb; quads: BandQuad[] }>();
  for (const q of quads) {
    const key = q.color.join(',');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { color: q.color, quads: [] }));
    g.quads.push(q);
  }
  return [...groups.values()];
}

/* ---------- 地図の中に立てるグラフ ---------- */

/** 立てるグラフの高さの、段の間隔に対する割合の上限（6〜7割）。 */
export const STAND_RATIO = 0.65;
/** これより低くなる（間隔が狭い）ときは、立てない（m）。画面で 5〜6 px 未満になり、読めない。 */
export const STAND_MIN_HEIGHT = 600;

/** 立てるグラフの高さ（m）。間隔に比例して縮め、低すぎるとき（間隔 0 を含む）は 0（描かない）。 */
export function standHeight(spacing: number): number {
  if (!(spacing > 0)) return 0;
  const h = spacing * STAND_RATIO;
  return h < STAND_MIN_HEIGHT ? 0 : h;
}

type P3 = [number, number, number];

/** 切り口の面に立つ四角形の、4つの頂点（高さは段の平面から測る。t は 0〜1、h は立てる高さ）。 */
export function wallPolygon(line: SectionLine, q: Pick<BandQuad, 'd0' | 'd1' | 't0' | 't1'>, h: number): P3[] {
  const a = pointAt(line, q.d0);
  const b = pointAt(line, q.d1);
  return [
    [a.x, a.y, 0],
    [b.x, b.y, 0],
    [b.x, b.y, q.t1 * h],
    [a.x, a.y, q.t0 * h],
  ];
}

/** 面グラフの上の縁を、立てる面の上の折れ線にする。 */
export function edgePath(line: SectionLine, run: EdgeRun, h: number): P3[] {
  return run.points.map((p) => {
    const { x, y } = pointAt(line, p.d);
    return [x, y, p.t * h];
  });
}

/** 地物（交差、駅、学校、病院）を立てる位置。at は地物の地点（交差は線の上）、foot は線の上の同じ距離の地点。 */
export interface Post {
  mark: Mark;
  foot: { x: number; y: number };
  at: { x: number; y: number };
  near: boolean;
}

export function postsOf(line: SectionLine, tracks: readonly SectionTrack[]): Post[] {
  const out: Post[] = [];
  for (const t of tracks) {
    if (t.kind !== 'marks') continue;
    for (const m of t.marks) {
      out.push({ mark: m, foot: pointAt(line, m.d), at: { x: m.x, y: m.y }, near: isNearMark(m) });
    }
  }
  return out;
}

/* ---------- 要約 ---------- */

function seriesValues(t: SectionSeries): number[] {
  return t.points.flatMap((p) => (p.value === null ? [] : [p.value]));
}

/** そのレイヤーの断面の、1行の要約。 */
export function summaryLine(id: LayerId, tracks: readonly SectionTrack[]): string {
  const series = tracks.find((t): t is SectionSeries => t.kind === 'series');
  const markTracks = tracks.filter((t): t is SectionMarks => t.kind === 'marks');
  const all = markTracks.flatMap((t) => t.marks);
  switch (id) {
    case 'elevation': {
      const v = series ? seriesValues(series) : [];
      if (v.length === 0) return '標高のデータなし';
      return `標高 ${num(Math.min(...v))}〜${num(Math.max(...v))} m`;
    }
    case 'flood': {
      const v = series ? seriesValues(series) : [];
      if (v.length === 0 || !series) return '浸水想定のデータなし';
      const max = Math.max(...v);
      return `${series.label} 最大 ${seriesValueText(series, max)}`;
    }
    case 'population': {
      const v = series ? seriesValues(series) : [];
      if (v.length === 0) return `${series?.label ?? '人口密度'}のデータなし`;
      return `${series?.label ?? '人口密度'}の最大 ${num(Math.max(...v))} 人/km²`;
    }
    case 'transit': {
      const rail = all.filter((m) => m.category === 'rail').length;
      const stations = all.filter((m) => m.category === 'station').length;
      return `路線との交差 ${rail}・近くの駅 ${stations}`;
    }
    case 'shelters': {
      const usableMarks = all.filter((m) => m.category === 'shelter-usable');
      const other = all.filter((m) => m.category === 'shelter-other').length;
      const hospital = all.filter((m) => m.category === 'hospital').length;
      const known = usableMarks.some((m) => m.inside !== undefined);
      const inside = usableMarks.filter((m) => m.inside).length;
      const split = known ? `（区域の外 ${usableMarks.length - inside}・中 ${inside}）` : '';
      return `避難場所 洪水・高潮用 ${usableMarks.length}${split}・それ以外 ${other}・病院 ${hospital}`;
    }
    default: {
      return tracks.map((t) => t.label).join('・');
    }
  }
}

/** 人口密度などの系列で、縦軸の上端を超えた最大値。超えていなければ null。 */
export function cappedMax(series: SectionSeries): number | null {
  const v = seriesValues(series).filter((x) => isCapped(x, series.domain));
  return v.length ? Math.max(...v) : null;
}
