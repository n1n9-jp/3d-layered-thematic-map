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
    expect(densityClassIndex(999)).toBe(0);
    expect(densityClassIndex(1000)).toBe(1);
    expect(densityClassIndex(2999)).toBe(1);
    expect(densityClassIndex(3000)).toBe(2);
    expect(densityClassIndex(19999)).toBe(5);
    expect(densityClassIndex(20000)).toBe(6);
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
  it('低い側ほど段の幅が狭い', () => {
    const widths = DENSITY_CLASSES.slice(0, -1).map((c) => (c.max as number) - c.min);
    expect(widths.slice(0, 4)).toEqual([...widths.slice(0, 4)].sort((a, b) => a - b));
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
    expect(densityColor(1500)).toBe(DENSITY_CLASSES[1].color);
    expect(densityColor(30000)).toBe(DENSITY_CLASSES[6].color);
  });
});

describe('densityLegend', () => {
  it('無居住＋各段の色とラベル', () => {
    const l = densityLegend();
    expect(l).toHaveLength(DENSITY_CLASSES.length + 1);
    expect(l[0].color).toBe(ZERO_COLOR);
    expect(l[1].color).toBe(DENSITY_CLASSES[0].color);
    expect(l[l.length - 1].label).toBe('20,000以上 人/km²');
    expect(l[3].label).toBe('3,000〜6,000 人/km²');
    expect(new Set(l.map((e) => e.label)).size).toBe(l.length);
  });
});
