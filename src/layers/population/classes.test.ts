import { describe, expect, it } from 'vitest';
import { DENSITY_CLASSES, ZERO_COLOR, densityClassIndex, densityColor, densityLegend } from './classes';

/** sRGB の相対輝度（WCAG） */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

describe('densityClassIndex', () => {
  it('無居住・不正値は -1', () => {
    for (const d of [0, -1, NaN, Infinity, -Infinity]) expect(densityClassIndex(d)).toBe(-1);
  });
  it('区切りは下限を含み、上限を含まない', () => {
    expect(densityClassIndex(0.5)).toBe(0);
    expect(densityClassIndex(4999)).toBe(0);
    expect(densityClassIndex(5000)).toBe(1);
    expect(densityClassIndex(14999)).toBe(2);
    expect(densityClassIndex(15000)).toBe(3);
    expect(densityClassIndex(24999)).toBe(4);
    expect(densityClassIndex(25000)).toBe(5);
    expect(densityClassIndex(29999)).toBe(5);
    expect(densityClassIndex(30000)).toBe(6);
    expect(densityClassIndex(100000)).toBe(6);
  });
});

describe('DENSITY_CLASSES', () => {
  it('5〜7段で、区切りが隙間なく昇順に並ぶ', () => {
    expect(DENSITY_CLASSES.length).toBeGreaterThanOrEqual(5);
    expect(DENSITY_CLASSES.length).toBeLessThanOrEqual(7);
    DENSITY_CLASSES.forEach((c, i) => {
      if (i > 0) expect(c.min).toBe(DENSITY_CLASSES[i - 1].max);
    });
    expect(DENSITY_CLASSES[DENSITY_CLASSES.length - 1].max).toBeNull();
  });
  it('下限は昇順で、切りのよい数値（1,000の倍数）', () => {
    const mins = DENSITY_CLASSES.map((c) => c.min);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    for (const m of mins) expect(m % 1000).toBe(0);
  });
  it('段が上がるほど明るくなり、無居住はさらに暗い', () => {
    const lums = DENSITY_CLASSES.map((c) => luminance(c.color));
    for (let i = 1; i < lums.length; i++) expect(lums[i]).toBeGreaterThan(lums[i - 1]);
    expect(luminance(ZERO_COLOR)).toBeLessThan(lums[0]);
  });
});

describe('densityColor', () => {
  it('段の色を返す', () => {
    expect(densityColor(0)).toBe(ZERO_COLOR);
    expect(densityColor(NaN)).toBe(ZERO_COLOR);
    expect(densityColor(7500)).toBe(DENSITY_CLASSES[1].color);
    expect(densityColor(35000)).toBe(DENSITY_CLASSES[6].color);
  });
});

describe('densityLegend', () => {
  it('無居住＋各段の色とラベル', () => {
    const l = densityLegend();
    expect(l).toHaveLength(DENSITY_CLASSES.length + 1);
    expect(l[0].color).toBe(ZERO_COLOR);
    expect(l[1].color).toBe(DENSITY_CLASSES[0].color);
    expect(l[l.length - 1].label).toBe('30,000以上 人/km²');
    expect(l[1].label).toBe('〜5,000 人/km²');
    expect(l[3].label).toBe('10,000〜15,000 人/km²');
    expect(new Set(l.map((e) => e.label)).size).toBe(l.length);
  });
});
