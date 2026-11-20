import type { Layer } from '@deck.gl/core';
import type { LayerId } from './config';

/* ---------- GeoJSON（座標は README の座標系のローカルメートル） ---------- */

export type Position = [number, number];
export type Ring = Position[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Ring[];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Ring[][];
}
export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}
export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}

export interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Feature<G, P>[];
}

/* ---------- README「データ仕様」の properties ---------- */

export interface BoundaryProps {
  code: string; // 市区町村コード5桁
  name: string; // 区名
}
export interface PopulationProps {
  meshCode: string;
  population: number; // 人
  density: number; // 人/km²
}
export type RoadClass = 'motorway' | 'national' | 'prefectural' | 'other';
export interface RoadProps {
  class: RoadClass;
  name: string | null;
}
export interface RailProps {
  operator: string;
  line: string;
}
export interface StationProps {
  name: string;
  operator: string;
  line: string;
}
export type FacilityKind = 'school' | 'hospital';
export interface FacilityProps {
  kind: FacilityKind;
  name: string;
  subtype: string; // 学校種別、病院/診療所の別など
}

export type BoundaryData = FeatureCollection<PolygonGeometry | MultiPolygonGeometry, BoundaryProps>;
export type PopulationCollection = FeatureCollection<PolygonGeometry, PopulationProps>;
export type RoadCollection = FeatureCollection<LineStringGeometry, RoadProps>;
export type RailCollection = FeatureCollection<LineStringGeometry, RailProps>;
export type StationCollection = FeatureCollection<PointGeometry, StationProps>;
export type FacilityCollection = FeatureCollection<PointGeometry, FacilityProps>;

/** `elevation.json` */
export interface ElevationMeta {
  width: number;
  height: number;
  cellSize: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  min: number;
  max: number;
}
/** 標高格子。`values` は北から南、西から東の順（行優先）。データなしは NaN。 */
export interface ElevationData extends ElevationMeta {
  values: Float32Array;
}

/* ---------- 断面（2点を結ぶ線に沿った値） ---------- */

/** 断面の線。a から b へ。 */
export interface SectionLine {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** 線に沿った連続した値（標高、人口密度）。 */
export interface SectionSeries {
  kind: 'series';
  label: string; // 例：'標高'
  unit: string; // 例：'m'
  /** 線に沿った距離（m）と値。値がない区間は value が null。階段状の値は、区間の両端に同じ値の点を置く。 */
  points: { d: number; value: number | null }[];
  /** 縦軸の範囲の目安（全体のデータで固定。線によって変わらない）。 */
  domain: [number, number];
  /** 値に対応する色を返す（そのレイヤーの地図上の配色と同じ）。 */
  color(value: number): [number, number, number];
}

/** 線に沿った出来事（道路や鉄道との交差、近くの駅や施設）。 */
export interface SectionMarks {
  kind: 'marks';
  label: string; // 例：'道路との交差'
  marks: {
    d: number; // 線に沿った距離（m）
    offset: number; // 線からの距離（m）。交差は 0。線の進行方向に向かって左が正、右が負
    category: string; // 例：'motorway', 'school'
    categoryLabel: string; // 例：'高速道路', '学校'
    name: string | null; // 路線名、駅名、施設名など
    color: [number, number, number];
    x: number; // その地物の地点（ローカル座標）
    y: number;
  }[];
}

export type SectionTrack = SectionSeries | SectionMarks;

/* ---------- レイヤーモジュールの契約 ---------- */

export interface LayerRenderContext {
  /** そのレイヤーの高さ（m） */
  z: number;
  /** [0,0,z] への平行移動（列優先の16要素）。データは2Dのまま渡し、高さはこれだけで与える */
  modelMatrix: number[];
  opacity: number;
  /** 単独表示中か */
  solo: boolean;
  /** 区境界（輪郭の重ね描き用） */
  boundary: BoundaryData | null;
}

export interface ProbeValue {
  label: string;
  value: string | number | null;
  unit?: string;
}

export interface LayerModule<D> {
  id: LayerId;
  /** 日本語の表示名 */
  label: string;
  /** データ取得と索引の構築 */
  load(base: string): Promise<D>;
  /** deck.gl レイヤー。id は `${id}-*` */
  render(data: D, ctx: LayerRenderContext): Layer[];
  /** 地点 (x, y) の値（探針用） */
  sample(data: D, x: number, y: number): ProbeValue[];
  /** 中心 (cx, cy)・半径 radius（m）の円の中だけを取り出した、同じ形のデータを返す。render と sample にそのまま渡せる。 */
  subset(data: D, cx: number, cy: number, radius: number): D;
  /** データ（ふつうは subset の結果）の集計を返す。 */
  summarize(data: D): ProbeValue[];
  /** 線に沿った、このレイヤーの値。1レイヤーが複数のトラックを返してよい。 */
  section(data: D, line: SectionLine): SectionTrack[];
  legend: { color: [number, number, number]; label: string }[];
}
