/**
 * 避難の段のデータ：指定緊急避難場所と病院。純粋な計算（読み込みの fetch と deck.gl の描画は `../shelters.ts`）。
 *
 * - 「洪水・高潮で使える」避難場所（`flood` か `tide` が true）を目立たせ、それ以外（地震・火事・津波・崖崩れなど）は控えめに出す。
 * - 避難場所は区による偏りが大きい。区は、避難場所の指定の状況で5通りに分かれる（`ShelterGap`。`../../aggregate/wardExposure.ts`）。
 *   データ未公開（`published: false`。0 件は「ない」ではなく「データがない」。灰の網掛け）を、その区の浸水の想定で2つに分ける：
 *     浸水が深い区（墨田・江東・葛飾。灰の網掛けに、琥珀の薄い塗りと縁を重ねる。「データがない」と「浸水が深い」の両方を見せる）、
 *     浸水が小さい区（渋谷。灰の網掛けだけ）。
 *   洪水・高潮用の指定が 0 件で、データを公開している区も、同じ基準で2つに分ける：
 *     浸水が深い区（足立・江戸川。琥珀色の斜線・塗り・縁）、浸水が小さい区（新宿・文京。ごく薄い塗りだけ）。
 *   洪水・高潮で使える場所のある区は、印なし。
 *   2つに分ける基準は、その区の浸水の想定（深さ 3m 以上の区域に住む人の割合）。区の名前は決め打ちにせず、データから求める。
 */
import { clipPolylineToCircle, pointInCircle } from '../../lib/circleClip';
import type { Circle } from '../../lib/circleClip';
import { hatchPolygon } from '../../lib/hatch';
import { createBoxIndex, isUsableLine, lineInsidePolygon, lineLength, projectOnLine } from '../../lib/section';
import type { BoxIndex } from '../../lib/section';
import { createPointIndex, pointInPolygon } from '../../lib/spatialIndex';
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
import { classifyWard, isDeepGap, isUnpublishedGap, shareLabel } from '../../aggregate/wardExposure';
import type { ShelterGap, WardExposure } from '../../aggregate/wardExposure';
import { simplifyPath } from '../simplify';
import { formatDistance } from '../format';

export type ShelterKind = 'usable' | 'other' | 'hospital';
type Rgb = [number, number, number];

/** 洪水・高潮で使える：鮮やかな緑。それ以外：くすんだ青灰。病院：赤。 */
export const SHELTER_COLORS: Record<ShelterKind, Rgb> = {
  usable: [60, 232, 140],
  other: [128, 140, 166],
  hospital: [255, 70, 60],
};
/** 網掛け（データ未公開の区）の色。 */
export const HATCH_COLOR: Rgb = [176, 182, 204];
/** 浸水が深いのに洪水・高潮用の指定がない区の色（琥珀）。避難の段の緑・赤、浸水の段の桃色と見分けられ、この地図の主題として目に留まる。 */
export const DEEP_NONE_COLOR: Rgb = [255, 170, 30];
/** 浸水が小さく洪水・高潮用の指定がない区の色（ごく薄い青灰。問題を示すものではないので、目立たせない）。 */
export const SHALLOW_NONE_COLOR: Rgb = [120, 136, 168];

/** 区の種類の名前（凡例・断面）。 */
export const GAP_LABEL: Record<ShelterGap, string> = {
  'unpublished-deep': 'データ未公開で浸水が深い',
  unpublished: 'データ未公開',
  'deep-none': '浸水が深いのに指定がない',
  'shallow-none': '浸水が小さく指定がない',
  unrated: '指定 0 件',
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
/** 浸水が深いのに指定がない区の斜線の間隔（m）。網掛け（データ未公開）より細かく、はっきりした色で引く。 */
const DEEP_HATCH_SPACING = 240;
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
  /** 区の人口のうち、浸水が想定される区域・深さ 3m 以上の区域に住む人の割合など（洪水と高潮の大きいほう）。求められなければ undefined */
  exposure?: WardExposure;
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
  /** 洪水・高潮で使える避難場所、病院の、最寄りを引く索引 */
  usable: KindIndex;
  hospital: KindIndex;
  boundary: BoundaryData;
  /** 23区の各区。避難場所を公開していない区、洪水・高潮用が 0 件の区の判定に使う */
  wards: WardInfo[];
  /** 描画用：データ未公開の区（浸水が深い・小さいの両方）の輪郭（間引いたもの）。切り出し（clip あり）では空 */
  gapPolygons: PolygonRings[];
  /** 描画用：データ未公開の区（浸水が深い・小さいの両方）の網掛けの線分（2点）。切り出しでは、円で切ったもの */
  hatch: Position[][];
  /**
   * 描画用：データ未公開で、浸水が深い区の、網掛けに重ねる琥珀の印。輪郭（塗り。間引いたもの）、縁の線（輪郭の線）、区名のラベル。
   * 切り出しでは、塗りは空、線は円で切ったもの
   */
  unpubDeep: { polygons: PolygonRings[]; outline: Position[][]; labels: WardLabel[] };
  /** 描画用：浸水が深いのに洪水・高潮用の指定がない区の輪郭（間引いたもの）、斜線の線分、縁の線（輪郭の線）。切り出しでは、塗りは空、線は円で切ったもの */
  deep: { polygons: PolygonRings[]; hatch: Position[][]; outline: Position[][]; labels: WardLabel[] };
  /** 描画用：浸水が小さく洪水・高潮用の指定がない区の輪郭（間引いたもの）。切り出しでは空 */
  shallow: PolygonRings[];
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
  kind: 'deep-none' | 'unpublished-deep';
}

/** 全体の地図に出す区名の札（浸水が深く、洪水・高潮用の避難場所が確認できない区）。 */
export const wardLabelsOf = (data: Pick<ShelterData, 'deep' | 'unpubDeep'>): WardLabel[] => [...data.deep.labels, ...data.unpubDeep.labels];

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
  /** 区ごとの浸水の想定（`computeWardExposure`）。渡さなければ、洪水・高潮用が 0 件の区は `unrated` になる */
  exposure?: ReadonlyMap<string, WardExposure>,
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
    const ex = exposure?.get(name);
    return {
      name,
      polygons: partsOf(f.geometry),
      ...info,
      total: counts.get(name)?.total ?? 0,
      gap: classifyWard(info, ex),
      exposure: ex,
    };
  });

  const gapPolygons: PolygonRings[] = [];
  const hatch: Position[][] = [];
  const deep: ShelterData['deep'] = { polygons: [], hatch: [], outline: [], labels: [] };
  const unpubDeep: ShelterData['unpubDeep'] = { polygons: [], outline: [], labels: [] };
  const shallow: PolygonRings[] = [];
  for (const w of wards) {
    if (!isUnpublishedGap(w.gap) && w.gap !== 'deep-none' && w.gap !== 'shallow-none') continue;
    for (const poly of w.polygons) {
      const simple = poly.map((ring) => simplifyPath(ring, HATCH_SIMPLIFY));
      if (isUnpublishedGap(w.gap)) {
        gapPolygons.push(simple);
        hatch.push(...hatchPolygon(simple, HATCH_SPACING));
        if (w.gap === 'unpublished-deep') {
          unpubDeep.polygons.push(simple);
          unpubDeep.outline.push(...simple);
        }
      } else if (w.gap === 'deep-none') {
        deep.polygons.push(simple);
        deep.hatch.push(...hatchPolygon(simple, DEEP_HATCH_SPACING));
        deep.outline.push(...simple);
      } else shallow.push(simple);
    }
    if (w.gap === 'deep-none' || w.gap === 'unpublished-deep') {
      const main = largestRing(w.polygons);
      if (main) {
        const kind = w.gap === 'deep-none' ? 'deep-none' : 'unpublished-deep';
        const status = kind === 'deep-none' ? '指定なし' : '未公開';
        (kind === 'deep-none' ? deep : unpubDeep).labels.push({ position: ringCentroid(main), text: `${w.name}\n${status}`, name: w.name, status, kind });
      }
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
    usable: kindIndex('usable'),
    hospital: kindIndex('hospital'),
    boundary,
    wards,
    gapPolygons,
    hatch,
    deep,
    unpubDeep,
    shallow,
    summary,
  };
}

/** 円にかかる区（種類ごと。洪水・高潮で使える場所のある区は含めない）。円の中心が区の中にあるか、区の輪郭が円の中を通る区。 */
export function wardsTouching(wards: readonly WardInfo[], circle: Circle): Record<ShelterGap, string[]> {
  const out: Record<ShelterGap, string[]> = { 'unpublished-deep': [], unpublished: [], 'deep-none': [], 'shallow-none': [], unrated: [] };
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
    usable: kindIndex('usable'),
    hospital: kindIndex('hospital'),
    gapPolygons: [],
    hatch,
    deep: {
      polygons: [],
      hatch: clipAll(data.deep.hatch),
      outline: clipAll(data.deep.outline),
      labels: data.deep.labels.filter((l) => pointInCircle(l.position[0], l.position[1], cx, cy, radius)),
    },
    unpubDeep: {
      polygons: [],
      outline: clipAll(data.unpubDeep.outline),
      labels: data.unpubDeep.labels.filter((l) => pointInCircle(l.position[0], l.position[1], cx, cy, radius)),
    },
    shallow: [],
    touching: wardsTouching(data.wards, circle),
    clip: circle,
  };
}

export function summarizeShelters(data: ShelterData): ProbeValue[] {
  const out: ProbeValue[] = [
    { label: '洪水・高潮で使える避難場所', value: data.points.usable.length, unit: 'か所' },
    { label: 'それ以外の避難場所', value: data.points.other.length, unit: 'か所' },
    { label: '病院', value: data.points.hospital.length, unit: '院' },
  ];
  const t = data.touching;
  if (t && t['unpublished-deep'].length > 0)
    out.push({ label: 'データ未公開で浸水が深い区', value: `${t['unpublished-deep'].join('・')}（避難場所のデータを公開していない。「ない」とは限らない）` });
  if (t && t.unpublished.length > 0) out.push({ label: 'データ未公開で浸水が小さい区', value: `${t.unpublished.join('・')}（避難場所のデータを公開していない。「ない」とは限らない）` });
  if (t && t['deep-none'].length > 0) out.push({ label: '浸水が深いのに洪水・高潮用の指定がない区', value: t['deep-none'].join('・') });
  if (t && t['shallow-none'].length > 0) out.push({ label: '浸水が小さく洪水・高潮用の指定がない区', value: t['shallow-none'].join('・') });
  if (t && t.unrated.length > 0) out.push({ label: '洪水・高潮用が 0 件の区', value: t.unrated.join('・') });
  return out;
}

/* ---------- 探針 ---------- */

/** 洪水か高潮か、その避難場所が使える災害の名前。 */
export function usageLabel(flood: boolean, tide: boolean): string {
  return flood && tide ? '洪水・高潮' : flood ? '洪水' : tide ? '高潮' : '洪水・高潮以外';
}

export function sampleShelters(data: ShelterData, x: number, y: number): ProbeValue[] {
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
  const ward = cachedDistrictLookup(data.boundary)(x, y);
  const info = ward === null ? undefined : data.wards.find((w) => w.name === ward);
  const note = info ? wardNote(info) : null;
  if (note) out.push({ label: 'この区のデータ', value: note });
  return out;
}

/**
 * 探針の「この区のデータ」の文。洪水・高潮で使える避難場所のある区は null。
 * 言えるのは、データに載っているか（指定の有無）と、区の人口のうち深さ 3m 以上の区域に住む人の割合まで。避難計画の内容は書かない。
 */
export function wardNote(w: WardInfo): string | null {
  const other = `地震・火事など ${w.total} 件`;
  const severe = w.exposure ? shareLabel(w.exposure.severeShare) : null;
  switch (w.gap) {
    case 'unpublished-deep':
      return `${w.name}は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）。人口の ${severe} が深さ 3m 以上の区域に住む：浸水が深い`;
    case 'unpublished':
      return severe === null
        ? `${w.name}は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）`
        : `${w.name}は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）。深さ 3m 以上の区域に住む人は人口の ${severe}：浸水が小さい`;
    case 'deep-none':
      return `${w.name}は洪水・高潮用の指定が 0 件（${other}）。人口の ${severe} が深さ 3m 以上の区域に住む：浸水が深いのに指定がない`;
    case 'shallow-none':
      return `${w.name}は洪水・高潮用の指定が 0 件（${other}）。深さ 3m 以上の区域に住む人は人口の ${severe}：浸水が小さく指定がない`;
    case 'unrated':
      return `${w.name}は洪水・高潮用の指定が 0 件（${other}）`;
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

/** 線が、データ未公開の区、洪水・高潮用が 0 件の区（浸水が深い・小さい）を通る区間。 */
export function sectionGaps(data: ShelterData, line: SectionLine): NonNullable<SectionMarks['gaps']> {
  const gaps: NonNullable<SectionMarks['gaps']> = [];
  if (!isUsableLine(line)) return gaps;
  for (const w of data.wards) {
    if (!w.gap) continue;
    const spans = mergeSpans(w.polygons.flatMap((p) => lineInsidePolygon(line, p as never)));
    const share = w.exposure ? `。人口の ${shareLabel(w.exposure.severeShare)} が深さ 3m 以上の区域に住む` : '';
    const label =
      w.gap === 'unpublished-deep'
        ? `${w.name}（データ未公開${share}：浸水が深い）`
        : w.gap === 'unpublished'
          ? `${w.name}（データ未公開${share ? `${share}：浸水が小さい` : ''}）`
          : w.gap === 'deep-none'
            ? `${w.name}（洪水・高潮用の指定 0 件${share}：浸水が深いのに指定がない）`
            : w.gap === 'shallow-none'
              ? `${w.name}（洪水・高潮用の指定 0 件${share}：浸水が小さく指定がない）`
              : `${w.name}（洪水・高潮用の指定 0 件）`;
    for (const [d0, d1] of spans) gaps.push({ d0, d1, kind: w.gap, label });
  }
  return gaps.sort((a, b) => a.d0 - b.d0);
}

/**
 * 線から `SHELTER_SECTION_RADIUS`（1 km）以内の避難場所と病院。線への垂線の足が線分の内側にあるものだけ。
 * 洪水・高潮で使える避難場所、それ以外の避難場所、病院を、カテゴリで見分ける。
 * 線が通る、データ未公開の区・洪水・高潮用が 0 件の区の区間（gaps）も付ける。
 */
export function sectionShelters(data: ShelterData, line: SectionLine): SectionMarks {
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
    track.marks.push({
      d,
      offset,
      category: k === 'hospital' ? 'hospital' : k === 'usable' ? 'shelter-usable' : 'shelter-other',
      categoryLabel: SHELTER_KIND_LABEL[k],
      name: data.name[i] || null,
      color: SHELTER_COLORS[k],
      x: data.all[i][0],
      y: data.all[i][1],
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
  /** 区の人口のうち、深さ 3m 以上の区域に住む人の割合（0〜1）。求められなければ null */
  severeShare: number | null;
  /** 区の人口のうち、浸水が想定される区域に住む人の割合（0〜1）。求められなければ null */
  floodedShare: number | null;
}

/** 洪水・高潮で使える避難場所の数と、種類ごとの区の一覧（23区全体の集計）。 */
export function shelterOverview(data: ShelterData): {
  usable: number;
  other: number;
  hospitals: number;
  /** 洪水・高潮用が 0 件で、浸水が深い区（深さ 3m 以上の区域に住む人の割合の大きい順） */
  deepNone: WardGapSummary[];
  /** データ未公開で、浸水が深い区（同じく割合の大きい順） */
  unpublishedDeep: WardGapSummary[];
  /** 浸水が深く、このデータで区内に洪水・高潮用の避難場所が確認できない区（deepNone と unpublishedDeep を合わせた数と名前） */
  deepWithoutShelter: WardGapSummary[];
  /** 洪水・高潮用が 0 件で、浸水が小さい区 */
  shallowNone: WardGapSummary[];
  /** データ未公開で、浸水が小さい区（浸水の想定を求められなかった区も入る） */
  unpublishedShallow: WardGapSummary[];
  /** データ未公開の区の名前（浸水が深い・小さいをまとめたもの） */
  unpublished: string[];
  /** 洪水・高潮用が 0 件の区の名前（浸水が深い・小さい・求められない、をまとめたもの。データ未公開の区は含めない） */
  zeroUsable: string[];
  updated: string;
} {
  const summaryOf = (w: WardInfo): WardGapSummary => ({
    name: w.name,
    total: w.total,
    severeShare: w.exposure ? w.exposure.severeShare : null,
    floodedShare: w.exposure ? w.exposure.floodedShare : null,
  });
  const byShare = (a: WardGapSummary, b: WardGapSummary) => (b.severeShare ?? 0) - (a.severeShare ?? 0);
  const of = (g: ShelterGap) => data.wards.filter((w) => w.gap === g).map(summaryOf);
  const deepNone = of('deep-none').sort(byShare);
  const unpublishedDeep = of('unpublished-deep').sort(byShare);
  return {
    usable: data.points.usable.length,
    other: data.points.other.length,
    hospitals: data.points.hospital.length,
    deepNone,
    unpublishedDeep,
    deepWithoutShelter: data.wards.filter((w) => isDeepGap(w.gap)).map(summaryOf).sort(byShare),
    shallowNone: of('shallow-none'),
    unpublishedShallow: of('unpublished'),
    unpublished: data.wards.filter((w) => isUnpublishedGap(w.gap)).map((w) => w.name),
    zeroUsable: data.wards.filter((w) => w.published && w.usable === 0).map((w) => w.name),
    updated: data.summary.updated,
  };
}

export { KINDS as SHELTER_KINDS };
