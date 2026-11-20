import { SolidPolygonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { createPolygonIndex } from '../lib/spatialIndex';
import type { PolygonIndex } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, PopulationCollection } from '../types';
import { densityColor, densityLegend } from './population/classes';

/** 描画用に整形したメッシュ1個。 */
interface Cell {
  polygon: Position[];
  color: [number, number, number, number];
  population: number;
  density: number;
}

export interface PopulationData {
  /** 描画に渡す配列。作り直さず同じ参照を使い続ける */
  cells: Cell[];
  /** sample 用：cells と同じ添字の多角形索引 */
  index: PolygonIndex;
}

// アクセサは固定の参照にして、render のたびに属性が再計算されないようにする。
const getPolygon = (d: Cell) => d.polygon;
const getFillColor = (d: Cell) => d.color;

export function buildPopulationData(fc: PopulationCollection): PopulationData {
  const features = fc.features.filter((f) => f.geometry?.type === 'Polygon');
  const cells: Cell[] = features.map((f) => {
    const { population, density } = f.properties;
    const [r, g, b] = densityColor(density);
    return { polygon: f.geometry.coordinates[0], color: [r, g, b, 255], population, density };
  });
  const index = createPolygonIndex(features.map((f) => f.geometry.coordinates));
  return { cells, index };
}

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
  sample(data, x, y) {
    const [i] = data.index.containing(x, y);
    if (i === undefined) return [{ label: '人口', value: null }];
    const { population: pop, density } = data.cells[i];
    return [
      { label: '人口', value: pop, unit: '人' },
      { label: '人口密度', value: density, unit: '人/km²' },
    ];
  },
  legend: densityLegend(),
};

export default population;
