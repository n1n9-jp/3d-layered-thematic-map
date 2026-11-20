import { SolidPolygonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createPolygonIndex } from '../lib/spatialIndex';
import type { PolygonIndex } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, PopulationCollection, ProbeValue } from '../types';
import { densityColor, densityLegend } from './population/classes';

/** 描画用に整形したメッシュ1個。 */
interface Cell {
  polygon: Position[];
  color: [number, number, number, number];
  population: number;
  density: number;
  /** 4隅の平均（subset の「セルの中心」） */
  center: Position;
  /** メッシュの面積（m²）。人口密度の集計に使う */
  area: number;
}

export interface PopulationData {
  /** 描画に渡す配列。作り直さず同じ参照を使い続ける */
  cells: Cell[];
  /** sample 用：cells と同じ添字の多角形索引 */
  index: PolygonIndex;
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

/** リング（始点に戻る閉じた輪郭でも、戻らなくても）の頂点の平均。 */
function ringCenter(ring: Position[]): Position {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return n > 0 ? [sx / n, sy / n] : [NaN, NaN];
}

/** リングの面積（m²、靴ひも公式）。 */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

function makeData(cells: Cell[]): PopulationData {
  return { cells, index: createPolygonIndex(cells.map((c) => [c.polygon])) };
}

// アクセサは固定の参照にして、render のたびに属性が再計算されないようにする。
const getPolygon = (d: Cell) => d.polygon;
const getFillColor = (d: Cell) => d.color;

export function buildPopulationData(fc: PopulationCollection): PopulationData {
  const features = fc.features.filter((f) => f.geometry?.type === 'Polygon');
  const cells: Cell[] = features.map((f) => {
    const { population, density } = f.properties;
    const [r, g, b] = densityColor(density);
    const polygon = f.geometry.coordinates[0];
    return {
      polygon,
      color: [r, g, b, 255],
      population,
      density,
      center: ringCenter(polygon),
      area: ringArea(polygon),
    };
  });
  const index = createPolygonIndex(features.map((f) => f.geometry.coordinates));
  return { cells, index };
}

const noPopulation = (): ProbeValue[] => [{ label: '人口', value: null }];

const population: LayerModule<PopulationData> = {
  id: 'population',
  label: '人口',
  async load(base) {
    return buildPopulationData(await fetchJson<PopulationCollection>(`${base}population.geojson`));
  },
  render: (data, ctx) => [
    new SolidPolygonLayer<Cell>({
      id: 'population-fill',
      data: data.cells,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      getPolygon,
      getFillColor,
      opacity: ctx.opacity,
      filled: true,
      extruded: false,
      pickable: false,
    }),
  ],
  subset(data, cx, cy, radius) {
    const cells = data.cells.filter((c) => pointInCircle(c.center[0], c.center[1], cx, cy, radius));
    return { ...makeData(cells), clip: { cx, cy, r: radius } };
  },
  summarize(data) {
    let total = 0;
    let area = 0;
    for (const c of data.cells) {
      if (Number.isFinite(c.population)) total += c.population;
      area += c.area;
    }
    return [
      { label: '人口', value: total, unit: '人' },
      area > 0
        ? { label: '人口密度', value: Math.round(total / (area / 1e6)), unit: '人/km²' }
        : { label: '人口密度', value: null },
    ];
  },
  sample(data, x, y) {
    if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return noPopulation();
    const [i] = data.index.containing(x, y);
    if (i === undefined) return noPopulation();
    const { population: pop, density } = data.cells[i];
    return [
      { label: '人口', value: pop, unit: '人' },
      { label: '人口密度', value: density, unit: '人/km²' },
    ];
  },
  legend: densityLegend(),
};

export default population;
