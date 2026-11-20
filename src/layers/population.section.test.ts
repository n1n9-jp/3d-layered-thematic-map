import { describe, expect, it } from 'vitest';
import population, { buildPopulationData } from './population';
import type { PopulationData } from './population';
import { densityColor } from './population/classes';
import { lineLength, pointAt, reverseLine } from '../lib/section';
import type { PopulationCollection, Position, SectionLine, SectionSeries } from '../types';

/** 多角形（4隅）のメッシュ。人口 pop、密度 pop × 100。 */
const quad = (ring: Position[], pop: number, code = `${ring[0]}`) => ({
  type: 'Feature' as const,
  geometry: { type: 'Polygon' as const, coordinates: [[...ring, ring[0]]] },
  properties: { meshCode: code, population: pop, density: pop * 100 },
});
/** 100 m 四方のメッシュ。(x0, y0) が南西の角。 */
const mesh = (x0: number, y0: number, pop: number) =>
  quad([[x0, y0], [x0 + 100, y0], [x0 + 100, y0 + 100], [x0, y0 + 100]], pop);

const build = (...features: ReturnType<typeof mesh>[]): PopulationData =>
  buildPopulationData({ type: 'FeatureCollection', features } as PopulationCollection);
const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });
const series = (data: PopulationData, line: SectionLine): SectionSeries => {
  const tracks = population.section(data, line);
  expect(tracks).toHaveLength(1);
  expect(tracks[0].kind).toBe('series');
  return tracks[0] as SectionSeries;
};
/** 系列の、距離 d での値（階段の区切りの上は避けて引く）。 */
function valueAt(s: SectionSeries, d: number): number | null | undefined {
  for (let i = 0; i + 1 < s.points.length; i++) {
    const p = s.points[i];
    const q = s.points[i + 1];
    if (p.d + 1e-6 < d && d < q.d - 1e-6 && p.value === q.value) return p.value;
  }
  return undefined;
}

const row = build(mesh(0, 0, 100), mesh(100, 0, 200), mesh(200, 0, 300), mesh(0, 100, 0));

describe('population.section', () => {
  it('メッシュに入る点と出る点に同じ値の点を置く階段。メッシュがない区間は null', () => {
    const s = series(row, L(-50, 50, 350, 50));
    expect(s.points).toEqual([
      { d: 0, value: null },
      { d: 50, value: null },
      { d: 50, value: 10000 },
      { d: 150, value: 10000 },
      { d: 150, value: 20000 },
      { d: 250, value: 20000 },
      { d: 250, value: 30000 },
      { d: 350, value: 30000 },
      { d: 350, value: null },
      { d: 400, value: null },
    ]);
  });
  it('人口 0 のメッシュは 0、その先のメッシュがない区間は null', () => {
    const s = series(row, L(50, -50, 50, 250));
    expect(s.points).toEqual([
      { d: 0, value: null },
      { d: 50, value: null },
      { d: 50, value: 10000 },
      { d: 150, value: 10000 },
      { d: 150, value: 0 },
      { d: 250, value: 0 },
      { d: 250, value: null },
      { d: 300, value: null },
    ]);
  });
  it('同じ値のメッシュが続くときは、1つの段にまとめる', () => {
    const d = build(mesh(0, 0, 100), mesh(100, 0, 100), mesh(200, 0, 300));
    expect(series(d, L(0, 50, 300, 50)).points).toEqual([
      { d: 0, value: 10000 },
      { d: 200, value: 10000 },
      { d: 200, value: 30000 },
      { d: 300, value: 30000 },
    ]);
  });
  it('メッシュの間の隙間は null で埋める', () => {
    const d = build(mesh(0, 0, 100), mesh(300, 0, 100));
    expect(series(d, L(0, 50, 400, 50)).points).toEqual([
      { d: 0, value: 10000 },
      { d: 100, value: 10000 },
      { d: 100, value: null },
      { d: 300, value: null },
      { d: 300, value: 10000 },
      { d: 400, value: 10000 },
    ]);
  });
  it('メッシュの角をかすめるだけの線は、段を作らない', () => {
    const d = build(mesh(0, 0, 100));
    // x + y = 200 の線は、メッシュの北東の角 (100, 100) だけを通る
    expect(series(d, L(50, 150, 150, 50)).points).toEqual([
      { d: 0, value: null },
      { d: Math.hypot(100, 100), value: null },
    ]);
  });
  it('向きを逆にすると、段の区切りは「長さ − d」で、値は同じ', () => {
    const line = L(-50, 50, 350, 50);
    const f = series(row, line);
    const r = series(row, reverseLine(line));
    expect(r.points).toEqual(
      [...f.points].reverse().map((p) => ({ d: lineLength(line) - p.d, value: p.value })),
    );
  });
  it('斜めの（傾いた）メッシュでも、sample と同じ値になる', () => {
    // 45 度傾いたメッシュと、その隣
    const d = build(
      quad([[200, 0], [300, 100], [200, 200], [100, 100]], 150),
      quad([[300, 100], [400, 200], [300, 300], [200, 200]], 60),
      mesh(0, 0, 80),
    );
    const line = L(-20, 60, 420, 180);
    const s = series(d, line);
    const len = lineLength(line);
    let checked = 0;
    for (let k = 1; k < 200; k++) {
      const dist = (len * k) / 200;
      const v = valueAt(s, dist);
      if (v === undefined) continue; // 段の区切りの近く
      const { x, y } = pointAt(line, dist);
      const sampled = population.sample(d, x, y).find((r) => r.label === '人口密度')?.value ?? null;
      expect(v).toBe(sampled);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });
  it('線の長さが 0、またはメッシュの範囲に届かない線は点なし', () => {
    expect(series(row, L(50, 50, 50, 50)).points).toEqual([]);
    expect(series(row, L(5000, 5000, 6000, 5000)).points).toEqual([]);
  });
  it('範囲の中でもメッシュを通らない線は、全体が null', () => {
    expect(series(row, L(150, 150, 300, 150)).points).toEqual([
      { d: 0, value: null },
      { d: 150, value: null },
    ]);
  });
  it('系列の情報：ラベル、単位、縦軸の範囲、色（地図の配色と同じ）', () => {
    const s = series(row, L(0, 50, 300, 50));
    expect(s).toMatchObject({ label: '人口密度', unit: '人/km²', domain: [0, 40000] });
    expect(s.color(12000)).toEqual(densityColor(12000));
    expect(s.color(0)).toEqual(densityColor(0));
  });
  it('subset の結果では、円の外を null にする（sample と同じ）', () => {
    const sub = population.subset(row, 150, 50, 60);
    const s = series(sub, L(0, 50, 300, 50));
    // 円は x = 90〜210。中心が円の中にあるメッシュは (100,0) だけ（中心 150）。その外は、メッシュがあっても null
    expect(valueAt(s, 95)).toBeNull();
    expect(valueAt(s, 150)).toBe(20000);
    expect(valueAt(s, 205)).toBeNull();
  });
});
