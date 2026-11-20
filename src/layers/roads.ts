import { PathLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, RoadClass, RoadCollection } from '../types';
import {
  ROAD_CLASSES,
  ROAD_CLASS_LABEL,
  buildRoadData,
  roadSectionIndex,
  sampleRoads,
  sectionRoads,
  subsetRoads,
  summarizeRoads,
} from './roadsModel';
import type { RoadData } from './roadsModel';

type Rgb = [number, number, number];

/**
 * 青緑の色相（150〜185°付近）は保ち、種別ごとに明るさ・彩度・太さを大きく変える。
 * 高速＝ほぼ白のミント（太い）、国道＝彩度の高い明るい緑青、都道府県道＝中間の青緑、一般道＝暗く細い青緑。
 * 幅はメートル指定で、画面上では下限〜上限のピクセル幅に収める。
 */
const STYLE: Record<RoadClass, { color: Rgb; width: number; minPx: number; maxPx: number }> = {
  other: { color: [38, 112, 118], width: 6, minPx: 0.7, maxPx: 1.4 },
  prefectural: { color: [34, 176, 160], width: 12, minPx: 1.4, maxPx: 2.6 },
  national: { color: [64, 240, 168], width: 24, minPx: 2.8, maxPx: 5 },
  motorway: { color: [232, 255, 244], width: 40, minPx: 4.6, maxPx: 8 },
};

const getPath = (d: Position[]) => d;

const roads: LayerModule<RoadData> = {
  id: 'roads',
  label: '道路',
  async load(base) {
    const data = buildRoadData(await fetchJson<RoadCollection>(`${base}roads.geojson`));
    roadSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
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
  section: (data, line) => [sectionRoads(data, line, (cls) => STYLE[cls].color)],
  subset: subsetRoads,
  summarize: summarizeRoads,
  legend: [...ROAD_CLASSES].reverse().map((cls) => ({ color: STYLE[cls].color, label: ROAD_CLASS_LABEL[cls] })),
};

export default roads;
