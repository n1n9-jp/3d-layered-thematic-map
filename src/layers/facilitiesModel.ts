import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createPointIndex } from '../lib/spatialIndex';
import type { PointIndex } from '../lib/spatialIndex';
import type { FacilityCollection, FacilityKind, Position, ProbeValue } from '../types';
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
