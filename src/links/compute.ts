/**
 * 対応の線の元になる関係を、読み込んだデータから求める。
 * 固定した地点か半径（またはデータ）が変わったときだけ計算し、同じ入力なら前の結果を返す
 * （全体の地図とクローズアップと表が、同じ結果を共有する）。
 */
import type { DataKey, LayerStatus } from '../store';
import { pointInCircle } from '../lib/circleClip';
import type { FacilityData } from '../layers/facilitiesModel';
import type { PopulationData } from '../layers/population';
import type { TransitData } from '../layers/transitModel';
import {
  buildStationSet,
  facilityStationLinks,
  stationPopulationLinks,
  summarizeFacilityStation,
  summarizeStationPopulation,
} from './linksModel';
import type {
  FacilityInput,
  FacilityStationResult,
  FacilityStationSummary,
  StationPopulationResult,
  StationPopulationSummary,
  StationSet,
} from './linksModel';

export interface Circle3 {
  x: number;
  y: number;
  r: number;
}

/** 固定した円についての、2つの関係。必要なレイヤーが読み込めていなければ、その関係は null。 */
export interface LinkSet {
  circle: Circle3;
  facilityStation: (FacilityStationResult & { summary: FacilityStationSummary }) | null;
  stationPopulation: (StationPopulationResult & { summary: StationPopulationSummary }) | null;
}

declare global {
  interface Window {
    /** 対応の線の関係を計算した回数（確認用）。固定した地点か半径が変わったときだけ増える。 */
    __linkComputes: number;
  }
}

// 駅のまとめは、全駅について1回だけ作る（データごと）。
const stationSets = new WeakMap<TransitData, StationSet>();
function stationSetOf(transit: TransitData): StationSet {
  let set = stationSets.get(transit);
  if (!set) {
    set = buildStationSet(
      transit.stationPoints,
      transit.stations.features.map((f) => f.properties.name),
    );
    stationSets.set(transit, set);
  }
  return set;
}

/** 円の中の施設（縁の上を含む）。 */
function facilitiesIn(data: FacilityData, c: Circle3): FacilityInput[] {
  const out: FacilityInput[] = [];
  data.all.forEach((p, i) => {
    if (pointInCircle(p[0], p[1], c.x, c.y, c.r)) out.push({ pos: p, kind: data.kind[i], name: data.name[i] });
  });
  return out;
}

export function computeLinks(
  data: Partial<Record<DataKey, unknown>>,
  status: Record<DataKey, LayerStatus>,
  circle: Circle3,
): LinkSet {
  if (typeof window !== 'undefined') window.__linkComputes = (window.__linkComputes ?? 0) + 1;
  const transit = status.transit === 'ready' ? (data.transit as TransitData) : null;
  const facilities = status.facilities === 'ready' ? (data.facilities as FacilityData) : null;
  const population = status.population === 'ready' ? (data.population as PopulationData) : null;
  const stations = transit ? stationSetOf(transit) : null;

  let facilityStation: LinkSet['facilityStation'] = null;
  if (stations && facilities) {
    const r = facilityStationLinks(facilitiesIn(facilities, circle), stations);
    facilityStation = { ...r, summary: summarizeFacilityStation(r) };
  }
  let stationPopulation: LinkSet['stationPopulation'] = null;
  if (stations && population) {
    const r = stationPopulationLinks(stations, circle, (x, y) => {
      const [i] = population.index.containing(x, y);
      return i === undefined ? null : population.cells[i].density;
    });
    stationPopulation = { ...r, summary: summarizeStationPopulation(r) };
  }
  return { circle, facilityStation, stationPopulation };
}

let cached: { data: unknown; status: unknown; key: string; result: LinkSet } | null = null;

/** computeLinks の結果を1つだけ覚えておく。同じ円・同じデータ・同じ読み込み状態なら、前の結果をそのまま返す。 */
export function cachedLinks(
  data: Partial<Record<DataKey, unknown>>,
  status: Record<DataKey, LayerStatus>,
  circle: Circle3,
): LinkSet {
  const key = `${circle.x},${circle.y},${circle.r}`;
  if (cached && cached.data === data && cached.status === status && cached.key === key) return cached.result;
  const result = computeLinks(data, status, circle);
  cached = { data, status, key, result };
  return result;
}
