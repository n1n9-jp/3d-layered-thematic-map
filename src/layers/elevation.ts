import { BitmapLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchBuffer, fetchJson } from '../lib/fetch';
import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { sampleGrid } from '../lib/grid';
import { gridStats, subsetGrid } from '../lib/gridSubset';
import { asModelMatrix } from '../stack';
import type { ElevationData, ElevationMeta, LayerModule } from '../types';
import { LEGEND_STOPS, elevationColor, elevationPixels } from './elevation/color';
import { sectionElevation } from './elevation/section';

/** 標高格子に、色に変換済みの画像を添えたもの。画像は load で1回だけ作る。 */
export interface ElevationLayerData extends ElevationData {
  image: ImageData;
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

/** 小数1桁に丸める。-0.05〜0 は丸めると -0 になるので、+0 に直す（パネルに「-0」と出さない）。 */
export function roundTo1(v: number): number {
  return Math.round(v * 10) / 10 + 0;
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
  subset(data, cx, cy, radius) {
    const grid = subsetGrid(data, cx, cy, radius);
    const image = new ImageData(elevationPixels(grid.values), grid.width, grid.height);
    return { ...grid, image, clip: { cx, cy, r: radius } };
  },
  summarize(data) {
    const { count, min, max, mean } = gridStats(data);
    if (count === 0) return [{ label: '標高', value: null }, { label: '平均', value: null }];
    return [
      { label: '標高', value: `${roundTo1(min).toFixed(1)}〜${roundTo1(max).toFixed(1)}`, unit: 'm' },
      { label: '平均', value: roundTo1(mean), unit: 'm' },
    ];
  },
  section: (data, line) => [sectionElevation(data, line)],
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
    if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return [{ label: '標高', value: null }];
    const v = sampleGrid(data, x, y);
    return [
      v === null
        ? { label: '標高', value: null }
        : { label: '標高', value: roundTo1(v), unit: 'm' },
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
