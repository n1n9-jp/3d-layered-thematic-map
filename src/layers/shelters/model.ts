/**
 * 避難の段のデータ：指定緊急避難場所と病院。純粋な計算（読み込みの fetch と deck.gl の描画は `../shelters.ts`）。
 *
 * - 「洪水・高潮で使える」避難場所（`flood` か `tide` が true）を目立たせ、それ以外（地震・火事・津波・崖崩れなど）は控えめに出す。
 * - 避難場所は区による偏りが大きい。墨田・江東・渋谷・葛飾の4区は、このデータに指定緊急避難場所を公開していない（`published: false`）。
 *   その区の 0 件は「ない」ではなく「データがない」。画面では網掛けで示す。
 *   江戸川・足立は、公開しているが、洪水・高潮で使える場所が 0 件。
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
  /** 描画用：データ未公開の区の輪郭（間引いたもの）。切り出し（clip あり）では空 */
  gapPolygons: PolygonRings[];
  /** 描画用：データ未公開の区の網掛けの線分（2点）。切り出しでは、円で切ったもの */
  hatch: Position[][];
  summary: ShelterSummary;
  /** subset の結果のとき、円がかかる区（網掛けの区、洪水・高潮用が 0 件の区の名前） */
  touching?: { unpublished: string[]; none: string[] };
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

const KINDS: ShelterKind[] = ['usable', 'other', 'hospital'];

function partsOf(g: BoundaryData['features'][number]['geometry']): PolygonRings[] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

export function buildShelterData(
  shelters: ShelterCollection,
  summary: ShelterSummary,
  facilities: FacilityCollection,
  boundary: BoundaryData,
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
  const wards: WardInfo[] = boundary.features.map((f) => ({
    name: f.properties.name,
    polygons: partsOf(f.geometry),
    published: published.get(f.properties.name) !== false,
    usable: counts.get(f.properties.name)?.usable ?? 0,
    total: counts.get(f.properties.name)?.total ?? 0,
  }));

  const gapPolygons: PolygonRings[] = [];
  const hatch: Position[][] = [];
  for (const w of wards) {
    if (w.published) continue;
    for (const poly of w.polygons) {
      const simple = poly.map((ring) => simplifyPath(ring, HATCH_SIMPLIFY));
      gapPolygons.push(simple);
      hatch.push(...hatchPolygon(simple, HATCH_SPACING));
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
    summary,
  };
}

/** 円にかかる区（網掛けの区、洪水・高潮用が 0 件の区）。円の中心が区の中にあるか、区の輪郭が円の中を通る区。 */
export function wardsTouching(wards: readonly WardInfo[], circle: Circle): { unpublished: string[]; none: string[] } {
  const out = { unpublished: [] as string[], none: [] as string[] };
  for (const w of wards) {
    const target = !w.published ? out.unpublished : w.usable === 0 ? out.none : null;
    if (!target) continue;
    const inside = w.polygons.some((p) => pointInPolygon(circle.cx, circle.cy, p));
    const crosses = !inside && w.polygons.some((p) => p.some((ring) => clipPolylineToCircle(ring, circle.cx, circle.cy, circle.r).length > 0));
    if (inside || crosses) target.push(w.name);
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
  if (t && t.unpublished.length > 0) out.push({ label: 'データ未公開の区', value: `${t.unpublished.join('・')}（避難場所のデータを公開していない）` });
  if (t && t.none.length > 0) out.push({ label: '洪水・高潮用が 0 件の区', value: t.none.join('・') });
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
  if (info && !info.published) out.push({ label: 'この区のデータ', value: `${info.name}は未公開（指定緊急避難場所のデータなし。「ない」とは限らない）` });
  else if (info && info.usable === 0) out.push({ label: 'この区のデータ', value: `${info.name}は洪水・高潮用の指定が 0 件（${info.total} 件は地震・火事など）` });
  return out;
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

/** 線が、網掛けの区（データ未公開）と、洪水・高潮用が 0 件の区を通る区間。 */
export function sectionGaps(data: ShelterData, line: SectionLine): NonNullable<SectionMarks['gaps']> {
  const gaps: NonNullable<SectionMarks['gaps']> = [];
  if (!isUsableLine(line)) return gaps;
  for (const w of data.wards) {
    if (w.published && w.usable > 0) continue;
    const spans = mergeSpans(w.polygons.flatMap((p) => lineInsidePolygon(line, p as never)));
    for (const [d0, d1] of spans)
      gaps.push(
        w.published
          ? { d0, d1, kind: 'none', label: `${w.name}（洪水・高潮用の指定 0 件）` }
          : { d0, d1, kind: 'unpublished', label: `${w.name}（データ未公開）` },
      );
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

/** 洪水・高潮で使える避難場所の数と、データのない区の一覧（23区全体の集計）。 */
export function shelterOverview(data: ShelterData): {
  usable: number;
  other: number;
  hospitals: number;
  unpublished: string[];
  zeroUsable: string[];
  /** 洪水・高潮用が 0 件の区の、それ以外の避難場所の数（区名と件数） */
  zeroUsableOther: { name: string; total: number }[];
  updated: string;
} {
  return {
    usable: data.points.usable.length,
    other: data.points.other.length,
    hospitals: data.points.hospital.length,
    unpublished: data.wards.filter((w) => !w.published).map((w) => w.name),
    zeroUsable: data.wards.filter((w) => w.published && w.usable === 0).map((w) => w.name),
    zeroUsableOther: data.wards.filter((w) => w.published && w.usable === 0).map((w) => ({ name: w.name, total: w.total })),
    updated: data.summary.updated,
  };
}

export { KINDS as SHELTER_KINDS };
