import { ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { asModelMatrix } from '../stack';
import type { FacilityCollection, FacilityKind, LayerModule, Position } from '../types';
import {
  FACILITY_KIND_LABEL,
  buildFacilityData,
  sampleFacilities,
  subsetFacilities,
  summarizeFacilities,
} from './facilitiesModel';
import type { FacilityData } from './facilitiesModel';

type Rgb = [number, number, number];

/** 学校は明るい水色、病院は赤。病院は件数が少ないので一回り大きくする。 */
const STYLE: Record<FacilityKind, { color: Rgb; radius: number; minPx: number; maxPx: number }> = {
  school: { color: [100, 205, 255], radius: 80, minPx: 2.5, maxPx: 8 },
  hospital: { color: [255, 70, 60], radius: 110, minPx: 3.5, maxPx: 10 },
};
const OUTLINE: Rgb = [0, 0, 0];
const KINDS: FacilityKind[] = ['school', 'hospital'];

const getPosition = (d: Position) => d;

const facilities: LayerModule<FacilityData> = {
  id: 'facilities',
  label: '施設',
  async load(base) {
    return buildFacilityData(await fetchJson<FacilityCollection>(`${base}facilities.geojson`));
  },
  render(data, ctx) {
    return KINDS.map((kind) => {
      const s = STYLE[kind];
      return new ScatterplotLayer<Position>({
        id: `facilities-${kind}`,
        data: data.points[kind],
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        modelMatrix: asModelMatrix(ctx.modelMatrix),
        opacity: ctx.opacity,
        getPosition,
        getFillColor: s.color,
        getLineColor: OUTLINE,
        getRadius: s.radius,
        radiusUnits: 'meters',
        radiusMinPixels: s.minPx,
        radiusMaxPixels: s.maxPx,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.6,
        billboard: false,
        pickable: false,
      });
    });
  },
  sample: sampleFacilities,
  subset: subsetFacilities,
  summarize: summarizeFacilities,
  legend: KINDS.map((k) => ({ color: STYLE[k].color, label: FACILITY_KIND_LABEL[k] })),
};

export default facilities;
