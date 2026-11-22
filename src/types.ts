import type { Layer } from '@deck.gl/core';
import type { LayerId, LayerOptions } from './config';

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
  /** 65歳以上人口（人）。秘匿されたメッシュは null */
  elderly: number | null;
  /** true なら、周辺の秘匿メッシュの分を含む（合算先） */
  elderlyMerged: boolean;
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
/** `shelters.geojson`（指定緊急避難場所）。flood〜landslide は、その災害の種別で指定されているか。 */
export interface ShelterProps {
  name: string;
  address: string;
  ward: string;
  flood: boolean;
  tide: boolean;
  inland: boolean;
  quake: boolean;
  fire: boolean;
  tsunami: boolean;
  landslide: boolean;
  note: string | null;
}
/** `shelters.json`（区ごとの集計） */
export interface ShelterWardSummary {
  code: string;
  name: string;
  total: number;
  flood: number;
  tide: number;
  /** その区が、このデータに指定緊急避難場所を公開しているか。false の区の 0 件は「ない」ではなく「データがない」 */
  published: boolean;
  updated: string;
}
export interface ShelterSummary {
  updated: string;
  total: number;
  wards: ShelterWardSummary[];
}

export type BoundaryData = FeatureCollection<PolygonGeometry | MultiPolygonGeometry, BoundaryProps>;
export type PopulationCollection = FeatureCollection<PolygonGeometry, PopulationProps>;
export type RailCollection = FeatureCollection<LineStringGeometry, RailProps>;
export type StationCollection = FeatureCollection<PointGeometry, StationProps>;
export type FacilityCollection = FeatureCollection<PointGeometry, FacilityProps>;
export type ShelterCollection = FeatureCollection<PointGeometry, ShelterProps>;

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
  /**
   * 値が段（ランク）のときの、縦軸のラベル。value は段の番号で、その段の高さの位置にラベルを置く。short は軸に出す短い名前、label は読み取りに出す名前。
   * 指定があると、縦軸は数値ではなくこのラベルで読む（浸水の深さ・継続時間）。
   */
  ranks?: { value: number; short: string; label: string }[];
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
  /** 線から離れた地物を探した距離（m）。縦軸（線からの距離）の左右の端。指定がなければレイヤーごとの既定 */
  radius?: number;
  /** 線に沿った区間のうち、データがない（公開されていない）区間。グラフの上に網掛けで示す */
  gaps?: { d0: number; d1: number; label: string; kind: 'none' | 'unpublished' }[];
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
  /** レイヤー一覧の切り替えの状態 */
  options: LayerOptions;
}

/** レイヤー一覧の行に置く切り替え。 */
export interface OptionControl {
  key: keyof LayerOptions;
  /** 例：'想定' */
  label: string;
  choices: { value: string; label: string; title?: string }[];
}

export interface LegendItem {
  color: [number, number, number];
  label: string;
  /**
   * 見本の形。省略は塗りの四角。'hatch' は灰の斜線（データ未公開で、浸水が小さい区）、'hatch-deep' は灰の斜線に琥珀の塗りと縁（データ未公開で、浸水が深い区）、
   * 'alert' は琥珀の太い斜線と縁（浸水が深いのに指定がない区）、'faint' はごく薄い塗り（浸水が小さく指定がない区）
   */
  swatch?: 'hatch' | 'frame';
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
  /** 地点 (x, y) の値（探針用）。切り替えにかかわらず、そのレイヤーの値をすべて返す */
  sample(data: D, x: number, y: number): ProbeValue[];
  /** 中心 (cx, cy)・半径 radius（m）の円の中だけを取り出した、同じ形のデータを返す。render と sample にそのまま渡せる。 */
  subset(data: D, cx: number, cy: number, radius: number): D;
  /** データ（ふつうは subset の結果）の集計を返す。切り替えに従う。 */
  summarize(data: D, options: LayerOptions): ProbeValue[];
  /** 線に沿った、このレイヤーの値。1レイヤーが複数のトラックを返してよい。切り替えに従う。 */
  section(data: D, line: SectionLine, options: LayerOptions): SectionTrack[];
  /** 凡例。切り替えに従う。 */
  legend(options: LayerOptions): LegendItem[];
  /** レイヤー一覧の行に置く切り替え（なければ省く）。 */
  controls?: OptionControl[];
  /** 凡例の下に小さく出す注記（利用上の注意）。data は読み込み済みのときだけ渡る。 */
  notes?(data: D | undefined): string[];
}
