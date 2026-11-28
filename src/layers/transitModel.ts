import { clipPolylineToCircle, pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createBoxIndex, intersectLineSegment, isUsableLine, lineLength, projectOnLine } from '../lib/section';
import type { BoxIndex } from '../lib/section';
import { createPointIndex, createSegmentIndex } from '../lib/spatialIndex';
import { DEFAULT_OPTIONS } from '../config';
import type { FloodScenario, LayerOptions } from '../config';
import { SCENARIO_LABEL } from './flood/classes';
import type { FloodData } from './flood/model';
import { EXPOSED_MIN_DEPTH, isExposedAt, transitExposure } from './transit/exposure';
import type { PointIndex, Segment, SegmentIndex } from '../lib/spatialIndex';
import type { Position, ProbeValue, RailCollection, SectionLine, SectionMarks, StationCollection } from '../types';
import { formatDistance, unique, withSuffix } from './format';
import { simplifyPath } from './simplify';

export const STATION_SAMPLE_RADIUS = 1000;
export const RAIL_SAMPLE_RADIUS = 100;
/** 描画用に線を間引く許容誤差（m）。探針の参照（lines）は元の線のまま作る。 */
export const RAIL_DRAW_TOLERANCE = 3;
/** 乗換駅として同じ駅名の駅をまとめる範囲（m） */
const STATION_MERGE_RADIUS = 500;

export interface TransitData {
  rail: RailCollection;
  stations: StationCollection;
  /** 描画用（間引き済み） */
  railPaths: Position[][];
  stationPoints: Position[];
  /** 路線（事業者＋路線名）ごとの線分索引。「通る路線」の探索用 */
  lines: { name: string; index: SegmentIndex }[];
  stationIndex: PointIndex;
  /**
   * 浸水の段の格子（読み取り専用）。駅と路線が「浸水が想定される区域」にかかるかの判定に使う（`./transit/exposure.ts`）。
   * 読み込めなかったとき・まだ付けていないときは null か省略。subset の結果も、切り出さない全体の格子を持つ。
   */
  flood?: FloodData | null;
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

export function buildTransitData(
  rail: RailCollection,
  stations: StationCollection,
  drawTolerance: number = RAIL_DRAW_TOLERANCE,
): TransitData {
  const railPaths: Position[][] = [];
  const groups = new Map<string, { name: string; segments: Segment[] }>();
  for (const f of rail.features) {
    const line = f.geometry?.coordinates;
    if (!line || line.length < 2) continue;
    const drawn = simplifyPath(line, drawTolerance);
    if (drawn.length >= 2) railPaths.push(drawn);
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

/**
 * 円で切った路線と、円の中の駅。路線は元の線から切り、描画用の形も間引かない
 * （円の中は拡大して表示されるので、間引く前の形から作る）。
 */
export function subsetTransit(data: TransitData, cx: number, cy: number, radius: number): TransitData {
  const features: RailCollection['features'] = [];
  for (const f of data.rail.features) {
    const line = f.geometry?.coordinates;
    if (!line || line.length < 2) continue;
    for (const piece of clipPolylineToCircle(line, cx, cy, radius))
      features.push({ type: 'Feature', properties: f.properties, geometry: { type: 'LineString', coordinates: piece } });
  }
  const stations = data.stations.features.filter((_, i) => {
    const p = data.stationPoints[i];
    return pointInCircle(p[0], p[1], cx, cy, radius);
  });
  const built = buildTransitData(
    { ...data.rail, features },
    { ...data.stations, features: stations },
    0,
  );
  return { ...built, flood: data.flood, clip: { cx, cy, r: radius } };
}

export function summarizeTransit(data: TransitData, options: Pick<LayerOptions, 'floodScenario'> = DEFAULT_OPTIONS): ProbeValue[] {
  const stationNames = new Set(data.stations.features.map((f) => f.properties.name));
  const lineNames = new Set(data.rail.features.map((f) => f.properties.line));
  const out: ProbeValue[] = [
    { label: '駅', value: stationNames.size, unit: '駅' },
    { label: '路線', value: lineNames.size, unit: '路線' },
  ];
  // うち、浸水が想定される区域（深さ 0.5m 以上）にある駅。同じ駅名は1つと数える（上の「駅」と同じ数え方）。
  const exposure = transitExposure(data, options.floodScenario);
  if (exposure) {
    const exposedNames = new Set<string>();
    data.stations.features.forEach((f, i) => {
      if (exposure.stationExposed[i] === 1) exposedNames.add(f.properties.name);
    });
    out.splice(1, 0, { label: '浸水が想定される区域の駅', value: exposedNames.size, unit: '駅' });
  }
  return out;
}

/** 最寄り駅が浸水が想定される区域にあるか、の読み。 */
export function stationExposureText(exposed: boolean, scenario: FloodScenario): string {
  return exposed
    ? `区域内（深さ ${EXPOSED_MIN_DEPTH}m 以上。${SCENARIO_LABEL[scenario]}）`
    : `区域外（深さ ${EXPOSED_MIN_DEPTH}m 未満、または浸水なし。${SCENARIO_LABEL[scenario]}）`;
}

export function sampleTransit(data: TransitData, x: number, y: number, options: Pick<LayerOptions, 'floodScenario'> = DEFAULT_OPTIONS): ProbeValue[] {
  if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r))
    return [
      { label: '最寄り駅', value: null },
      { label: '通る路線', value: null },
    ];
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

  const out: ProbeValue[] = [
    { label: '最寄り駅', value: stationText },
    { label: '通る路線', value: lineText },
  ];
  // 最寄り駅の位置が、浸水が想定される区域か（想定は画面の選択に従う。駅の位置で判定する）
  const exposure = hit ? transitExposure(data, options.floodScenario) : null;
  if (hit && exposure)
    out.splice(1, 0, { label: '最寄り駅の浸水想定', value: stationExposureText(exposure.stationExposed[hit.index] === 1, options.floodScenario) });
  return out;
}

/* ---------- 断面 ---------- */

/** 断面で、線から何 m 以内の駅を出すか。 */
export const STATION_SECTION_RADIUS = 500;

interface TransitSectionIndex {
  /** 路線の線分 i は [x1, y1, x2, y2] = segs[4i .. 4i+3]。元の線（間引く前）から作る */
  segs: Float64Array;
  /** 線分 i が属する路線（`rail.features` の添字）と、その線の最後の線分か */
  featureOf: Int32Array;
  isLast: Uint8Array;
  rail: BoxIndex;
  /** 駅（点）。添字は `stationPoints` と同じ */
  stations: BoxIndex;
}

const sectionIndexes = new WeakMap<TransitData, TransitSectionIndex>();

/** 断面用の索引。データごとに1回だけ作る（load が先に作っておく）。 */
export function transitSectionIndex(data: TransitData): TransitSectionIndex {
  let idx = sectionIndexes.get(data);
  if (idx) return idx;
  let n = 0;
  for (const f of data.rail.features) n += Math.max(0, (f.geometry?.coordinates.length ?? 0) - 1);
  const segs = new Float64Array(n * 4);
  const boxes = new Float64Array(n * 4);
  const featureOf = new Int32Array(n);
  const isLast = new Uint8Array(n);
  let k = 0;
  data.rail.features.forEach((f, fi) => {
    const path = f.geometry?.coordinates ?? [];
    for (let i = 0; i + 1 < path.length; i++, k++) {
      const [x1, y1] = path[i];
      const [x2, y2] = path[i + 1];
      segs.set([x1, y1, x2, y2], 4 * k);
      boxes.set([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], 4 * k);
      featureOf[k] = fi;
      isLast[k] = i + 2 === path.length ? 1 : 0;
    }
  });
  const pts = new Float64Array(data.stationPoints.length * 4);
  data.stationPoints.forEach(([x, y], i) => pts.set([x, y, x, y], 4 * i));
  idx = { segs, featureOf, isLast, rail: createBoxIndex(boxes), stations: createBoxIndex(pts) };
  sectionIndexes.set(data, idx);
  return idx;
}

/**
 * 公共交通の断面。2つのトラックを返す。
 * 1. 線と路線の交点（`category` は 'rail'、`name` は路線名）。間引く前の元の線との交点で、線に沿った距離の順。
 *    頂点がちょうど線の上にあるときの数え方は道路と同じ（`sectionRoads`）。
 * 2. 線から `STATION_SECTION_RADIUS`（500 m）以内で、線への垂線の足が線分の内側（0 〜 長さ）にある駅
 *    （`category` は 'station'、`name` は駅名）。`d` は垂線の足の位置、`offset` は線からの距離（左が正）。
 *    同じ駅名の駅は、線にいちばん近い1つだけにする。
 */
export function sectionTransit(
  data: TransitData,
  line: SectionLine,
  colors: {
    rail: [number, number, number];
    station: [number, number, number];
    /** 浸水が想定される区域（深さ 0.5m 以上）の交差・駅の色。scenario を渡したときだけ使う */
    railExposed?: [number, number, number];
    stationExposed?: [number, number, number];
  },
  /** 浸水の想定。渡すと、各交差・駅が浸水が想定される区域かどうかで色を分け、`exposed` を付ける（浸水の格子がなければ付けない） */
  scenario?: FloodScenario,
): SectionMarks[] {
  const rail: SectionMarks = { kind: 'marks', label: '鉄道との交差', marks: [] };
  const station: SectionMarks = { kind: 'marks', label: '近くの駅', marks: [] };
  if (!isUsableLine(line)) return [rail, station];
  const { segs, featureOf, isLast, rail: railIndex, stations: stationIndex } = transitSectionIndex(data);
  const flood = scenario && data.flood ? data.flood : null;
  const exposure = scenario ? transitExposure(data, scenario) : null;

  railIndex.near(line, 0, (i) => {
    const hit = intersectLineSegment(line, segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);
    if (!hit || (hit.u >= 1 && !isLast[i])) return;
    const exposed = flood && scenario ? isExposedAt(flood, scenario, hit.x, hit.y) : undefined;
    rail.marks.push({
      d: hit.d,
      offset: 0,
      category: 'rail',
      categoryLabel: '鉄道',
      name: data.rail.features[featureOf[i]].properties?.line || null,
      color: exposed ? (colors.railExposed ?? colors.rail) : colors.rail,
      x: hit.x,
      y: hit.y,
      ...(exposed === undefined ? {} : { exposed }),
    });
  });
  rail.marks.sort((a, b) => a.d - b.d);

  const len = lineLength(line);
  // 駅名ごとに、線にいちばん近い駅（距離が同じなら添字の小さいほう）
  const best = new Map<string, { i: number; d: number; offset: number }>();
  const single: { i: number; d: number; offset: number }[] = [];
  stationIndex.near(line, STATION_SECTION_RADIUS, (i) => {
    const [px, py] = data.stationPoints[i];
    const pr = projectOnLine(line, px, py);
    if (!pr || pr.d < 0 || pr.d > len || Math.abs(pr.offset) > STATION_SECTION_RADIUS) return;
    const cand = { i, d: pr.d, offset: pr.offset };
    const name = data.stations.features[i].properties?.name;
    if (!name) {
      single.push(cand);
      return;
    }
    const cur = best.get(name);
    if (!cur || Math.abs(cand.offset) < Math.abs(cur.offset) || (Math.abs(cand.offset) === Math.abs(cur.offset) && i < cur.i))
      best.set(name, cand);
  });
  for (const { i, d, offset } of [...best.values(), ...single].sort((a, b) => a.d - b.d || a.i - b.i)) {
    const [x, y] = data.stationPoints[i];
    const exposed = exposure ? exposure.stationExposed[i] === 1 : undefined;
    station.marks.push({
      d,
      offset,
      category: 'station',
      categoryLabel: '駅',
      name: data.stations.features[i].properties?.name || null,
      color: exposed ? (colors.stationExposed ?? colors.station) : colors.station,
      x,
      y,
      ...(exposed === undefined ? {} : { exposed }),
    });
  }
  return [rail, station];
}
