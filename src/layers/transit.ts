import { fetchJson } from '../lib/fetch';
import type { LayerModule, RailCollection, StationCollection } from '../types';

export interface TransitData {
  rail: RailCollection;
  stations: StationCollection;
}

const transit: LayerModule<TransitData> = {
  id: 'transit',
  label: '公共交通',
  async load(base) {
    const [rail, stations] = await Promise.all([
      fetchJson<RailCollection>(`${base}rail.geojson`),
      fetchJson<StationCollection>(`${base}stations.geojson`),
    ]);
    return { rail, stations };
  },
  render: () => [],
  sample: () => [],
  legend: [],
};

export default transit;
