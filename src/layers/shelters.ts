import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import type { PolygonRings } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { BoundaryData, FacilityCollection, LayerModule, Position, ShelterCollection, ShelterSummary } from '../types';
import { HATCH_COLOR, SHELTER_COLORS, buildShelterData, sampleShelters, sectionShelters, shelterOverview, shelterSectionIndex, subsetShelters, summarizeShelters } from './shelters/model';
import type { ShelterData, ShelterKind } from './shelters/model';

export type { ShelterData };

type Rgb = [number, number, number];

/** 洪水・高潮で使えるものは大きく鮮やか。それ以外は小さく控えめ。病院は赤で、白い縁を付けて見分ける。 */
const STYLE: Record<ShelterKind, { radius: number; minPx: number; maxPx: number; outline: Rgb; lineWidth: number }> = {
  other: { radius: 70, minPx: 2, maxPx: 4.5, outline: [0, 0, 0], lineWidth: 0.4 },
  hospital: { radius: 120, minPx: 4, maxPx: 10, outline: [255, 255, 255], lineWidth: 1.4 },
  usable: { radius: 170, minPx: 5, maxPx: 13, outline: [255, 255, 255], lineWidth: 1.2 },
};
/** 描く順（下から）：控えめなものを先に、目立たせたいものを後に。 */
const DRAW_ORDER: ShelterKind[] = ['other', 'hospital', 'usable'];

const getPosition = (d: Position) => d;
const getRings = (d: PolygonRings) => d as never;
const getSegment = (d: Position[]) => d;

const shelters: LayerModule<ShelterData> = {
  id: 'shelters',
  label: '避難',
  async load(base) {
    const [sh, summary, facilities, boundary] = await Promise.all([
      fetchJson<ShelterCollection>(`${base}shelters.geojson`),
      fetchJson<ShelterSummary>(`${base}shelters.json`),
      fetchJson<FacilityCollection>(`${base}facilities.geojson`),
      fetchJson<BoundaryData>(`${base}boundary.geojson`),
    ]);
    const data = buildShelterData(sh, summary, facilities, boundary);
    shelterSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
  },
  render(data, ctx) {
    const common = {
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      opacity: ctx.opacity,
      pickable: false,
    } as const;
    return [
      // データ未公開の区：薄い塗りと、斜めの網掛け（0 件の区ではなく、データがない区であることを示す）
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-gap-fill',
        data: data.gapPolygons,
        getPolygon: getRings,
        getFillColor: [...HATCH_COLOR, 34],
        filled: true,
        extruded: false,
      }),
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-gap-hatch',
        data: data.hatch,
        getPath: getSegment,
        getColor: [...HATCH_COLOR, 150],
        getWidth: 1,
        widthUnits: 'pixels',
        billboard: true,
      }),
      ...DRAW_ORDER.map((kind) => {
        const s = STYLE[kind];
        return new ScatterplotLayer<Position>({
          ...common,
          id: `shelters-${kind}`,
          data: data.points[kind],
          getPosition,
          getFillColor: SHELTER_COLORS[kind],
          getLineColor: s.outline,
          getRadius: s.radius,
          radiusUnits: 'meters',
          radiusMinPixels: s.minPx,
          radiusMaxPixels: s.maxPx,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: s.lineWidth,
          billboard: false,
        });
      }),
    ];
  },
  sample: sampleShelters,
  section: (data, line) => [sectionShelters(data, line)],
  subset: subsetShelters,
  summarize: summarizeShelters,
  legend: () => [
    { color: SHELTER_COLORS.usable, label: '洪水・高潮で使える避難場所' },
    { color: SHELTER_COLORS.other, label: 'それ以外の避難場所' },
    { color: SHELTER_COLORS.hospital, label: '病院' },
    { color: HATCH_COLOR, label: '網掛け：データ未公開の区' },
  ],
  notes: (data) => {
    const notes = [
      '指定緊急避難場所は、災害の種別ごとに指定されています。データが最新でない場合や、未掲載の場合があります。収容人数は含みません。',
    ];
    if (data) {
      const o = shelterOverview(data);
      notes.push(`網掛けの区（${o.unpublished.join('・')}）は、避難場所のデータを公開していません。0 件は「ない」ではなく「データがない」です。`);
      notes.push(`洪水・高潮で使える場所が 0 件の区：${o.zeroUsable.join('・')}（このデータでは）。`);
    }
    return notes;
  },
};

export default shelters;
