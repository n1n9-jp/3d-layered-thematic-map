import { describe, expect, it } from 'vitest';
import { RIVER_COLOR } from '../rivers';
import { LEGEND_STOPS, elevationColor, elevationPixels } from './color';

const hue = ([r, g, b]: number[]) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};
const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('elevationColor', () => {
  it('NaN は完全に透明', () => {
    expect(elevationColor(NaN)[3]).toBe(0);
  });
  it('有効値は不透明', () => {
    for (const v of [-10, -5, -0.1, 0, 12, 50, 80]) expect(elevationColor(v)[3]).toBe(255);
  });
  it('負の値は紫系で、0m 以上とは色相が大きく違う', () => {
    const neg = elevationColor(-2);
    const zero = elevationColor(0);
    // 紫：赤と青が緑より大きい
    expect(neg[0]).toBeGreaterThan(neg[1]);
    expect(neg[2]).toBeGreaterThan(neg[1]);
    const dh = Math.abs(hue(neg) - hue(zero));
    expect(Math.min(dh, 360 - dh)).toBeGreaterThan(60);
  });
  it('負の値のどの色も、川の水色と色相が 50 度以上離れている（水面に見えない）', () => {
    const river = hue([...RIVER_COLOR]);
    for (const v of [-5, -4, -3, -2, -1, -0.1]) {
      const dh = Math.abs(hue(elevationColor(v)) - river);
      expect(Math.min(dh, 360 - dh)).toBeGreaterThanOrEqual(50);
    }
  });
  it('0m 以上は連続的で、明るさが単調に増える', () => {
    let prev = luma(elevationColor(0));
    let prevC = elevationColor(0);
    for (let v = 0.5; v <= 50; v += 0.5) {
      const c = elevationColor(v);
      expect(luma(c)).toBeGreaterThanOrEqual(prev);
      for (let k = 0; k < 3; k++) expect(Math.abs(c[k] - prevC[k])).toBeLessThan(20);
      prev = luma(c);
      prevC = c;
    }
  });
  it('0m でも黒背景に沈まない明るさ', () => {
    expect(luma(elevationColor(0))).toBeGreaterThan(80);
    expect(luma(elevationColor(-5))).toBeGreaterThan(60);
  });
  it('固定の区切りで両端に丸める', () => {
    expect(elevationColor(-50)).toEqual(elevationColor(-5));
    expect(elevationColor(200)).toEqual(elevationColor(50));
    expect(elevationColor(-0.0001)).not.toEqual(elevationColor(0));
  });
  it('既知の区切りの色', () => {
    expect(elevationColor(0)).toEqual([52, 120, 72, 255]);
    expect(elevationColor(20)).toEqual([220, 208, 104, 255]);
    expect(elevationColor(-5)).toEqual([112, 44, 170, 255]);
  });
  it('凡例は 5〜6 段で値が昇順', () => {
    expect(LEGEND_STOPS.length).toBeGreaterThanOrEqual(5);
    expect(LEGEND_STOPS.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < LEGEND_STOPS.length; i++)
      expect(LEGEND_STOPS[i].value).toBeGreaterThan(LEGEND_STOPS[i - 1].value);
  });
});

describe('elevationPixels', () => {
  it('RGBA を値の順に並べ、NaN は透明', () => {
    const px = elevationPixels(new Float32Array([0, NaN, -5]));
    expect(Array.from(px)).toEqual([52, 120, 72, 255, 0, 0, 0, 0, 112, 44, 170, 255]);
  });
});
