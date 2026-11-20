import { fetchJson } from '../lib/fetch';
import type { FacilityCollection, LayerModule } from '../types';

const facilities: LayerModule<FacilityCollection> = {
  id: 'facilities',
  label: '施設',
  load: (base) => fetchJson<FacilityCollection>(`${base}facilities.geojson`),
  render: () => [],
  sample: () => [],
  legend: [],
};

export default facilities;
