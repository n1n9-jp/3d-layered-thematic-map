import { fetchJson } from '../lib/fetch';
import type { PopulationCollection, LayerModule } from '../types';

const population: LayerModule<PopulationCollection> = {
  id: 'population',
  label: '人口',
  load: (base) => fetchJson<PopulationCollection>(`${base}population.geojson`),
  render: () => [],
  sample: () => [],
  legend: [],
};

export default population;
