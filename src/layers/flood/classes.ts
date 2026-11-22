/**
 * 浸水想定（深さ・継続時間）の、段（クラス）の定義と配色。純粋関数のみ。
 *
 * - 深さの配色は、国のハザードマップ（浸水ナビ）で使われている浸水深の配色に揃える（利用者が見慣れているため）。
 * - 継続時間は、深さとは別の色相（青緑〜青）で、長いほど濃く・鮮やかにする。
 * - 想定は「洪水」「高潮」「大きいほう」。洪水と高潮は別々の災害の想定で、足し合わせない。「大きいほう」は、セルごとに、2つのうち大きい値を採る。
 * - 継続時間の最上段は、洪水と高潮で意味が違う（洪水は 1〜2週間・2〜4週間・4週間以上、高潮は 1週間以上でひとまとめ。上限は不明）。
 *   「大きいほう」では、この違いを残すために、段を9つにする。
 *
 * ランクの意味（`public/data/flood.json` の `depthRanks`・`durationRanks`・`tideDurationRanks`）と一致することは、読み込み時に確かめる。
 */
import type { FloodScenario, FloodView } from '../../config';

export type RGB = [number, number, number];

/** 格子の値：0 = 浸水なし、255 = 23区の外。 */
export const NONE = 0;
export const OUTSIDE = 255;

export interface FloodClass {
  /** 画面に出す名前（凡例・探針・クローズアップ）。 */
  label: string;
  /** 断面の縦軸に出す短い名前。 */
  short: string;
  color: RGB;
  /** 下限（深さは m、継続時間は時間）。 */
  min: number;
  /** 上限（含まない）。上限がなければ null。 */
  max: number | null;
  /** 上限が不明（高潮の1週間以上のように、「以上」としか分からない）。 */
  open?: boolean;
}

export interface FloodScheme {
  scenario: FloodScenario;
  view: FloodView;
  /** 凡例の見出し（例：「浸水の深さ（洪水と高潮の大きいほう）」） */
  title: string;
  /** 浸水なし（区内で、この想定の浸水がない所）。 */
  none: { label: string; color: RGB };
  /** 段。段の番号（位置）は、この配列の添字 + 1。0 は「浸水なし」。 */
  classes: FloodClass[];
  /** 洪水の値 r と高潮の値 t（どちらも格子の値）から、段の位置（0 = なし、1〜）を返す。23区の外（255）は null。 */
  position(river: number, tide: number): number | null;
}

/* ---------- 深さ ---------- */

/** 国のハザードマップの浸水深の配色（0.5m 未満 / 0.5〜3m / 3〜5m / 5〜10m / 10〜20m / 20m 以上）。 */
export const DEPTH_CLASSES: FloodClass[] = [
  { label: '0.5m 未満', short: '<0.5', color: [247, 245, 169], min: 0, max: 0.5 },
  { label: '0.5〜3m', short: '0.5-3', color: [255, 216, 192], min: 0.5, max: 3 },
  { label: '3〜5m', short: '3-5', color: [255, 183, 183], min: 3, max: 5 },
  { label: '5〜10m', short: '5-10', color: [255, 145, 145], min: 5, max: 10 },
  { label: '10〜20m', short: '10-20', color: [242, 133, 201], min: 10, max: 20 },
  { label: '20m 以上', short: '20+', color: [220, 122, 220], min: 20, max: null },
];

/** 区内で、浸水がない所の色（黒の背景の上で、区の形が読める暗い色）。 */
export const NONE_COLOR: RGB = [30, 34, 46];
/** 浸水の深さが「3m 以上」になる最初の段（断面の要約と、集計の「3m 以上」）。 */
export const SEVERE_DEPTH_POSITION = 3;

/* ---------- 継続時間 ---------- */

/**
 * 継続時間の9段の色。青緑（短い）から鮮やかな青（長い）へ、飽和度が単調に上がる。
 * 深さの色（黄・桃・紫）とは色相が離れている。黒の背景の上でも、どの段も読める明るさにする。
 */
export const DURATION_COLORS: RGB[] = [
  [200, 224, 221],
  [162, 215, 212],
  [119, 209, 212],
  [69, 197, 217],
  [28, 174, 227],
  [25, 147, 240],
  [37, 122, 248],
  [53, 93, 253],
  [71, 71, 255],
];

/**
 * 継続時間の、段の素になる定義（9つ）。lb = 下限（時間）。open = 上限が不明（「以上」）。
 * 洪水は 1〜4（共通）、5、7、9 を使い、高潮は 1〜4（共通）と 6 を使う。「大きいほう」は9つすべてを使う。
 */
interface Canon {
  label: string;
  short: string;
  min: number;
  max: number | null;
  open?: boolean;
}
const CANON: Canon[] = [
  { label: '12時間未満', short: '<12h', min: 0, max: 12 },
  { label: '12〜24時間', short: '12-24h', min: 12, max: 24 },
  { label: '1日〜3日', short: '1-3日', min: 24, max: 72 },
  { label: '3日〜1週間', short: '3日-1週', min: 72, max: 168 },
  { label: '1週間〜2週間', short: '1-2週', min: 168, max: 336 },
  { label: '1週間以上', short: '1週+', min: 168, max: null, open: true },
  { label: '2週間〜4週間', short: '2-4週', min: 336, max: 672 },
  { label: '2週間以上', short: '2週+', min: 336, max: null, open: true },
  { label: '4週間以上', short: '4週+', min: 672, max: null },
];

/** 継続時間の段（canon の位置は 1 始まり）。ラベルに、高潮の上限が不明であることを添える。 */
function durationClass(canonPos: number, extra?: string): FloodClass {
  const c = CANON[canonPos - 1];
  return { ...c, label: extra ? `${c.label}${extra}` : c.label, color: DURATION_COLORS[canonPos - 1] };
}

/** 洪水の継続時間のランク 1〜7 → canon の位置。 */
const RIVER_DURATION_CANON = [1, 2, 3, 4, 5, 7, 9];
/** 高潮の継続時間のランク 1〜5 → canon の位置（5 = 1週間以上）。 */
const TIDE_DURATION_CANON = [1, 2, 3, 4, 6];

const TIDE_OPEN_NOTE = '（高潮。上限なし）';

/**
 * 「大きいほう」の継続時間：洪水のランク r（0〜7）と高潮のランク t（0〜5）から、canon の位置（0 = なし）を返す。
 * 高潮の 5 は「1週間以上」で上限がないので、洪水が 2〜4週間（6）と重なるときは「2週間以上」、4週間以上（7）なら「4週間以上」。
 * 洪水が 1〜2週間（5）以下なら、「1週間以上」。高潮が 4 以下のときは、洪水の段をそのまま採る（洪水の段のほうが小さければ高潮の段）。
 */
export function maxDurationCanon(r: number, t: number): number {
  if (t === 5) return r >= 7 ? 9 : r === 6 ? 8 : 6;
  if (r === 0 && t === 0) return 0;
  if (r <= 4) return Math.max(r, t);
  if (r === 5) return 5;
  return r === 6 ? 7 : 9;
}

const SCENARIO_TITLE: Record<FloodScenario, string> = {
  max: '洪水と高潮の大きいほう',
  river: '洪水',
  tide: '高潮',
};
export const SCENARIO_LABEL = SCENARIO_TITLE;

function depthPosition(scenario: FloodScenario) {
  return (r: number, t: number): number | null => {
    if (scenario === 'river') return r === OUTSIDE ? null : r;
    if (scenario === 'tide') return t === OUTSIDE ? null : t;
    return r === OUTSIDE || t === OUTSIDE ? null : Math.max(r, t);
  };
}

function durationPosition(scenario: FloodScenario) {
  return (r: number, t: number): number | null => {
    if (scenario === 'river') return r === OUTSIDE ? null : r;
    if (scenario === 'tide') return t === OUTSIDE ? null : t;
    return r === OUTSIDE || t === OUTSIDE ? null : maxDurationCanon(r, t);
  };
}

const schemes = new Map<string, FloodScheme>();

/** 想定と見るものの組に対する、段・配色・位置の対応。同じ組には同じ（参照が等しい）ものを返す。 */
export function floodScheme(scenario: FloodScenario, view: FloodView): FloodScheme {
  const key = `${scenario}/${view}`;
  let s = schemes.get(key);
  if (s) return s;
  if (view === 'depth') {
    s = {
      scenario,
      view,
      title: `浸水の深さ（${SCENARIO_TITLE[scenario]}）`,
      none: { label: '浸水なし', color: NONE_COLOR },
      classes: DEPTH_CLASSES,
      position: depthPosition(scenario),
    };
  } else {
    const classes =
      scenario === 'river'
        ? RIVER_DURATION_CANON.map((p) => durationClass(p))
        : scenario === 'tide'
          ? TIDE_DURATION_CANON.map((p) => durationClass(p, p === 6 ? TIDE_OPEN_NOTE : undefined))
          : CANON.map((_, i) => durationClass(i + 1, i + 1 === 6 ? TIDE_OPEN_NOTE : undefined));
    s = {
      scenario,
      view,
      title: `水が引くまでの期間（${SCENARIO_TITLE[scenario]}）`,
      none: { label: '浸水なし（0.5m 未満を含む）', color: NONE_COLOR },
      classes,
      position: durationPosition(scenario),
    };
  }
  schemes.set(key, s);
  return s;
}

/** 段の位置（1〜）に対する段。0（なし）・範囲外は null。 */
export function classAt(scheme: FloodScheme, position: number): FloodClass | null {
  return position >= 1 ? (scheme.classes[position - 1] ?? null) : null;
}

/** 位置に対する色。0（浸水なし）は暗い色。 */
export function colorOf(scheme: FloodScheme, position: number): RGB {
  return classAt(scheme, position)?.color ?? scheme.none.color;
}

/** 位置に対する名前。0 は「浸水なし」。 */
export function labelOf(scheme: FloodScheme, position: number): string {
  return classAt(scheme, position)?.label ?? scheme.none.label;
}

/** 凡例（上の段＝深い・長いほうを先頭に）。浸水なし、の順は凡例側で付ける。 */
export function schemeLegend(scheme: FloodScheme): { color: RGB; label: string }[] {
  return [
    ...[...scheme.classes].reverse().map((c) => ({ color: c.color, label: c.label })),
    { color: scheme.none.color, label: scheme.none.label },
  ];
}

/* ---------- ランクの単独の読み（探針） ---------- */

/** 洪水・高潮それぞれの深さのランク（1〜6）の名前。 */
export function depthLabel(rank: number): string {
  return rank === NONE ? '浸水なし' : (DEPTH_CLASSES[rank - 1]?.label ?? '—');
}

/** 洪水の継続時間のランク（0〜7）の名前。 */
export function riverDurationLabel(rank: number): string {
  return rank === NONE ? '—' : (CANON[RIVER_DURATION_CANON[rank - 1] - 1]?.label ?? '—');
}

/** 高潮の継続時間のランク（0〜5）の名前。5 は「1週間以上」で、上限がない。 */
export function tideDurationLabel(rank: number): string {
  if (rank === NONE) return '—';
  const c = CANON[TIDE_DURATION_CANON[rank - 1] - 1];
  return c ? (c.open ? `${c.label}（上限なし）` : c.label) : '—';
}

/* ---------- flood.json との突き合わせ ---------- */

interface RankMeta {
  rank: number;
  label: string;
  minM?: number;
  maxM?: number | null;
  minH?: number;
  maxH?: number | null;
}
export interface FloodRanksMeta {
  depthRanks: RankMeta[];
  durationRanks: RankMeta[];
  tideDurationRanks: RankMeta[];
}

/** flood.json のランクの表が、この定義と一致するかを確かめる。違えば、食い違いの説明を返す（一致すれば null）。 */
export function checkRanksMeta(meta: FloodRanksMeta): string | null {
  const same = (a: RankMeta, c: FloodClass | Canon, hours: boolean) =>
    (hours ? a.minH === c.min && a.maxH === c.max : a.minM === c.min && a.maxM === c.max);
  if (meta.depthRanks?.length !== DEPTH_CLASSES.length) return 'depthRanks の件数が違います';
  for (const [i, c] of DEPTH_CLASSES.entries()) if (!same(meta.depthRanks[i], c, false)) return `depthRanks[${i}] が違います`;
  if (meta.durationRanks?.length !== RIVER_DURATION_CANON.length) return 'durationRanks の件数が違います';
  for (const [i, p] of RIVER_DURATION_CANON.entries()) if (!same(meta.durationRanks[i], CANON[p - 1], true)) return `durationRanks[${i}] が違います`;
  if (meta.tideDurationRanks?.length !== TIDE_DURATION_CANON.length) return 'tideDurationRanks の件数が違います';
  for (const [i, p] of TIDE_DURATION_CANON.entries()) if (!same(meta.tideDurationRanks[i], CANON[p - 1], true)) return `tideDurationRanks[${i}] が違います`;
  return null;
}
