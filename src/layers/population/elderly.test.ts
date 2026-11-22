import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ELDERLY_CLASSES,
  ELDERLY_UNKNOWN_COLOR,
  ELDERLY_ZERO_COLOR,
  DENSITY_CLASSES,
  elderlyClassIndex,
  elderlyColor,
  elderlyLegend,
} from './classes';

describe('65歳以上の人口密度の配色', () => {
  it('区切りは 1,000 刻み（6,500 が最上段）。境界の値は上の段', () => {
    expect(ELDERLY_CLASSES.map((c) => c.min)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6500]);
    expect(elderlyClassIndex(0)).toBe(-1);
    expect(elderlyClassIndex(0.5)).toBe(0);
    expect(elderlyClassIndex(999)).toBe(0);
    expect(elderlyClassIndex(1000)).toBe(1);
    expect(elderlyClassIndex(6499)).toBe(5);
    expect(elderlyClassIndex(6500)).toBe(6);
    expect(elderlyClassIndex(30000)).toBe(6);
    expect(elderlyClassIndex(Number.NaN)).toBe(-1);
  });
  it('不明（null）は灰色で、0 の色とも、どの段の色とも違う', () => {
    expect(elderlyColor(null)).toEqual(ELDERLY_UNKNOWN_COLOR);
    expect(elderlyColor(0)).toEqual(ELDERLY_ZERO_COLOR);
    const all = [ELDERLY_ZERO_COLOR, ...ELDERLY_CLASSES.map((c) => c.color), ELDERLY_UNKNOWN_COLOR].map((c) => c.join(','));
    expect(new Set(all).size).toBe(all.length);
    // 灰色は無彩色に近い
    const [r, g, b] = ELDERLY_UNKNOWN_COLOR;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(25);
  });
  it('総人口の配色とは別の色（取り違えない）', () => {
    const total = new Set(DENSITY_CLASSES.map((c) => c.color.join(',')));
    for (const c of ELDERLY_CLASSES) expect(total.has(c.color.join(','))).toBe(false);
  });
  it('段が上がるごとに、明るさが単調に増える', () => {
    const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (let i = 1; i < ELDERLY_CLASSES.length; i++) expect(lum(ELDERLY_CLASSES[i].color)).toBeGreaterThan(lum(ELDERLY_CLASSES[i - 1].color));
  });
  it('凡例：0、各段、不明', () => {
    const l = elderlyLegend();
    expect(l).toHaveLength(ELDERLY_CLASSES.length + 2);
    expect(l.at(-1)?.label).toContain('不明');
    expect(l[0].label).toContain('0');
  });
  it('実データの分布：65歳以上が 0 のメッシュを除く各段のメッシュ数が偏らない（最大が最小の 4 倍以内）', () => {
    const pop = JSON.parse(readFileSync('public/data/population.geojson', 'utf8')) as {
      features: { properties: { elderly: number | null }; geometry: { coordinates: number[][][] } }[];
    };
    const counts = new Array(ELDERLY_CLASSES.length).fill(0);
    for (const f of pop.features) {
      if (f.properties.elderly === null) continue;
      const r = f.geometry.coordinates[0];
      const area = Math.abs((r[1][0] - r[0][0]) * (r[2][1] - r[1][1])) / 1e6;
      const i = elderlyClassIndex(f.properties.elderly / area);
      if (i >= 0) counts[i]++;
    }
    expect(Math.min(...counts)).toBeGreaterThan(500);
    expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(4);
  });
});
