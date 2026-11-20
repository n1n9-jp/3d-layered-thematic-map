import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createBoxIndex, isUsableLine, lineLength, projectOnLine } from '../lib/section';
import type { BoxIndex } from '../lib/section';
import { createPointIndex } from '../lib/spatialIndex';
import type { PointIndex } from '../lib/spatialIndex';
import type { FacilityCollection, FacilityKind, Position, ProbeValue, SectionLine, SectionMarks } from '../types';
import { formatDistance } from './format';

export const FACILITY_COUNT_RADIUS = 500;
/** 「最寄りの施設」を探す距離の上限（最寄り駅の探索と同じ 1km）。 */
export const FACILITY_NEAREST_RADIUS = 1000;

export const FACILITY_KIND_LABEL: Record<FacilityKind, string> = { school: '学校', hospital: '病院' };

export interface FacilityData {
  /** 種別ごとの点。描画用 */
  points: Record<FacilityKind, Position[]>;
  /** 全施設の点と属性。`index` の添字と対応 */
  kind: FacilityKind[];
  name: string[];
  index: PointIndex;
  /** 全施設の位置。`kind`・`name`・`index` と同じ添字 */
  all: Position[];
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

export function buildFacilityData(fc: FacilityCollection): FacilityData {
  const points: Record<FacilityKind, Position[]> = { school: [], hospital: [] };
  const all: Position[] = [];
  const kind: FacilityKind[] = [];
  const name: string[] = [];
  for (const f of fc.features) {
    const k = f.properties?.kind;
    if (k !== 'school' && k !== 'hospital') continue;
    const p = f.geometry?.coordinates;
    if (!p) continue;
    points[k].push(p);
    all.push(p);
    kind.push(k);
    name.push(f.properties.name || FACILITY_KIND_LABEL[k]);
  }
  return { points, kind, name, index: createPointIndex(all), all };
}

/** 円の中にある施設だけを取り出す（縁の上は中）。 */
export function subsetFacilities(data: FacilityData, cx: number, cy: number, radius: number): FacilityData {
  const points: Record<FacilityKind, Position[]> = { school: [], hospital: [] };
  const all: Position[] = [];
  const kind: FacilityKind[] = [];
  const name: string[] = [];
  data.all.forEach((p, i) => {
    if (!pointInCircle(p[0], p[1], cx, cy, radius)) return;
    points[data.kind[i]].push(p);
    all.push(p);
    kind.push(data.kind[i]);
    name.push(data.name[i]);
  });
  return { points, kind, name, index: createPointIndex(all), all, clip: { cx, cy, r: radius } };
}

export function summarizeFacilities(data: FacilityData): ProbeValue[] {
  return [
    { label: '学校', value: data.points.school.length, unit: '校' },
    { label: '病院', value: data.points.hospital.length, unit: '院' },
  ];
}

export function sampleFacilities(data: FacilityData, x: number, y: number): ProbeValue[] {
  if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r))
    return [
      { label: '500m以内', value: null },
      { label: '最寄りの施設', value: null },
    ];
  let schools = 0;
  let hospitals = 0;
  for (const h of data.index.within(x, y, FACILITY_COUNT_RADIUS)) {
    if (data.kind[h.index] === 'school') schools++;
    else hospitals++;
  }
  const nearest = data.index.nearest(x, y, FACILITY_NEAREST_RADIUS);
  return [
    { label: '500m以内', value: `学校 ${schools}、病院 ${hospitals}` },
    {
      label: '最寄りの施設',
      value: nearest ? `${data.name[nearest.index]}（${formatDistance(nearest.distance)}）` : null,
    },
  ];
}

/* ---------- 断面 ---------- */

/** 断面で、線から何 m 以内の施設を出すか。 */
export const FACILITY_SECTION_RADIUS = 300;

const sectionIndexes = new WeakMap<FacilityData, BoxIndex>();

/** 断面用の索引（施設の点の格子）。データごとに1回だけ作る（load が先に作っておく）。 */
export function facilitySectionIndex(data: FacilityData): BoxIndex {
  let idx = sectionIndexes.get(data);
  if (!idx) {
    const pts = new Float64Array(data.all.length * 4);
    data.all.forEach(([x, y], i) => pts.set([x, y, x, y], 4 * i));
    idx = createBoxIndex(pts);
    sectionIndexes.set(data, idx);
  }
  return idx;
}

/**
 * 線から `FACILITY_SECTION_RADIUS`（300 m）以内の学校と病院。線への垂線の足が線分の内側（0 〜 長さ）にあるものだけで、
 * `d` は垂線の足の位置、`offset` は線からの距離（左が正）。線に沿った距離の順。
 * `color` は種別ごとの色（地図上の配色）。
 */
export function sectionFacilities(
  data: FacilityData,
  line: SectionLine,
  color: (kind: FacilityKind) => [number, number, number],
): SectionMarks {
  const track: SectionMarks = { kind: 'marks', label: '近くの学校・病院', marks: [] };
  if (!isUsableLine(line)) return track;
  const len = lineLength(line);
  const found: { i: number; d: number; offset: number }[] = [];
  facilitySectionIndex(data).near(line, FACILITY_SECTION_RADIUS, (i) => {
    const pr = projectOnLine(line, data.all[i][0], data.all[i][1]);
    if (!pr || pr.d < 0 || pr.d > len || Math.abs(pr.offset) > FACILITY_SECTION_RADIUS) return;
    found.push({ i, d: pr.d, offset: pr.offset });
  });
  found.sort((a, b) => a.d - b.d || a.i - b.i);
  for (const { i, d, offset } of found) {
    const kind = data.kind[i];
    track.marks.push({
      d,
      offset,
      category: kind,
      categoryLabel: FACILITY_KIND_LABEL[kind],
      name: data.name[i] || null,
      color: color(kind),
      x: data.all[i][0],
      y: data.all[i][1],
    });
  }
  return track;
}
