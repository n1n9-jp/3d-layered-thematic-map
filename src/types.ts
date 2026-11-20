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
  legend: { color: [number, number, number]; label: string }[];
}
