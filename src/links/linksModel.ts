/**
 * 段と段をつなぐ「対応の線」の、純粋な計算。
 * 固定した円の中の地物について、次の2つの関係を求める。
 *   facility-station   ：施設 → 最寄り駅（1 km 以内）。施設の段の点から、公共交通の段の駅の点へ
 *   station-population ：駅 → 直下の人口。公共交通の段の駅の点から、人口の段の同じ地点へ
 * 描画は `linkLayers.ts`、データの取り出しは `compute.ts`。
 */
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { pointInCircle } from '../lib/circleClip';
import { createPointIndex } from '../lib/spatialIndex';
import type { PointIndex } from '../lib/spatialIndex';
import { layerZ } from '../stack';
import type { StackState } from '../stack';
import type { FacilityKind, Position } from '../types';
import { densityColor } from '../layers/population/classes';
import type { RGB } from '../layers/population/classes';

export type LinkKind = 'facility-station' | 'station-population';
export const LINK_KINDS: readonly LinkKind[] = ['facility-station', 'station-population'];

export const LINK_LABEL: Record<LinkKind, string> = {
  'facility-station': '施設 → 最寄り駅',
  'station-population': '駅 → 直下の人口',
};

/** 関係ごとの、つなぐ2つの段（from → to の順）。 */
export const LINK_LAYERS: Record<LinkKind, readonly [LayerId, LayerId]> = {
  'facility-station': ['facilities', 'transit'],
  'station-population': ['transit', 'population'],
};

/** 最寄り駅を探す距離の上限（m）。表の「最寄り駅」と同じ 1 km。 */
export const NEAREST_STATION_RADIUS = 1000;
/** 同じ駅名の点を、1つの駅としてまとめる範囲（m）。乗換駅の別路線の点。 */
export const STATION_MERGE_RADIUS = 500;

/** URL クエリ `links=<facility-station,station-population>`。書かれた関係だけをオンにする。不正な値は無視する。 */
export function parseLinksQuery(value: string | null): Record<LinkKind, boolean> {
  const on = new Set((value ?? '').split(',').map((s) => s.trim()));
  return { 'facility-station': on.has('facility-station'), 'station-population': on.has('station-population') };
}

/** 関係に必要な2つの段が、どちらも表示中か。単独表示や、どちらかが非表示なら false（切り替えは無効になる）。 */
export function linkAvailable(kind: LinkKind, stack: StackState): boolean {
  return LINK_LAYERS[kind].every((id) => layerZ(stack, id) !== null);
}

/** 関係に必要な段の高さ。どちらかが表示されていなければ null。 */
export function linkHeights(kind: LinkKind, zs: Readonly<Partial<Record<LayerId, number | null>>>): [number, number] | null {
  const [a, b] = LINK_LAYERS[kind];
  const za = zs[a];
  const zb = zs[b];
  return za == null || zb == null ? null : [za, zb];
}

/** 線の高さの表（表示中でない段は null）。 */
export function heightsOf(stack: StackState): Record<LayerId, number | null> {
  return Object.fromEntries(LAYER_IDS.map((id) => [id, layerZ(stack, id)])) as Record<LayerId, number | null>;
}

/* ---------- 駅のまとめ ---------- */

/** 1つの駅（同じ駅名で、近い点をまとめたもの）。pos は、まとめた点のうち中心にいちばん近い点。 */
export interface StationGroup {
  name: string;
  pos: Position;
  /** まとめた点（地図に描かれた駅の点）。pos はこのうちの1つ */
  points: Position[];
  /** まとめた点の数 */
  members: number;
}

/**
 * 同じ駅名の点を、近いもの（まとめる範囲 mergeRadius 以内）どうしでまとめて、1つの駅にする。
 * 駅名が同じでも離れた点は、別の駅。代表の位置は、まとめた点の重心にいちばん近い点（描かれた駅の点の上に載る）。
 * 出力の順は、入力で最初に現れた順。
 */
export function groupStations(points: readonly Position[], names: readonly string[], mergeRadius = STATION_MERGE_RADIUS): StationGroup[] {
  const byName = new Map<string, number[]>();
  points.forEach((p, i) => {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    const list = byName.get(names[i]);
    if (list) list.push(i);
    else byName.set(names[i], [i]);
  });
  const groups: { first: number; group: StationGroup }[] = [];
  for (const [name, indices] of byName) {
    const taken = new Set<number>();
    for (const anchor of indices) {
      if (taken.has(anchor)) continue;
      const members = indices.filter(
        (i) => !taken.has(i) && Math.hypot(points[i][0] - points[anchor][0], points[i][1] - points[anchor][1]) <= mergeRadius,
      );
      members.forEach((i) => taken.add(i));
      const cx = members.reduce((s, i) => s + points[i][0], 0) / members.length;
      const cy = members.reduce((s, i) => s + points[i][1], 0) / members.length;
      let best = members[0];
      let bestD = Infinity;
      for (const i of members) {
        const d = Math.hypot(points[i][0] - cx, points[i][1] - cy);
        if (d < bestD) {
          best = i;
          bestD = d;
        }
      }
      groups.push({ first: Math.min(...members), group: { name, pos: [points[best][0], points[best][1]], points: members.map((i) => [points[i][0], points[i][1]] as Position), members: members.length } });
    }
  }
  return groups.sort((a, b) => a.first - b.first).map((g) => g.group);
}

/** 駅。まとめた駅（groups）と、地図に描かれた駅の点すべて（points、names、index）。 */
export interface StationSet {
  groups: StationGroup[];
  points: Position[];
  names: string[];
  /** points の位置の索引（添字は points と同じ） */
  index: PointIndex;
}

export function buildStationSet(points: readonly Position[], names: readonly string[]): StationSet {
  return { groups: groupStations(points, names), points: [...points], names: [...names], index: createPointIndex(points) };
}

/* ---------- 関係 ---------- */

export interface FacilityInput {
  pos: Position;
  kind: FacilityKind;
  name: string;
}

export interface FacilityStationLink {
  kind: FacilityKind;
  /** 施設名 */
  name: string;
  from: Position;
  to: Position;
  /** 最寄り駅の駅名 */
  station: string;
  /** 施設から最寄り駅までの水平距離（m） */
  distance: number;
}

export interface FacilityStationResult {
  links: FacilityStationLink[];
  /** 円の中の施設の数 */
  facilityCount: number;
  /** 1 km 以内に駅がなく、線を引かない施設の数 */
  noStation: number;
}

/**
 * 施設ごとの最寄り駅。地図に描かれた駅の点のうち、いちばん近いもの（表の「最寄り駅」と同じ）へ引く。
 * maxDistance（既定 1 km）以内に駅がない施設には線を引かない（noStation に数える）。駅は円の外にあってもよい。
 */
export function facilityStationLinks(
  facilities: readonly FacilityInput[],
  stations: StationSet,
  maxDistance = NEAREST_STATION_RADIUS,
): FacilityStationResult {
  const links: FacilityStationLink[] = [];
  let noStation = 0;
  for (const f of facilities) {
    const hit = stations.index.nearest(f.pos[0], f.pos[1], maxDistance);
    if (!hit) {
      noStation++;
      continue;
    }
    const to = stations.points[hit.index];
    links.push({ kind: f.kind, name: f.name, from: f.pos, to: [to[0], to[1]], station: stations.names[hit.index], distance: hit.distance });
  }
  return { links, facilityCount: facilities.length, noStation };
}

export interface StationPopulationLink {
  station: string;
  /** 駅の位置。人口の段では、同じ (x, y) の点 */
  at: Position;
  /** 駅の直下のメッシュの人口密度（人/km²）。メッシュがなければ null */
  density: number | null;
  color: RGB;
}

export interface StationPopulationResult {
  links: StationPopulationLink[];
}

/**
 * 円の中の駅（まとめた点のどれかが円の中にあるもの。表の「駅」の数え方と同じ）ごとに、その真下の人口密度と、線の色（人口レイヤーの凡例の色）。
 * 線の位置は、円の中にある点のうち、代表の点にいちばん近いもの。同じ駅名は、離れた点でも1本にまとめる（最初のもの）。
 * densityAt は、地点の人口密度（人/km²）。メッシュがなければ null。
 */
export function stationPopulationLinks(
  stations: StationSet,
  circle: { x: number; y: number; r: number },
  densityAt: (x: number, y: number) => number | null,
): StationPopulationResult {
  const links: StationPopulationLink[] = [];
  const seen = new Set<string>();
  for (const g of stations.groups) {
    if (seen.has(g.name)) continue;
    let at: Position | null = null;
    let best = Infinity;
    for (const p of g.points) {
      if (!pointInCircle(p[0], p[1], circle.x, circle.y, circle.r)) continue;
      const d = Math.hypot(p[0] - g.pos[0], p[1] - g.pos[1]);
      if (d < best) {
        best = d;
        at = p;
      }
    }
    if (!at) continue;
    seen.add(g.name);
    const density = densityAt(at[0], at[1]);
    links.push({ station: g.name, at, density, color: densityColor(density ?? 0) });
  }
  return { links };
}

/* ---------- 要約 ---------- */

export interface FacilityStationSummary {
  /** 引いた線の本数 */
  lineCount: number;
  byKind: Record<FacilityKind, number>;
  /** 円の中の施設の数 */
  facilityCount: number;
  /** 1 km 以内に駅がない施設の数 */
  noStation: number;
  /** 最寄り駅までの距離（m）。線がなければ null */
  meanDistance: number | null;
  maxDistance: number | null;
}

export function summarizeFacilityStation(r: FacilityStationResult): FacilityStationSummary {
  const byKind: Record<FacilityKind, number> = { school: 0, hospital: 0 };
  let sum = 0;
  let max = 0;
  for (const l of r.links) {
    byKind[l.kind]++;
    sum += l.distance;
    if (l.distance > max) max = l.distance;
  }
  const n = r.links.length;
  return {
    lineCount: n,
    byKind,
    facilityCount: r.facilityCount,
    noStation: r.noStation,
    meanDistance: n > 0 ? sum / n : null,
    maxDistance: n > 0 ? max : null,
  };
}

export interface StationPopulationSummary {
  /** 引いた線の本数（円の中の駅の数） */
  lineCount: number;
  /** 直下のメッシュの人口密度の平均・最大（人/km²）。メッシュのある駅だけ。なければ null */
  meanDensity: number | null;
  maxDensity: number | null;
  /** 直下に人が住んでいない（人口密度 0、またはメッシュなし）駅の数 */
  noResidents: number;
}

export function summarizeStationPopulation(r: StationPopulationResult): StationPopulationSummary {
  let sum = 0;
  let max = 0;
  let withMesh = 0;
  let noResidents = 0;
  for (const l of r.links) {
    if (l.density === null || !(l.density > 0)) noResidents++;
    if (l.density === null) continue;
    withMesh++;
    sum += l.density;
    if (l.density > max) max = l.density;
  }
  return {
    lineCount: r.links.length,
    meanDensity: withMesh > 0 ? sum / withMesh : null,
    maxDensity: withMesh > 0 ? max : null,
    noResidents,
  };
}

const num = (v: number) => Math.round(v).toLocaleString('ja-JP');

/** 表に出す文。最寄り駅までの距離は、線の長さ（水平距離）。 */
export function describeFacilityStation(s: FacilityStationSummary): string[] {
  const out = [`線 ${num(s.lineCount)} 本（学校 ${num(s.byKind.school)}・病院 ${num(s.byKind.hospital)}）`];
  if (s.meanDistance !== null && s.maxDistance !== null)
    out.push(`最寄り駅まで 平均 ${num(s.meanDistance)}m（最大 ${num(s.maxDistance)}m）`);
  out.push(`1km 以内に駅がない施設 ${num(s.noStation)}件`);
  return out;
}

export function describeStationPopulation(s: StationPopulationSummary): string[] {
  const out = [`線 ${num(s.lineCount)} 本（駅 ${num(s.lineCount)}）`];
  if (s.meanDensity !== null && s.maxDensity !== null)
    out.push(`直下の人口密度 平均 ${num(s.meanDensity)}人/km²（最大 ${num(s.maxDensity)}）`);
  out.push(`直下に人が住んでいない駅 ${num(s.noResidents)}駅`);
  return out;
}

/* ---------- 線の太さと透明度 ---------- */

export interface LinkStyle {
  /** 線の太さ（px） */
  width: number;
  /** 不透明度（0〜255） */
  alpha: number;
}

const FEW = 12;
const MANY = 250;

/**
 * 線の本数に応じた太さと透明度。少ないうちは太く濃く、本数が増えるほど細く薄くして、束として読めるようにする。
 * 本数の対数で、FEW 本以下は最大、MANY 本以上は最小。なめらかに変わる。
 */
export function linkStyle(count: number): LinkStyle {
  const t = Math.min(1, Math.max(0, (Math.log(Math.max(1, Number.isFinite(count) ? count : 1)) - Math.log(FEW)) / (Math.log(MANY) - Math.log(FEW))));
  return { width: 2.2 - 1.2 * t, alpha: Math.round(235 - 135 * t) };
}
