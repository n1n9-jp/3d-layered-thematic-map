import { describe, expect, it } from 'vitest';
import { toLocal } from './projection.mjs';
import { createWards, loadWards } from './wards.mjs';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (code, name, geometry) => ({ type: 'Feature', properties: { code, name }, geometry });

const wards = createWards([
  feature('13101', 'A区', { type: 'Polygon', coordinates: [square(0, 0, 100, 100)] }),
  // 2つに分かれた区（MultiPolygon）。2つ目は穴あき
  feature('13102', 'B区', {
    type: 'MultiPolygon',
    coordinates: [
      [square(200, 0, 300, 100)],
      [square(400, 0, 600, 200), square(450, 50, 550, 150)],
    ],
  }),
  // 凹形（L字）
  feature('13103', 'C区', {
    type: 'Polygon',
    coordinates: [[[0, 300], [200, 300], [200, 350], [50, 350], [50, 500], [0, 500], [0, 300]]],
  }),
]);

describe('wardAt / contains', () => {
  it('内側の点は区を返す', () => {
    expect(wards.wardAt(50, 50)).toEqual({ code: '13101', name: 'A区' });
    expect(wards.contains(50, 50)).toBe(true);
  });

  it('どの区にも含まれない点は null / false', () => {
    expect(wards.wardAt(150, 50)).toBeNull();
    expect(wards.contains(150, 50)).toBe(false);
    expect(wards.wardAt(-1, 50)).toBeNull();
    expect(wards.wardAt(50, 101)).toBeNull();
    expect(wards.wardAt(1e6, 1e6)).toBeNull();
  });

  it('複数ポリゴンの区は、どのポリゴンの内側でも同じ区を返す', () => {
    expect(wards.wardAt(250, 50)).toEqual({ code: '13102', name: 'B区' });
    expect(wards.wardAt(420, 20)).toEqual({ code: '13102', name: 'B区' });
    expect(wards.wardAt(350, 50)).toBeNull();
  });

  it('穴の中は外側として扱う', () => {
    expect(wards.wardAt(500, 100)).toBeNull();
    expect(wards.wardAt(500, 20)).toEqual({ code: '13102', name: 'B区' });
  });

  it('凹んだ形でも、外接矩形の内側かつ形の外側の点は null', () => {
    expect(wards.wardAt(25, 450)).toEqual({ code: '13103', name: 'C区' });
    expect(wards.wardAt(100, 450)).toBeNull();
    expect(wards.wardAt(100, 320)).toEqual({ code: '13103', name: 'C区' });
  });

  it('features に読み込んだ Feature をそのまま持つ', () => {
    expect(wards.features).toHaveLength(3);
    expect(wards.features[0].properties.code).toBe('13101');
  });

  it('多数回の呼び出しが速い（凹凸の多い大きな多角形で 20万回）', () => {
    const n = 2000;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const r = 5000 + (i % 2 ? 300 : 0);
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    ring.push(ring[0]);
    const big = createWards([feature('13999', '大区', { type: 'Polygon', coordinates: [ring] })]);
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < 200000; i++) {
      if (big.contains(((i * 7919) % 12000) - 6000, ((i * 104729) % 12000) - 6000)) hits++;
    }
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(hits).toBeGreaterThan(0);
  });
});

describe('loadWards（生成済みの boundary.geojson）', () => {
  const real = loadWards();
  const at = (lon, lat) => {
    const [x, y] = toLocal(lon, lat);
    return real.wardAt(x, y);
  };

  it('23区ある', () => {
    expect(real.features).toHaveLength(23);
  });

  it('既知の地点', () => {
    expect(at(139.7671, 35.6812)?.name).toBe('千代田区'); // 東京駅
    expect(at(139.7005, 35.6896)?.name).toBe('新宿区'); // 新宿駅
    expect(at(139.8107, 35.7101)?.name).toBe('墨田区'); // 東京スカイツリー
    expect(at(139.7853, 35.5494)?.name).toBe('大田区'); // 羽田空港第1ターミナル
    expect(at(139.85, 35.58)).toBeNull(); // 東京湾上
    expect(at(139.5797, 35.7031)).toBeNull(); // 吉祥寺駅（武蔵野市）
  });
});
