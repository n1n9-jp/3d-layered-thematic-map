import { fetchJson } from '../lib/fetch';
import type { RoadCollection, LayerModule } from '../types';

const roads: LayerModule<RoadCollection> = {
  id: 'roads',
  label: '道路',
  load: (base) => fetchJson<RoadCollection>(`${base}roads.geojson`),
  render: () => [],
  sample: () => [],
  legend: [],
};

export default roads;
