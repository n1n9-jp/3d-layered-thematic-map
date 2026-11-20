import { BitmapLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchBuffer, fetchJson } from '../lib/fetch';
import { sampleGrid } from '../lib/grid';
import { asModelMatrix } from '../stack';
import type { ElevationData, ElevationMeta, LayerModule } from '../types';
import { LEGEND_STOPS, elevationColor, elevationPixels } from './elevation/color';

/** 標高格子に、色に変換済みの画像を添えたもの。画像は load で1回だけ作る。 */
export interface ElevationLayerData extends ElevationData {
  image: ImageData;
}

const elevation: LayerModule<ElevationLayerData> = {
  id: 'elevation',
  label: '標高',
  async load(base) {
    const [meta, buf] = await Promise.all([
      fetchJson<ElevationMeta>(`${base}elevation.json`),
      fetchBuffer(`${base}elevation.bin`),
    ]);
    if (buf.byteLength !== meta.width * meta.height * 4)
      throw new Error(`elevation.bin のサイズが ${meta.width}x${meta.height} Float32 と合いません`);
    const values = new Float32Array(buf);
    const image = new ImageData(elevationPixels(values), meta.width, meta.height);
    return { ...meta, values, image };
  },
  render(data, ctx) {
    // bounds は参照が変わるとメッシュを作り直すので、データごとに1つだけ持つ
    return [
      new BitmapLayer({
        id: 'elevation-bitmap',
        image: data.image,
        bounds: boundsOf(data),
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        modelMatrix: asModelMatrix(ctx.modelMatrix),
        opacity: ctx.opacity,
        textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
        pickable: false,
      }),
    ];
  },
  sample(data, x, y) {
    const v = sampleGrid(data, x, y);
    return [
      v === null
        ? { label: '標高', value: null }
        : { label: '標高', value: Math.round(v * 10) / 10, unit: 'm' },
    ];
  },
  legend: LEGEND_STOPS.map(({ value, label }) => ({
    color: elevationColor(value).slice(0, 3) as [number, number, number],
    label,
  })),
};

const boundsCache = new WeakMap<ElevationData, [number, number, number, number]>();
function boundsOf(d: ElevationData): [number, number, number, number] {
  let b = boundsCache.get(d);
  if (!b) {
    b = [d.minX, d.minY, d.maxX, d.maxY];
    boundsCache.set(d, b);
  }
  return b;
}

export default elevation;
