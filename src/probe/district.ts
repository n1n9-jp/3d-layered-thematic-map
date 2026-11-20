import { createPolygonIndex } from '../lib/spatialIndex';
import type { PolygonRings } from '../lib/spatialIndex';
import type { BoundaryData } from '../types';

/** 区境界から、地点 (x, y) を含む区の名前を引く関数を作る。含まれなければ null。 */
export function createDistrictLookup(boundary: BoundaryData): (x: number, y: number) => string | null {
  const polygons: PolygonRings[] = [];
  const names: string[] = [];
  for (const f of boundary.features) {
    const g = f.geometry;
    const parts = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const rings of parts) {
      polygons.push(rings);
      names.push(f.properties.name);
    }
  }
  const index = createPolygonIndex(polygons);
  return (x, y) => {
    const hit = index.containing(x, y)[0];
    return hit === undefined ? null : names[hit];
  };
}

const lookups = new WeakMap<BoundaryData, (x: number, y: number) => string | null>();
/** createDistrictLookup の結果を、境界データごとに1回だけ作って使い回す。 */
export function cachedDistrictLookup(boundary: BoundaryData): (x: number, y: number) => string | null {
  let lookup = lookups.get(boundary);
  if (!lookup) {
    lookup = createDistrictLookup(boundary);
    lookups.set(boundary, lookup);
  }
  return lookup;
}
