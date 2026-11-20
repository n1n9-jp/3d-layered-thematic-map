import { createPointIndex, createSegmentIndex } from '../lib/spatialIndex';
import type { PointIndex, Segment, SegmentIndex } from '../lib/spatialIndex';
import type { Position, ProbeValue, RailCollection, StationCollection } from '../types';
import { formatDistance, unique, withSuffix } from './format';

export const STATION_SAMPLE_RADIUS = 1000;
export const RAIL_SAMPLE_RADIUS = 100;
/** 乗換駅として同じ駅名の駅をまとめる範囲（m） */
const STATION_MERGE_RADIUS = 500;

export interface TransitData {
  rail: RailCollection;
  stations: StationCollection;
  /** 描画用 */
  railPaths: Position[][];
  stationPoints: Position[];
  /** 路線（事業者＋路線名）ごとの線分索引。「通る路線」の探索用 */
  lines: { name: string; index: SegmentIndex }[];
  stationIndex: PointIndex;
}

export function buildTransitData(rail: RailCollection, stations: StationCollection): TransitData {
  const railPaths: Position[][] = [];
  const groups = new Map<string, { name: string; segments: Segment[] }>();
  for (const f of rail.features) {
    const line = f.geometry?.coordinates;
    if (!line || line.length < 2) continue;
    railPaths.push(line);
    const key = `${f.properties?.operator ?? ''}\u0000${f.properties?.line ?? ''}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { name: f.properties?.line ?? '', segments: [] }));
    for (let i = 0; i + 1 < line.length; i++)
      g.segments.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  }
  const stationPoints = stations.features.map((f) => f.geometry.coordinates);
  return {
    rail,
    stations,
    railPaths,
    stationPoints,
    lines: [...groups.values()].map((g) => ({ name: g.name, index: createSegmentIndex(g.segments) })),
    stationIndex: createPointIndex(stationPoints),
  };
}

export function sampleTransit(data: TransitData, x: number, y: number): ProbeValue[] {
  // 最寄り駅。同じ駅名で近接する別路線の駅（乗換駅）は、路線をまとめて示す。
  let stationText: string | null = null;
  const hit = data.stationIndex.nearest(x, y, STATION_SAMPLE_RADIUS);
  if (hit) {
    const st = data.stations.features[hit.index].properties;
    const here = data.stationPoints[hit.index];
    const lines = [st.line];
    for (const h of data.stationIndex.within(here[0], here[1], STATION_MERGE_RADIUS)) {
      const other = data.stations.features[h.index].properties;
      if (other.name === st.name) lines.push(other.line);
    }
    stationText = `${withSuffix(st.name, '駅')}（${unique(lines).join('・')}、${formatDistance(hit.distance)}）`;
  }

  const passing = data.lines
    .map((l) => ({ name: l.name, d: l.index.nearest(x, y, RAIL_SAMPLE_RADIUS)?.distance }))
    .filter((l): l is { name: string; d: number } => l.d !== undefined)
    .sort((a, b) => a.d - b.d);
  const lineText = passing.length ? unique(passing.map((l) => l.name)).join('、') : null;

  return [
    { label: '最寄り駅', value: stationText },
    { label: '通る路線', value: lineText },
  ];
}
