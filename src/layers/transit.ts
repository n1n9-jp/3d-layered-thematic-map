import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, RailCollection, StationCollection } from '../types';
import { buildTransitData, sampleTransit, sectionTransit, subsetTransit, summarizeTransit, transitSectionIndex } from './transitModel';
import type { TransitData } from './transitModel';

export type { TransitData };

type Rgb = [number, number, number];

/** 桃〜赤紫系。駅は路線より明るい。 */
const RAIL_COLOR: Rgb = [214, 70, 170];
const STATION_COLOR: Rgb = [255, 190, 236];
const STATION_OUTLINE: Rgb = [70, 10, 55];

const getPath = (d: Position[]) => d;
const getPosition = (d: Position) => d;

const transit: LayerModule<TransitData> = {
  id: 'transit',
  label: '公共交通',
  async load(base) {
    const [rail, stations] = await Promise.all([
      fetchJson<RailCollection>(`${base}rail.geojson`),
      fetchJson<StationCollection>(`${base}stations.geojson`),
    ]);
    const data = buildTransitData(rail, stations);
    transitSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
  },
  render(data, ctx) {
    const common = {
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      opacity: ctx.opacity,
      pickable: false,
    };
    return [
      new PathLayer<Position[]>({
        ...common,
        id: 'transit-rail',
        data: data.railPaths,
        getPath,
        getColor: RAIL_COLOR,
        getWidth: 30,
        widthUnits: 'meters',
        widthMinPixels: 2.2,
        widthMaxPixels: 7,
        billboard: true,
        capRounded: true,
        jointRounded: true,
      }),
      new ScatterplotLayer<Position>({
        ...common,
        id: 'transit-stations',
        data: data.stationPoints,
        getPosition,
        getFillColor: STATION_COLOR,
        getLineColor: STATION_OUTLINE,
        getRadius: 160,
        radiusUnits: 'meters',
        radiusMinPixels: 3.5,
        radiusMaxPixels: 10,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        billboard: false,
      }),
    ];
  },
  sample: sampleTransit,
  section: (data, line) => sectionTransit(data, line, { rail: RAIL_COLOR, station: STATION_COLOR }),
  subset: subsetTransit,
  summarize: summarizeTransit,
  legend: () => [
    { color: RAIL_COLOR, label: '鉄道路線' },
    { color: STATION_COLOR, label: '駅' },
  ],
};

export default transit;
