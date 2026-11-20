import { clipPolylineToCircle, pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createBoxIndex, intersectLineSegment, isUsableLine } from '../lib/section';
import type { BoxIndex } from '../lib/section';
import { createSegmentIndex } from '../lib/spatialIndex';
import type { Segment, SegmentIndex } from '../lib/spatialIndex';
import type { Position, ProbeValue, RoadClass, RoadCollection, SectionLine, SectionMarks } from '../types';
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

/* ---------- 断面 ---------- */

/** 断面用の索引。線分は、間引く前の元の線（`data.lines`）から作る。 */
interface RoadSectionIndex {
  /** 線分 i は [x1, y1, x2, y2] = segs[4i .. 4i+3] */
  segs: Float64Array;
  /** 線分 i が属する線（`data.lines` の添字）と、その線の最後の線分か */
  lineOf: Int32Array;
  isLast: Uint8Array;
  index: BoxIndex;
}

const sectionIndexes = new WeakMap<RoadData, RoadSectionIndex>();

/** 断面用の索引。データごとに1回だけ作る（load が先に作っておく）。 */
export function roadSectionIndex(data: RoadData): RoadSectionIndex {
  let idx = sectionIndexes.get(data);
  if (idx) return idx;
  let n = 0;
  for (const { path } of data.lines) n += Math.max(0, path.length - 1);
  const segs = new Float64Array(n * 4);
  const boxes = new Float64Array(n * 4);
  const lineOf = new Int32Array(n);
  const isLast = new Uint8Array(n);
  let k = 0;
  data.lines.forEach(({ path }, li) => {
    for (let i = 0; i + 1 < path.length; i++, k++) {
      const [x1, y1] = path[i];
      const [x2, y2] = path[i + 1];
      segs.set([x1, y1, x2, y2], 4 * k);
      boxes.set([Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], 4 * k);
      lineOf[k] = li;
      isLast[k] = i + 2 === path.length ? 1 : 0;
    }
  });
  idx = { segs, lineOf, isLast, index: createBoxIndex(boxes) };
  sectionIndexes.set(data, idx);
  return idx;
}

/**
 * 線と道路の交点。間引く前の元の線との交点で、線に沿った距離の順。
 * 道路の頂点がちょうど線の上にあるときは、その点を1回だけ数える（折れ線の各線分の終点は除き、始点だけ数える。
 * 折れ線の最後の終点は数える）。線に平行な道路は交わらないものとして扱う。
 * `color` は種別ごとの色（地図上の配色）。
 */
export function sectionRoads(data: RoadData, line: SectionLine, color: (cls: RoadClass) => [number, number, number]): SectionMarks {
  const track: SectionMarks = { kind: 'marks', label: '道路との交差', marks: [] };
  if (!isUsableLine(line)) return track;
  const { segs, lineOf, isLast, index } = roadSectionIndex(data);
  index.near(line, 0, (i) => {
    const hit = intersectLineSegment(line, segs[4 * i], segs[4 * i + 1], segs[4 * i + 2], segs[4 * i + 3]);
    if (!hit || (hit.u >= 1 && !isLast[i])) return;
    const road = data.lines[lineOf[i]];
    track.marks.push({
      d: hit.d,
      offset: 0,
      category: road.cls,
      categoryLabel: ROAD_CLASS_LABEL[road.cls],
      name: road.name,
      color: color(road.cls),
      x: hit.x,
      y: hit.y,
    });
  });
  track.marks.sort((a, b) => a.d - b.d);
  return track;
}
