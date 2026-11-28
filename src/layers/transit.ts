import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { FLOOD_SCENARIOS } from '../config';
import { fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, RailCollection, StationCollection } from '../types';
import flood from './flood';
import { buildTransitData, sampleTransit, sectionTransit, subsetTransit, summarizeTransit, transitSectionIndex } from './transitModel';
import type { TransitData } from './transitModel';
import { EXPOSED_LABEL, OTHER_LABEL, TRANSIT_COLORS as C, transitExposure } from './transit/exposure';

export type { TransitData };

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
    // 浸水の段のデータ（読み取り専用。浸水の段と同じものを共有する）。読み込めなければ、描き分けのない公共交通として動く。
    try {
      data.flood = await flood.load(base);
    } catch (e) {
      console.error('[transit] 浸水の格子を読み込めませんでした。区域の描き分けは行いません', e);
      data.flood = null;
    }
    // 区域の判定は、読み込みの時点で作っておく（想定の切り替えでも、視点の操作でも、描画のたびには計算しない）
    for (const scenario of FLOOD_SCENARIOS) transitExposure(data, scenario);
    return data;
  },
  render(data, ctx) {
    const common = {
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      opacity: ctx.opacity,
      pickable: false,
    };
    // 浸水の格子がないときは、すべて「それ以外」の色で描く
    const e = transitExposure(data, ctx.options.floodScenario);
    const rail = { exposed: e?.exposedPaths ?? [], other: e?.otherPaths ?? data.railPaths };
    const stations = { exposed: e?.exposedStations ?? [], other: e?.otherStations ?? data.stationPoints };
    const railLayer = (id: string, paths: Position[][], color: [number, number, number]) =>
      new PathLayer<Position[]>({
        ...common,
        id,
        data: paths,
        getPath,
        getColor: color,
        getWidth: 30,
        widthUnits: 'meters',
        widthMinPixels: 2.2,
        widthMaxPixels: 7,
        billboard: true,
        capRounded: true,
        jointRounded: true,
      });
    const stationLayer = (id: string, points: Position[], fill: [number, number, number], line: [number, number, number], lineWidth: number) =>
      new ScatterplotLayer<Position>({
        ...common,
        id,
        data: points,
        getPosition,
        getFillColor: fill,
        getLineColor: line,
        getRadius: 160,
        radiusUnits: 'meters',
        radiusMinPixels: 3.5,
        radiusMaxPixels: 10,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: lineWidth,
        billboard: false,
      });
    // 描く順：落とした色を先に、区域のものを上に重ねる
    return [
      railLayer('transit-rail-other', rail.other, C.railOther),
      railLayer('transit-rail-exposed', rail.exposed, C.railExposed),
      stationLayer('transit-stations-other', stations.other, C.stationOther, C.stationOtherOutline, 1),
      stationLayer('transit-stations-exposed', stations.exposed, C.stationExposed, C.stationExposedOutline, 1.6),
    ];
  },
  sample: sampleTransit,
  section: (data, line, options) =>
    sectionTransit(
      data,
      line,
      { rail: C.railOther, station: C.stationOther, railExposed: C.railExposed, stationExposed: C.stationExposed },
      options.floodScenario,
    ),
  subset: subsetTransit,
  summarize: summarizeTransit,
  legend: () => [
    { color: C.railExposed, label: EXPOSED_LABEL },
    { color: C.railOther, label: OTHER_LABEL },
  ],
  notes: () => ['区域は、浸水の段の「想定」（大きいほう・洪水・高潮）に従います。「見るもの」には従わず、常に深さ 0.5m 以上かどうかで決めています。'],
};

export default transit;
