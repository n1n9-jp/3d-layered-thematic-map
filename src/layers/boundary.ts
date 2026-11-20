import { fetchJson } from '../lib/fetch';
import type { BoundaryData } from '../types';

export function loadBoundary(base: string): Promise<BoundaryData> {
  return fetchJson<BoundaryData>(`${base}boundary.geojson`);
}
