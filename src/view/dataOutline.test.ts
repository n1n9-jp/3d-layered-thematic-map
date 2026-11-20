import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_OUTLINE, EXTENT } from '../config';
import { convexHull } from './layout';
import type { Pt } from './layout';

const FILE = 'public/data/boundary.geojson';

describe('DATA_OUTLINE（23区のデータのある範囲）', () => {
  it('凸多角形で、描画範囲の中に収まり、中心（描画範囲の中心）を含む', () => {
    const pts = DATA_OUTLINE.map((p) => [p[0], p[1]] as Pt);
    expect(convexHull(pts)).toHaveLength(pts.length);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThan(EXTENT.minX);
      expect(x).toBeLessThan(EXTENT.maxX);
      expect(y).toBeGreaterThan(EXTENT.minY);
      expect(y).toBeLessThan(EXTENT.maxY);
    }
    const c: Pt = [(EXTENT.minX + EXTENT.maxX) / 2, (EXTENT.minY + EXTENT.maxY) / 2];
    let sign = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (sign === 0) sign = Math.sign(cr);
      expect(Math.sign(cr)).toBe(sign);
    }
  });

  it.skipIf(!existsSync(FILE))('実データの区境界のすべての頂点を囲む（データがこの範囲からはみ出して、パネルの下に隠れない）', () => {
    const geo = JSON.parse(readFileSync(FILE, 'utf8')) as { features: { geometry: { coordinates: unknown } }[] };
    const verts: Pt[] = [];
    const walk = (c: unknown): void => {
      if (Array.isArray(c) && typeof c[0] === 'number') verts.push([c[0], c[1] as number]);
      else if (Array.isArray(c)) c.forEach(walk);
    };
    geo.features.forEach((f) => walk(f.geometry.coordinates));
    expect(verts.length).toBeGreaterThan(1000);
    const poly = DATA_OUTLINE;
    // 反時計回りの凸多角形の、すべての辺の左側にあれば内側
    const outside = verts.filter((p) =>
      poly.some((a, i) => {
        const b = poly[(i + 1) % poly.length];
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0;
      }),
    );
    expect(outside).toEqual([]);
  });
});
