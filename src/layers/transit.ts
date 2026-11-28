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
    // 浸水の格子がないときは、すべて「それ以外」の色で描く。区域外を先、区域内を後に並べるので、区域内の区間・駅が上に重なる
    const e = transitExposure(data, ctx.options.floodScenario);
    const paths = e?.drawPaths ?? data.railPaths;
    const pathExposed = e?.drawPathExposed;
    const points = e?.drawStations ?? data.stationPoints;
    const pointExposed = e?.drawStationExposed;
    const exposedAt = (flags: Uint8Array | undefined, i: number) => flags?.[i] === 1;
    return [
      new PathLayer<Position[]>({
        ...common,
        id: 'transit-rail',
        data: paths,
        getPath,
        getColor: (_d: Position[], { index }: { index: number }) => (exposedAt(pathExposed, index) ? C.railExposed : C.railOther),
        getWidth: 30,
        widthUnits: 'meters',
        widthMinPixels: 2.2,
        widthMaxPixels: 7,
        billboard: true,
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getColor: [pathExposed] },
      }),
      new ScatterplotLayer<Position>({
        ...common,
        id: 'transit-stations',
        data: points,
        getPosition,
        getFillColor: (_d: Position, { index }: { index: number }) => (exposedAt(pointExposed, index) ? C.stationExposed : C.stationOther),
        getLineColor: (_d: Position, { index }: { index: number }) => (exposedAt(pointExposed, index) ? C.stationExposedOutline : C.stationOtherOutline),
        getRadius: 160,
        radiusUnits: 'meters',
        radiusMinPixels: 3.5,
        radiusMaxPixels: 10,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: (_d: Position, { index }: { index: number }) => (exposedAt(pointExposed, index) ? 1.6 : 1),
        billboard: false,
        updateTriggers: { getFillColor: [pointExposed], getLineColor: [pointExposed], getLineWidth: [pointExposed] },
      }),
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
