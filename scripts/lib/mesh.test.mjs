import { describe, expect, it } from 'vitest';
import { enumerateMeshCodes, meshBounds, meshCorners, subMeshCodes } from './mesh.mjs';

describe('meshBounds / meshCorners', () => {
  it('250m メッシュ 533946114（例）', () => {
    const { lon, lat, dLon, dLat } = meshBounds('533946114');
    expect(lon).toBeCloseTo(139.76875, 9);
    expect(lat).toBeCloseTo(35.6791667, 6);
    expect(lon + dLon).toBeCloseTo(139.775, 9);
    expect(lat + dLat).toBeCloseTo(35.6833333, 6);
  });

  it('250m メッシュ（10桁）は 緯度7.5秒 × 経度11.25秒', () => {
    const { dLon, dLat } = meshBounds('5339461141');
    expect(dLat * 3600).toBeCloseTo(7.5, 9);
    expect(dLon * 3600).toBeCloseTo(11.25, 9);
  });

  it('3次メッシュ（8桁）は 緯度30秒 × 経度45秒', () => {
    const { lon, lat, dLon, dLat } = meshBounds('53394611');
    expect(dLat * 3600).toBeCloseTo(30, 9);
    expect(dLon * 3600).toBeCloseTo(45, 9);
    expect(lon).toBeCloseTo(139.7625, 9);
    expect(lat).toBeCloseTo(35.675, 9);
  });

  it('9桁目：1=南西, 2=南東, 3=北西, 4=北東', () => {
    const base = meshBounds('53394611');
    const at = (q) => meshBounds(`53394611${q}`);
    expect(at(1).lon).toBeCloseTo(base.lon, 9);
    expect(at(1).lat).toBeCloseTo(base.lat, 9);
    expect(at(2).lon).toBeCloseTo(base.lon + base.dLon / 2, 9);
    expect(at(2).lat).toBeCloseTo(base.lat, 9);
    expect(at(3).lon).toBeCloseTo(base.lon, 9);
    expect(at(3).lat).toBeCloseTo(base.lat + base.dLat / 2, 9);
    expect(at(4).lon).toBeCloseTo(base.lon + base.dLon / 2, 9);
    expect(at(4).lat).toBeCloseTo(base.lat + base.dLat / 2, 9);
  });

  it('四隅は南西 → 南東 → 北東 → 北西の順', () => {
    const [sw, se, ne, nw] = meshCorners('533946114');
    expect(sw).toEqual([expect.closeTo(139.76875, 9), expect.closeTo(35.6791667, 6)]);
    expect(se[0]).toBeGreaterThan(sw[0]);
    expect(se[1]).toBe(sw[1]);
    expect(ne[0]).toBe(se[0]);
    expect(ne[1]).toBeGreaterThan(se[1]);
    expect(nw[0]).toBe(sw[0]);
    expect(nw[1]).toBe(ne[1]);
  });

  it('不正なコードは例外', () => {
    expect(() => meshBounds('5339')).toThrow();
    expect(() => meshBounds('53394611x')).toThrow();
    expect(() => meshBounds('533946115')).toThrow();
    expect(() => meshBounds('533946110')).toThrow();
  });
});

describe('enumerateMeshCodes', () => {
  it('1次メッシュの中の 500m は 6400×4 個、250m は 6400×16 個で、重複なし', () => {
    const m500 = enumerateMeshCodes('5339', 500);
    const m250 = enumerateMeshCodes('5339', 250);
    expect(m500).toHaveLength(25600);
    expect(m250).toHaveLength(102400);
    expect(new Set(m250).size).toBe(102400);
    expect(m500.every((c) => /^5339\d{4}[1-4]$/.test(c))).toBe(true);
    expect(m250.every((c) => /^5339\d{4}[1-4]{2}$/.test(c))).toBe(true);
  });

  it('subMeshCodes は 500m に 4個、250m に 16個', () => {
    expect(subMeshCodes('53394611', 500)).toEqual(['533946111', '533946112', '533946113', '533946114']);
    expect(subMeshCodes('53394611', 250)).toHaveLength(16);
    expect(() => subMeshCodes('53394611', 100)).toThrow();
  });

  it('250m の範囲は1次メッシュ（緯度2/3度×経度1度）に収まり、隣と重ならず敷き詰める', () => {
    const codes = enumerateMeshCodes('5339', 250);
    let area = 0;
    for (const c of codes) {
      const { lon, lat, dLon, dLat } = meshBounds(c);
      expect(lon).toBeGreaterThanOrEqual(139 - 1e-9);
      expect(lon + dLon).toBeLessThanOrEqual(140 + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(35.3333333 - 1e-6);
      expect(lat + dLat).toBeLessThanOrEqual(36 + 1e-9);
      area += dLon * dLat;
    }
    expect(area).toBeCloseTo(1 * (2 / 3), 9);
  });
});
