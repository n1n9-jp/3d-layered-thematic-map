import { createPointIndex } from '../lib/spatialIndex';
import type { PointIndex } from '../lib/spatialIndex';
import type { FacilityCollection, FacilityKind, Position, ProbeValue } from '../types';
import { formatDistance } from './format';

export const FACILITY_COUNT_RADIUS = 500;

export const FACILITY_KIND_LABEL: Record<FacilityKind, string> = { school: '学校', hospital: '病院' };

export interface FacilityData {
  /** 種別ごとの点。描画用 */
  points: Record<FacilityKind, Position[]>;
  /** 全施設の点と属性。`index` の添字と対応 */
  kind: FacilityKind[];
  name: string[];
  index: PointIndex;
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
  return { points, kind, name, index: createPointIndex(all) };
}

export function sampleFacilities(data: FacilityData, x: number, y: number): ProbeValue[] {
  let schools = 0;
  let hospitals = 0;
  for (const h of data.index.within(x, y, FACILITY_COUNT_RADIUS)) {
    if (data.kind[h.index] === 'school') schools++;
    else hospitals++;
  }
  const nearest = data.index.nearest(x, y);
  return [
    { label: '500m以内', value: `学校 ${schools}、病院 ${hospitals}` },
    {
      label: '最寄りの施設',
      value: nearest ? `${data.name[nearest.index]}（${formatDistance(nearest.distance)}）` : null,
    },
  ];
}
