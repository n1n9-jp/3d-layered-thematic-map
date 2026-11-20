import { clipPolylineToCircle, pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
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

/** 元の線（間引き前）。subset が、円で切って描画用の形を作り直すのに使う。 */
export interface RoadLine {
  cls: RoadClass;
  name: string | null;
  path: Position[];
}

export interface RoadData {
  /** 種別ごとの線（頂点列）。描画用に間引いてある（探針の参照は segIndex で、元の線のまま） */
  paths: Record<RoadClass, Position[][]>;
  /** 線分ごとの種別と名前。`segIndex` の添字と対応 */
  segClass: RoadClass[];
  segName: (string | null)[];
  segIndex: SegmentIndex;
  /** 間引く前の線。subset が切り出す元 */
  lines: RoadLine[];
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

function normalizeClass(c: unknown): RoadClass {
  return c === 'motorway' || c === 'national' || c === 'prefectural' ? c : 'other';
}

export function buildRoadData(fc: RoadCollection): RoadData {
  const lines: RoadLine[] = [];
  for (const f of fc.features) {
    const line = f.geometry?.coordinates;
    if (!line || line.length < 2) continue;
    lines.push({ cls: normalizeClass(f.properties?.class), name: f.properties?.name || null, path: line });
  }
  return buildFromLines(lines, ROAD_DRAW_TOLERANCE);
}

/** 線の集まりから、描画用（`tolerance` で間引く）と探針用（元の形）のデータを作る。 */
function buildFromLines(lines: RoadLine[], tolerance: number): RoadData {
  const paths: Record<RoadClass, Position[][]> = { other: [], prefectural: [], national: [], motorway: [] };
  const segments: Segment[] = [];
  const segClass: RoadClass[] = [];
  const segName: (string | null)[] = [];
  for (const { cls, name, path: line } of lines) {
    const drawn = simplifyPath(line, tolerance);
    if (drawn.length >= 2) paths[cls].push(drawn);
    for (let i = 0; i + 1 < line.length; i++) {
      segments.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
      segClass.push(cls);
      segName.push(name);
    }
  }
  return { paths, segClass, segName, segIndex: createSegmentIndex(segments), lines };
}

/**
 * 円で切った道路。種別と名前は元の線から引き継ぐ。
 * 円の中は拡大して表示されるので、描画用の形も、間引かない元の形から作る。
 */
export function subsetRoads(data: RoadData, cx: number, cy: number, radius: number): RoadData {
  const lines: RoadLine[] = [];
  for (const { cls, name, path } of data.lines)
    for (const piece of clipPolylineToCircle(path, cx, cy, radius)) lines.push({ cls, name, path: piece });
  return { ...buildFromLines(lines, 0), clip: { cx, cy, r: radius } };
}

/** 種別ごとの道路の延長（m）。 */
export function roadLengths(data: RoadData): Record<RoadClass, number> {
  const out: Record<RoadClass, number> = { motorway: 0, national: 0, prefectural: 0, other: 0 };
  for (const { cls, path } of data.lines)
    for (let i = 0; i + 1 < path.length; i++) out[cls] += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  return out;
}

/** 内訳の種別名（「高速道路」でなく「高速」）。表示順は上位の種別から。 */
const BREAKDOWN: readonly { cls: RoadClass; label: string }[] = [
  { cls: 'motorway', label: '高速' },
  { cls: 'national', label: '国道' },
  { cls: 'prefectural', label: '都道府県道' },
  { cls: 'other', label: '一般道' },
];

const km1 = (m: number) => (Math.round(m / 100) / 10).toFixed(1);

export function summarizeRoads(data: RoadData): ProbeValue[] {
  const len = roadLengths(data);
  const total = len.motorway + len.national + len.prefectural + len.other;
  if (!(total > 0)) return [{ label: '道路の延長', value: null }, { label: '内訳', value: null }];
  return [
    { label: '道路の延長', value: Math.round(total / 100) / 10, unit: 'km' },
    { label: '内訳', value: BREAKDOWN.map((b) => `${b.label} ${km1(len[b.cls])}`).join('、'), unit: 'km' },
  ];
}
export function roadDescription(cls: RoadClass, name: string | null): string {
  const label = ROAD_CLASS_LABEL[cls];
  return name ? `${label} ${name}` : label;
}

export function sampleRoads(data: RoadData, x: number, y: number): ProbeValue[] {
  if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r))
    return [{ label: '最寄りの道路', value: null }];
  const hit = data.segIndex.nearest(x, y, ROAD_SAMPLE_RADIUS);
  if (!hit) return [{ label: '最寄りの道路', value: null }];
  const text = roadDescription(data.segClass[hit.index], data.segName[hit.index]);
  return [{ label: '最寄りの道路', value: `${text}（${formatDistance(hit.distance)}）` }];
}
