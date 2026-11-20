import { fetchBuffer, fetchJson } from '../lib/fetch';
import type { ElevationData, ElevationMeta, LayerModule } from '../types';

const elevation: LayerModule<ElevationData> = {
  id: 'elevation',
  label: '標高',
  async load(base) {
    const [meta, buf] = await Promise.all([
      fetchJson<ElevationMeta>(`${base}elevation.json`),
      fetchBuffer(`${base}elevation.bin`),
    ]);
    if (buf.byteLength !== meta.width * meta.height * 4)
      throw new Error(`elevation.bin のサイズが ${meta.width}x${meta.height} Float32 と合いません`);
    return { ...meta, values: new Float32Array(buf) };
  },
  render: () => [],
  sample: () => [],
  legend: [],
};

export default elevation;
