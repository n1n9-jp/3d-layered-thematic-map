import { PathLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, RoadClass, RoadCollection } from '../types';
import { ROAD_CLASSES, ROAD_CLASS_LABEL, buildRoadData, sampleRoads } from './roadsModel';
import type { RoadData } from './roadsModel';

type Rgb = [number, number, number];

/** 青緑〜ミント系。上位の道路ほど明るく太い。幅はメートル指定で、画面上では下限〜上限のピクセル幅に収める。 */
const STYLE: Record<RoadClass, { color: Rgb; width: number; minPx: number; maxPx: number }> = {
  other: { color: [24, 132, 116], width: 8, minPx: 0.8, maxPx: 3 },
  prefectural: { color: [40, 180, 150], width: 14, minPx: 1.4, maxPx: 5 },
  national: { color: [80, 226, 188], width: 22, minPx: 2.2, maxPx: 7 },
  motorway: { color: [170, 255, 226], width: 34, minPx: 3.2, maxPx: 10 },
};

const getPath = (d: Position[]) => d;

const roads: LayerModule<RoadData> = {
  id: 'roads',
  label: '道路',
  async load(base) {
    return buildRoadData(await fetchJson<RoadCollection>(`${base}roads.geojson`));
  },
  render(data, ctx) {
    return ROAD_CLASSES.map((cls) => {
      const s = STYLE[cls];
      return new PathLayer<Position[]>({
        id: `roads-${cls}`,
        data: data.paths[cls],
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        modelMatrix: asModelMatrix(ctx.modelMatrix),
        opacity: ctx.opacity,
        getPath,
        getColor: s.color,
        getWidth: s.width,
        widthUnits: 'meters',
        widthMinPixels: s.minPx,
        widthMaxPixels: s.maxPx,
        billboard: true,
        capRounded: true,
        jointRounded: true,
        pickable: false,
      });
    });
  },
  sample: sampleRoads,
  legend: [...ROAD_CLASSES].reverse().map((cls) => ({ color: STYLE[cls].color, label: ROAD_CLASS_LABEL[cls] })),
};

export default roads;
