import { describe, expect, it } from 'vitest';
import elevation from './elevation';
import type { ElevationLayerData } from './elevation';
import { elevationColor } from './elevation/color';
import { ELEVATION_SECTION_DOMAIN, ELEVATION_SECTION_STEP, sectionElevation } from './elevation/section';
import { reverseLine } from '../lib/section';
import type { SectionLine, SectionSeries } from '../types';

(globalThis as { ImageData?: unknown }).ImageData ??= class {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
};

/**
 * 6×6 セル（50 m）。x は 0〜300、y は 0〜300。セルの値は 10 × 行 + 列（行は北から）。左上（行 0・列 0）は NaN。
 * 行 r・列 c のセルの中心は x = 25 + 50c、y = 275 − 50r。
 */
function makeGrid(): ElevationLayerData {
  const values = new Float32Array(36);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) values[r * 6 + c] = r * 10 + c;
  values[0] = NaN;
  return {
    width: 6,
    height: 6,
    cellSize: 50,
    minX: 0,
    minY: 0,
    maxX: 300,
    maxY: 300,
    min: 1,
    max: 55,
    values,
    image: new ImageData(new Uint8ClampedArray(36 * 4), 6, 6),
  };
}
const grid = makeGrid();
const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });
const series = (line: SectionLine, data = grid): SectionSeries => {
  const tracks = elevation.section(data, line);
  expect(tracks).toHaveLength(1);
  expect(tracks[0].kind).toBe('series');
  return tracks[0] as SectionSeries;
};

describe('elevation.section', () => {
  it('25 m 間隔で、終点まで点を取る。NaN の区間は null', () => {
    // 北から1行目（y = 275）を西から東へ。行 0 の値は [NaN, 1, 2, 3, 4, 5]
    const s = series(L(0, 275, 300, 275));
    expect(s.points.map((p) => p.d)).toEqual(Array.from({ length: 13 }, (_, i) => i * 25));
    expect(s.points.map((p) => p.value)).toEqual([null, null, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, null]);
    // 最後の点は x = 300（格子の東の端）。格子は西と南の縁を含み、東と北の縁を含まないので（sample と同じ）、null
  });
  it('長さが 25 の倍数でないとき、終点にも点を置く', () => {
    const s = series(L(0, 125, 130, 125));
    expect(s.points.map((p) => p.d)).toEqual([0, 25, 50, 75, 100, 125, 130]);
    // y = 125 は行 3（y 100〜150）。値 30 + 列
    expect(s.points.map((p) => p.value)).toEqual([30, 30, 31, 31, 32, 32, 32]);
  });
  it('探針と同じ値を返す（sample と一致）', () => {
    const line = L(10, 20, 290, 270);
    const s = series(line);
    const len = Math.hypot(280, 250);
    for (const p of s.points) {
      const x = line.ax + ((line.bx - line.ax) * p.d) / len;
      const y = line.ay + ((line.by - line.ay) * p.d) / len;
      const v = elevation.sample(grid, x, y)[0].value;
      expect(p.value === null ? null : Math.round(p.value * 10) / 10).toBe(v);
    }
  });
  it('向きを逆にすると、同じ地点の値が d = 長さ − d に並ぶ', () => {
    const line = L(0, 175, 300, 25);
    const len = Math.hypot(300, 150);
    const f = series(line);
    const r = series(reverseLine(line));
    // 25 m 間隔の点は、長さが 25 の倍数でないので、順方向の点の地点で逆向きの線の値を引き直す
    for (const p of f.points) {
      const q = r.points.find((rp) => Math.abs(rp.d - (len - p.d)) < 1e-6);
      if (q) expect(q.value).toBe(p.value);
    }
    // 長さが 25 の倍数の線なら、点がそのまま対応する
    const g = series(L(0, 275, 300, 275));
    const h = series(L(300, 275, 0, 275));
    expect(h.points.map((p) => p.value)).toEqual([...g.points].reverse().map((p) => p.value));
  });
  it('格子の外にはみ出す区間は null。まったく届かない線は点なし', () => {
    const s = series(L(-100, 125, 400, 125));
    expect(s.points[0]).toEqual({ d: 0, value: null });
    expect(s.points[4]).toEqual({ d: 100, value: 30 }); // x = 0
    expect(s.points[s.points.length - 1].value).toBeNull();
    expect(series(L(-500, 125, -100, 125)).points).toEqual([]);
    expect(series(L(0, 500, 300, 500)).points).toEqual([]);
  });
  it('長さ 0 の線は点なし', () => {
    expect(series(L(100, 100, 100, 100)).points).toEqual([]);
  });
  it('系列の情報：ラベル、単位、縦軸の範囲、色（地図の配色と同じ）', () => {
    const s = series(L(0, 275, 300, 275));
    expect(s).toMatchObject({ label: '標高', unit: 'm', domain: [-5, 50] });
    expect(s.domain).toEqual(ELEVATION_SECTION_DOMAIN);
    expect(s.color(10)).toEqual(elevationColor(10).slice(0, 3));
    expect(s.color(-5)).toEqual(elevationColor(-5).slice(0, 3));
    // 線によって domain は変わらない
    expect(series(L(0, 125, 130, 125)).domain).toEqual(s.domain);
    expect(ELEVATION_SECTION_STEP).toBe(25);
  });
  it('subset の結果では、円の外を null にする（sample と同じ）', () => {
    const sub = elevation.subset(grid, 150, 150, 60) as ElevationLayerData;
    const s = sectionElevation(sub, L(0, 150, 300, 150));
    for (const p of s.points) {
      const inside = Math.abs(p.d - 150) <= 60;
      if (!inside) expect(p.value).toBeNull();
    }
    expect(s.points.find((p) => p.d === 150)!.value).not.toBeNull();
  });
});
