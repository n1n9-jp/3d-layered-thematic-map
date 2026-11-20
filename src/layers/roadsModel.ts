import { createSegmentIndex } from '../lib/spatialIndex';
import type { Segment, SegmentIndex } from '../lib/spatialIndex';
import type { Position, ProbeValue, RoadClass, RoadCollection } from '../types';
import { formatDistance } from './format';
import { simplifyPath } from './simplify';

/** 描画順（下から上）。上位の道路ほど後に描いて上に重ねる。 */
export const ROAD_CLASSES: readonly RoadClass[] = ['other', 'prefectural', 'national', 'motorway'];

export const ROAD_CLASS_LABEL: Record<RoadClass, string> = {
  motorway: '高速道路',
  national: '国道',
  prefectural: '都道府県道',
  other: '一般道',
};

/**
 * 描画用に線を間引く許容誤差（m）。最も細い道路（幅6 m）の半分ほど。
 * 探針の参照（segIndex）は元の線のまま作るので、この値は表示だけに効く。
 */
export const ROAD_DRAW_TOLERANCE = 3;

/** 探針が「最寄りの道路」を探す範囲（m）。 */
export const ROAD_SAMPLE_RADIUS = 300;

export interface RoadData {
  /** 種別ごとの線（頂点列）。描画用に間引いてある（探針の参照は segIndex で、元の線のまま） */
  paths: Record<RoadClass, Position[][]>;
  /** 線分ごとの種別と名前。`segIndex` の添字と対応 */
  segClass: RoadClass[];
  segName: (string | null)[];
  segIndex: SegmentIndex;
}

function normalizeClass(c: unknown): RoadClass {
  return c === 'motorway' || c === 'national' || c === 'prefectural' ? c : 'other';
}

export function buildRoadData(fc: RoadCollection): RoadData {
  const paths: Record<RoadClass, Position[][]> = { other: [], prefectural: [], national: [], motorway: [] };
  const segments: Segment[] = [];
  const segClass: RoadClass[] = [];
  const segName: (string | null)[] = [];
  for (const f of fc.features) {
    const line = f.geometry?.coordinates;
    if (!line || line.length < 2) continue;
    const cls = normalizeClass(f.properties?.class);
    const name = f.properties?.name || null;
    const drawn = simplifyPath(line, ROAD_DRAW_TOLERANCE);
    if (drawn.length >= 2) paths[cls].push(drawn);
    for (let i = 0; i + 1 < line.length; i++) {
      segments.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
      segClass.push(cls);
      segName.push(name);
    }
  }
  return { paths, segClass, segName, segIndex: createSegmentIndex(segments) };
}

export function roadDescription(cls: RoadClass, name: string | null): string {
  const label = ROAD_CLASS_LABEL[cls];
  return name ? `${label} ${name}` : label;
}

export function sampleRoads(data: RoadData, x: number, y: number): ProbeValue[] {
  const hit = data.segIndex.nearest(x, y, ROAD_SAMPLE_RADIUS);
  if (!hit) return [{ label: '最寄りの道路', value: null }];
  const text = roadDescription(data.segClass[hit.index], data.segName[hit.index]);
  return [{ label: '最寄りの道路', value: `${text}（${formatDistance(hit.distance)}）` }];
}
