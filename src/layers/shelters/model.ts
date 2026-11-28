/**
 * 避難の段のデータ：指定緊急避難場所と病院。純粋な計算（読み込みの fetch と deck.gl の描画は `../shelters.ts`）。
 *
 * - 「洪水・高潮で使える」避難場所（`flood` か `tide` が true）を目立たせ、それ以外（地震・火事・津波・崖崩れなど）は控えめに出す。
 * - 避難場所は区による偏りが大きい。洪水・高潮で使える避難場所が区内に確認できない区は、2通りに分かれる（`ShelterGap`）。
 *     指定なし（`none`）：データに載っていて、洪水・高潮用の指定が 0 件。輪郭の枠で示す。
 *     未公開（`unpublished`）：データに載っていない（`published: false`。0 件は「ない」ではなく「データがない」）。灰の網掛けで示す。
 *   どちらも警告色は使わない。浸水の深さは浸水の段が示すので、区の分け方には使わない。
 *   洪水・高潮で使える場所のある区は、印なし。区の名前は決め打ちにせず、データから求める。
 */
import { clipPolylineToCircle, pointInCircle } from '../../lib/circleClip';
import type { Circle } from '../../lib/circleClip';
import { hatchPolygon } from '../../lib/hatch';
import { createBoxIndex, isUsableLine, lineInsidePolygon, lineLength, projectOnLine } from '../../lib/section';
import type { BoxIndex } from '../../lib/section';
import { createPointIndex, pointInPolygon } from '../../lib/spatialIndex';
import { DEFAULT_OPTIONS } from '../../config';
import type { FloodScenario, LayerOptions } from '../../config';
import { SCENARIO_LABEL } from '../flood/classes';
import type { FloodData } from '../flood/model';
import { INSIDE_LABEL, INSIDE_MIN_DEPTH_M, OUTSIDE_LABEL, computeInundation } from './inundation';
import type { Inundation } from './inundation';
import type { PointIndex, PolygonRings } from '../../lib/spatialIndex';
import { cachedDistrictLookup } from '../../probe/district';
import type {
  BoundaryData,
  FacilityCollection,
  Position,
  ProbeValue,
  SectionLine,
  SectionMarks,
  ShelterCollection,
  ShelterSummary,
} from '../../types';
import { simplifyPath } from '../simplify';
import { formatDistance } from '../format';

export type ShelterKind = 'usable' | 'other' | 'hospital';

/**
 * 洪水・高潮で使える避難場所が区内に確認できない区の種類。使える区は null。
 *   none        : 指定なし（データに載っていて、洪水・高潮用の指定が 0 件。地震・火事などの避難場所のみ）
 *   unpublished : 未公開（データに載っていない。あるかどうかは分からない）
 */
export type ShelterGap = 'none' | 'unpublished';

export interface WardShelterFacts {
  published: boolean;
  /** 洪水か高潮で使える避難場所の数 */
  usable: number;
}

/** 区の分類。洪水・高潮で使える避難場所がある区は null。 */
export function classifyWard(ward: WardShelterFacts): ShelterGap | null {
  if (!ward.published) return 'unpublished';
  return ward.usable > 0 ? null : 'none';
}
type Rgb = [number, number, number];

/** 洪水・高潮で使える：鮮やかな緑。それ以外：くすんだ青灰。病院：赤。 */
export const SHELTER_COLORS: Record<ShelterKind, Rgb> = {
  usable: [60, 232, 140],
  other: [128, 140, 166],
  hospital: [255, 70, 60],
};
/** 網掛け（未公開の区）の色。 */
export const HATCH_COLOR: Rgb = [176, 182, 204];
/** 輪郭の枠（指定なしの区）の色。警告色にせず、地図の背景から静かに浮く明るい青灰にする。 */
export const NONE_COLOR: Rgb = [214, 224, 244];

/** 区の種類の名前（凡例・断面）。 */
export const GAP_LABEL: Record<ShelterGap, string> = {
  none: '指定なし',
  unpublished: '未公開',
};

export const SHELTER_KIND_LABEL: Record<ShelterKind, string> = {
  usable: '避難場所（洪水・高潮用）',
  other: '避難場所（それ以外）',
  hospital: '病院',
};

/** 断面で、線から何 m 以内の避難場所・病院を出すか（徒歩で十数分の距離）。 */
export const SHELTER_SECTION_RADIUS = 1000;
/** 網掛けの線の間隔（m）。 */
const HATCH_SPACING = 380;
/** 網掛けと塗りに使う区の輪郭を間引く許容誤差（m）。 */
const HATCH_SIMPLIFY = 25;

export interface WardInfo {
  name: string;
  polygons: PolygonRings[];
  /** この区が、避難場所のデータを公開しているか */
  published: boolean;
  /** 洪水か高潮で使える避難場所の数（データから数えた値） */
  usable: number;
  total: number;
  /** 区の種類。洪水・高潮で使える避難場所のある区は null */
  gap: ShelterGap | null;
}

interface KindIndex {
  index: PointIndex;
  /** index の添字 → ShelterData の全体の添字 */
  ids: number[];
}

export interface ShelterData {
  /** 避難場所と病院の全点。以下の配列と同じ添字 */
  all: Position[];
  kind: ShelterKind[];
  name: string[];
  /** 避難場所の区名。病院は '' */
  ward: string[];
  flood: boolean[];
  tide: boolean[];
  /** 種別ごとの点。描画用 */
  points: Record<ShelterKind, Position[]>;
  /**
   * 想定ごとの、各点が浸水が想定される区域の中か（1 = 中、0 = 外。添字は all と同じ。洪水・高潮で使える避難場所だけが意味を持つ）。
   * 浸水想定のデータが読めなかったときは null（中・外は分からない）。
   */
  inside: Inundation | null;
  /** 洪水・高潮で使える避難場所、病院の、最寄りを引く索引 */
  usable: KindIndex;
  hospital: KindIndex;
  boundary: BoundaryData;
  /** 23区の各区。避難場所を公開していない区、洪水・高潮用が 0 件の区の判定に使う */
  wards: WardInfo[];
  /** 描画用：未公開の区の輪郭（間引いたもの）。切り出し（clip あり）では空 */
  gapPolygons: PolygonRings[];
  /** 描画用：未公開の区の網掛けの線分（2点）。切り出しでは、円で切ったもの */
  hatch: Position[][];
  /** 描画用：指定なしの区の縁の線（輪郭の線）。切り出しでは、円で切ったもの */
  frame: Position[][];
  /** 区名の札（指定なし・未公開の区）。切り出しでは、円の中の目印だけ */
  labels: WardLabel[];
  summary: ShelterSummary;
  /** subset の結果のとき、円がかかる区の名前（種類ごと） */
  touching?: Record<ShelterGap, string[]>;
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

/**
 * 区名の札。position は札が指す区の目印（区の最大の外周の重心。ローカル座標）。
 * 全体の地図では、札は目印から離して置く（`src/view/wardLabels.ts`）。クローズアップの円の中では、text を目印の位置にそのまま出す。
 */
export interface WardLabel {
  position: Position;
  /** 「足立区\n指定なし」のように、区名と、避難場所の状況の2行 */
  text: string;
  name: string;
  /** 札の2行目。「指定なし」（データに載っていて洪水・高潮用が 0 件）か、「未公開」（データに載っていない） */
  status: string;
  kind: ShelterGap;
}

/** 全体の地図に出す区名の札（洪水・高潮用の避難場所が区内に確認できない区）。 */
export const wardLabelsOf = (data: Pick<ShelterData, 'labels'>): WardLabel[] => data.labels;

const KINDS: ShelterKind[] = ['usable', 'other', 'hospital'];

/** 多角形の列のうち、外周の面積が最大のものの外周。 */
function largestRing(polygons: readonly PolygonRings[]): Position[] | null {
  let best: Position[] | null = null;
  let bestArea = -1;
  for (const p of polygons) {
    const ring = p[0] as Position[] | undefined;
    if (!ring) continue;
    const a = Math.abs(ringSignedArea(ring));
    if (a > bestArea) {
      best = ring;
      bestArea = a;
    }
  }
  return best;
}

function ringSignedArea(ring: readonly Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** 外周の面積の重心（ラベルを置く位置）。面積が 0 なら頂点の平均。 */
function ringCentroid(ring: readonly Position[]): Position {
  const a = ringSignedArea(ring);
  if (Math.abs(a) < 1e-9) {
    const n = Math.max(1, ring.length);
    return [ring.reduce((t, p) => t + p[0], 0) / n, ring.reduce((t, p) => t + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [Math.round(cx / (6 * a)), Math.round(cy / (6 * a))];
}

function partsOf(g: BoundaryData['features'][number]['geometry']): PolygonRings[] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

export function buildShelterData(
  shelters: ShelterCollection,
  summary: ShelterSummary,
  facilities: FacilityCollection,
  boundary: BoundaryData,
  floodData: FloodData | null = null,
): ShelterData {
  const all: Position[] = [];
  const kind: ShelterKind[] = [];
  const name: string[] = [];
  const ward: string[] = [];
  const flood: boolean[] = [];
  const tide: boolean[] = [];
  const points: Record<ShelterKind, Position[]> = { usable: [], other: [], hospital: [] };
  const push = (k: ShelterKind, p: Position, nm: string, w: string, f: boolean, t: boolean) => {
    all.push(p);
    kind.push(k);
    name.push(nm);
    ward.push(w);
    flood.push(f);
    tide.push(t);
    points[k].push(p);
  };
  for (const f of shelters.features) {
    const p = f.geometry?.coordinates;
    if (!p) continue;
    const { flood: fl, tide: ti } = f.properties;
    push(fl || ti ? 'usable' : 'other', p, f.properties.name, f.properties.ward, fl === true, ti === true);
  }
  for (const f of facilities.features) {
    if (f.properties?.kind !== 'hospital') continue;
    const p = f.geometry?.coordinates;
    if (p) push('hospital', p, f.properties.name || '病院', '', false, false);
  }

  const kindIndex = (k: ShelterKind): KindIndex => {
    const ids: number[] = [];
    kind.forEach((kk, i) => kk === k && ids.push(i));
    return { index: createPointIndex(ids.map((i) => all[i])), ids };
  };

  const published = new Map(summary.wards.map((w) => [w.name, w.published]));
  const counts = new Map<string, { total: number; usable: number }>();
  kind.forEach((k, i) => {
    if (k === 'hospital') return;
    const c = counts.get(ward[i]) ?? { total: 0, usable: 0 };
    c.total++;
    if (k === 'usable') c.usable++;
    counts.set(ward[i], c);
  });
  const wards: WardInfo[] = boundary.features.map((f) => {
    const name = f.properties.name;
    const info = {
      published: published.get(name) !== false,
      usable: counts.get(name)?.usable ?? 0,
    };
    return {
      name,
      polygons: partsOf(f.geometry),
      ...info,
      total: counts.get(name)?.total ?? 0,
      gap: classifyWard(info),
    };
  });

  const gapPolygons: PolygonRings[] = [];
  const hatch: Position[][] = [];
  const frame: Position[][] = [];
  const labels: WardLabel[] = [];
  for (const w of wards) {
    if (!w.gap) continue;
    for (const poly of w.polygons) {
      const simple = poly.map((ring) => simplifyPath(ring, HATCH_SIMPLIFY));
      if (w.gap === 'unpublished') {
        gapPolygons.push(simple);
        hatch.push(...hatchPolygon(simple, HATCH_SPACING));
      } else frame.push(...simple);
    }
    const main = largestRing(w.polygons);
    if (main) {
      const status = GAP_LABEL[w.gap];
      labels.push({ position: ringCentroid(main), text: `${w.name}\n${status}`, name: w.name, status, kind: w.gap });
    }
  }

  return {
    all,
    kind,
    name,
    ward,
    flood,
    tide,
    points,
    inside: floodData ? computeInundation(all, floodData) : null,
    usable: kindIndex('usable'),
    hospital: kindIndex('hospital'),
    boundary,
    wards,
    gapPolygons,
    hatch,
    frame,
    labels,
    summary,
  };
}

/** 円にかかる区（種類ごと。洪水・高潮で使える場所のある区は含めない）。円の中心が区の中にあるか、区の輪郭が円の中を通る区。 */
export function wardsTouching(wards: readonly WardInfo[], circle: Circle): Record<ShelterGap, string[]> {
  const out: Record<ShelterGap, string[]> = { none: [], unpublished: [] };
  for (const w of wards) {
    if (!w.gap) continue;
    const inside = w.polygons.some((p) => pointInPolygon(circle.cx, circle.cy, p));
    const crosses = !inside && w.polygons.some((p) => p.some((ring) => clipPolylineToCircle(ring, circle.cx, circle.cy, circle.r).length > 0));
    if (inside || crosses) out[w.gap].push(w.name);
  }
  return out;
}

/** 円の中にある避難場所・病院だけを取り出す（縁の上は中）。網掛けは円で切る。 */
export function subsetShelters(data: ShelterData, cx: number, cy: number, radius: number): ShelterData {
  const circle = { cx, cy, r: radius };
  const keep: number[] = [];
  data.all.forEach((p, i) => pointInCircle(p[0], p[1], cx, cy, radius) && keep.push(i));
  const pick = <T,>(a: readonly T[]) => keep.map((i) => a[i]);
  const all = pick(data.all);
  const kind = pick(data.kind);
  const points: Record<ShelterKind, Position[]> = { usable: [], other: [], hospital: [] };
  all.forEach((p, i) => points[kind[i]].push(p));
  const kindIndex = (k: ShelterKind): KindIndex => {
    const ids: number[] = [];
    kind.forEach((kk, i) => kk === k && ids.push(i));
    return { index: createPointIndex(ids.map((i) => all[i])), ids };
  };
  const hatch = data.hatch.flatMap((seg) => clipPolylineToCircle(seg, cx, cy, radius));
  const clipAll = (paths: Position[][]) => paths.flatMap((seg) => clipPolylineToCircle(seg, cx, cy, radius));
  return {
    ...data,
    all,
    kind,
    name: pick(data.name),
    ward: pick(data.ward),
    flood: pick(data.flood),
    tide: pick(data.tide),
    points,
    inside: data.inside && {
      max: Uint8Array.from(keep, (i) => data.inside!.max[i]),
      river: Uint8Array.from(keep, (i) => data.inside!.river[i]),
      tide: Uint8Array.from(keep, (i) => data.inside!.tide[i]),
    },
    usable: kindIndex('usable'),
    hospital: kindIndex('hospital'),
    gapPolygons: [],
    hatch,
    frame: clipAll(data.frame),
    labels: data.labels.filter((l) => pointInCircle(l.position[0], l.position[1], cx, cy, radius)),
    touching: wardsTouching(data.wards, circle),
    clip: circle,
  };
}

/* ---------- 洪水・高潮で使える避難場所の、浸水が想定される区域の中・外 ---------- */

/** 洪水・高潮で使える避難場所を、想定 scenario の浸水が想定される区域の外・中に分けた点（描画用）。浸水想定が読めていなければ、すべて外に置く（`known` が false）。 */
export interface UsableSplit {
  out: Position[];
  in: Position[];
  /** 中・外の判定ができているか（浸水想定のデータが読めているか） */
  known: boolean;
}

const splits = new WeakMap<ShelterData, Map<FloodScenario, UsableSplit>>();

/** 想定ごとの分け方。データと想定の組ごとに1回だけ作る（描画のたびには作らない）。 */
export function usableSplit(data: ShelterData, scenario: FloodScenario): UsableSplit {
  let byScenario = splits.get(data);
  if (!byScenario) splits.set(data, (byScenario = new Map()));
  let split = byScenario.get(scenario);
  if (!split) {
    const flags = data.inside?.[scenario] ?? null;
    split = { out: [], in: [], known: flags !== null };
    data.kind.forEach((k, i) => {
      if (k !== 'usable') return;
      (flags && flags[i] === 1 ? split!.in : split!.out).push(data.all[i]);
    });
    byScenario.set(scenario, split);
  }
  return split;
}

/** 全体の添字 i の洪水・高潮で使える避難場所が、想定 scenario の浸水が想定される区域の中か。判定できないとき（浸水想定が読めていない）は null。 */
export function insideOf(data: ShelterData, scenario: FloodScenario, i: number): boolean | null {
  return data.inside ? data.inside[scenario][i] === 1 : null;
}

/** 洪水・高潮で使える避難場所の、区域の外・中の数。判定できないときは null。 */
export function insideCounts(data: ShelterData, scenario: FloodScenario): { out: number; in: number } | null {
  const s = usableSplit(data, scenario);
  return s.known ? { out: s.out.length, in: s.in.length } : null;
}

/** 位置の読み。「浸水が想定される区域の中（洪水と高潮の大きいほうの想定で、深さ 0.5m 以上）」。使える・使えないは言わない。 */
export function insideText(inside: boolean, scenario: FloodScenario): string {
  return inside
    ? `${INSIDE_LABEL}（${SCENARIO_LABEL[scenario]}の想定で、深さ ${INSIDE_MIN_DEPTH_M}m 以上）`
    : `${OUTSIDE_LABEL}（${SCENARIO_LABEL[scenario]}の想定で、深さ ${INSIDE_MIN_DEPTH_M}m 未満か浸水なし）`;
}

export function summarizeShelters(data: ShelterData, options: LayerOptions = DEFAULT_OPTIONS): ProbeValue[] {
  const counts = insideCounts(data, options.floodScenario);
  const out: ProbeValue[] = [
    { label: '洪水・高潮で使える避難場所', value: data.points.usable.length, unit: 'か所' },
    ...(counts
      ? [
          { label: `うち${OUTSIDE_LABEL}`, value: counts.out, unit: 'か所' },
          { label: `うち${INSIDE_LABEL}`, value: counts.in, unit: 'か所' },
        ]
      : []),
    { label: 'それ以外の避難場所', value: data.points.other.length, unit: 'か所' },
    { label: '病院', value: data.points.hospital.length, unit: '院' },
  ];
  const t = data.touching;
  if (t && t.none.length > 0) out.push({ label: '指定なしの区', value: `${t.none.join('・')}（洪水・高潮用の指定が 0 件）` });
  if (t && t.unpublished.length > 0) out.push({ label: '未公開の区', value: `${t.unpublished.join('・')}（避難場所のデータを公開していない。「ない」とは限らない）` });
  return out;
}

/* ---------- 探針 ---------- */

/** 洪水か高潮か、その避難場所が使える災害の名前。 */
export function usageLabel(flood: boolean, tide: boolean): string {
  return flood && tide ? '洪水・高潮' : flood ? '洪水' : tide ? '高潮' : '洪水・高潮以外';
}

export function sampleShelters(data: ShelterData, x: number, y: number, options: LayerOptions = DEFAULT_OPTIONS): ProbeValue[] {
  if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r))
    return [
      { label: '最寄りの避難場所', value: null },
      { label: '最寄りの病院', value: null },
    ];
  const near = (k: KindIndex) => {
    const hit = k.index.nearest(x, y);
    return hit ? { i: k.ids[hit.index], distance: hit.distance } : null;
  };
  const shelter = near(data.usable);
  const hospital = near(data.hospital);
  const out: ProbeValue[] = [
    {
      label: '最寄りの避難場所',
      value: shelter
        ? `${data.name[shelter.i]}（${data.ward[shelter.i]}・${usageLabel(data.flood[shelter.i], data.tide[shelter.i])}・${formatDistance(shelter.distance)}）`
        : null,
    },
    {
      label: '最寄りの病院',
      value: hospital ? `${data.name[hospital.i]}（${formatDistance(hospital.distance)}）` : null,
    },
  ];
  const nearInside = shelter ? insideOf(data, options.floodScenario, shelter.i) : null;
  if (nearInside !== null) out.push({ label: '最寄りの避難場所の位置', value: insideText(nearInside, options.floodScenario) });
  const ward = cachedDistrictLookup(data.boundary)(x, y);
  const info = ward === null ? undefined : data.wards.find((w) => w.name === ward);
  const note = info ? wardNote(info) : null;
  if (note) out.push({ label: 'この区のデータ', value: note });
  return out;
}

/**
 * 探針の「この区のデータ」の文。洪水・高潮で使える避難場所のある区は null。
 * 言えるのは、データに載っているか（指定の有無）まで。避難計画の内容は書かない。
 */
export function wardNote(w: WardInfo): string | null {
  switch (w.gap) {
    case 'unpublished':
      return `${w.name}は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）`;
    case 'none':
      return `${w.name}は指定なし（洪水・高潮用の指定が 0 件。地震・火事など ${w.total} 件）`;
    default:
      return null;
  }
}

/* ---------- 断面 ---------- */

const sectionIndexes = new WeakMap<ShelterData, BoxIndex>();

/** 断面用の索引（点の格子）。データごとに1回だけ作る（load が先に作っておく）。 */
export function shelterSectionIndex(data: ShelterData): BoxIndex {
  let idx = sectionIndexes.get(data);
  if (!idx) {
    const pts = new Float64Array(data.all.length * 4);
    data.all.forEach(([x, y], i) => pts.set([x, y, x, y], 4 * i));
    idx = createBoxIndex(pts);
    sectionIndexes.set(data, idx);
  }
  return idx;
}

/** 区間（昇順）を、重なりをつないで1つにする。 */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** 線が、未公開の区、指定なしの区を通る区間。 */
export function sectionGaps(data: ShelterData, line: SectionLine): NonNullable<SectionMarks['gaps']> {
  const gaps: NonNullable<SectionMarks['gaps']> = [];
  if (!isUsableLine(line)) return gaps;
  for (const w of data.wards) {
    if (!w.gap) continue;
    const spans = mergeSpans(w.polygons.flatMap((p) => lineInsidePolygon(line, p as never)));
    const label = w.gap === 'unpublished' ? `${w.name}（未公開：データに載っていない）` : `${w.name}（指定なし：洪水・高潮用の指定 0 件）`;
    for (const [d0, d1] of spans) gaps.push({ d0, d1, kind: w.gap, label });
  }
  return gaps.sort((a, b) => a.d0 - b.d0);
}

/**
 * 線から `SHELTER_SECTION_RADIUS`（1 km）以内の避難場所と病院。線への垂線の足が線分の内側にあるものだけ。
 * 洪水・高潮で使える避難場所、それ以外の避難場所、病院を、カテゴリで見分ける。
 * 線が通る、データ未公開の区・洪水・高潮用が 0 件の区の区間（gaps）も付ける。
 */
export function sectionShelters(data: ShelterData, line: SectionLine, options: LayerOptions = DEFAULT_OPTIONS): SectionMarks {
  const track: SectionMarks = { kind: 'marks', label: '近くの避難場所・病院', marks: [], radius: SHELTER_SECTION_RADIUS, gaps: [] };
  if (!isUsableLine(line)) return track;
  const len = lineLength(line);
  const found: { i: number; d: number; offset: number }[] = [];
  shelterSectionIndex(data).near(line, SHELTER_SECTION_RADIUS, (i) => {
    const pr = projectOnLine(line, data.all[i][0], data.all[i][1]);
    if (!pr || pr.d < 0 || pr.d > len || Math.abs(pr.offset) > SHELTER_SECTION_RADIUS) return;
    found.push({ i, d: pr.d, offset: pr.offset });
  });
  found.sort((a, b) => a.d - b.d || a.i - b.i);
  for (const { i, d, offset } of found) {
    const k = data.kind[i];
    const inside = k === 'usable' ? insideOf(data, options.floodScenario, i) : null;
    track.marks.push({
      d,
      offset,
      category: k === 'hospital' ? 'hospital' : k === 'usable' ? 'shelter-usable' : 'shelter-other',
      categoryLabel: inside === null ? SHELTER_KIND_LABEL[k] : `${SHELTER_KIND_LABEL[k]}・${inside ? INSIDE_LABEL : OUTSIDE_LABEL}`,
      name: data.name[i] || null,
      color: SHELTER_COLORS[k],
      x: data.all[i][0],
      y: data.all[i][1],
      ...(inside === null ? {} : { inside }),
    });
  }
  // 区の間（クローズアップの切り出しでも、線が円の外にある区間は、円の外のデータがないので、gaps は付けない）
  track.gaps = data.clip ? [] : sectionGaps(data, line);
  return track;
}

export interface WardGapSummary {
  name: string;
  /** 洪水・高潮用ではない避難場所（地震・火事など）の数 */
  total: number;
}

/** 洪水・高潮で使える避難場所の数と、種類ごとの区の一覧（23区全体の集計）。 */
export function shelterOverview(data: ShelterData): {
  usable: number;
  other: number;
  hospitals: number;
  /** 指定なしの区（データに載っていて、洪水・高潮用が 0 件） */
  none: WardGapSummary[];
  /** 未公開の区の名前 */
  unpublished: string[];
  updated: string;
} {
  return {
    usable: data.points.usable.length,
    other: data.points.other.length,
    hospitals: data.points.hospital.length,
    none: data.wards.filter((w) => w.gap === 'none').map((w) => ({ name: w.name, total: w.total })),
    unpublished: data.wards.filter((w) => w.gap === 'unpublished').map((w) => w.name),
    updated: data.summary.updated,
  };
}

export { KINDS as SHELTER_KINDS };
