import { describe, expect, it } from 'vitest';
import elevation from './elevation';
import type { ElevationLayerData } from './elevation';
import { subsetGrid } from '../lib/gridSubset';
import type { LayerRenderContext } from '../types';

// Node には ImageData が無いので、データを持つだけの代用品を置く。
(globalThis as { ImageData?: unknown }).ImageData ??= class {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
};

/**
 * 6×6 セル（50 m）。x は 0〜300、y は 0〜300。セルの値は 10 × 行 + 列（行は北から）。
 * 行 r・列 c のセルの中心は x = 25 + 50c、y = 275 − 50r。(2, 2) のセルの値は 22。
 */
function makeGrid(): ElevationLayerData {
  const values = new Float32Array(36);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) values[r * 6 + c] = r * 10 + c;
  values[0] = NaN; // 左上は NaN（データなし）
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
const full = makeGrid();
const propsOf = (layer: { props: unknown }) => layer.props as unknown as { bounds: number[]; image: unknown };
const at = (g: { values: Float32Array; width: number }, r: number, c: number) => g.values[r * g.width + c];

describe('subsetGrid', () => {
  it('円を囲む正方形のセルを切り出す。セルの中心が円の外なら NaN', () => {
    // 中心はセル (2,2) の中心 (125, 175)。半径 60：隣のセルの中心は 50 で中、角のセルの中心は 70.7 で外
    const g = subsetGrid(full, 125, 175, 60);
    expect([g.width, g.height]).toEqual([3, 3]);
    expect([g.minX, g.maxX, g.minY, g.maxY]).toEqual([50, 200, 100, 250]);
    expect(g.cellSize).toBe(50);
    expect(Array.from(g.values.slice(0, 3))).toEqual([NaN, 12, NaN]);
    expect(Array.from(g.values.slice(3, 6))).toEqual([21, 22, 23]);
    expect(Array.from(g.values.slice(6, 9))).toEqual([NaN, 32, NaN]);
    expect(g.min).toBe(12);
    expect(g.max).toBe(32);
  });

  it('セルの中心がちょうど縁の上なら中（半径 50）', () => {
    const g = subsetGrid(full, 125, 175, 50);
    expect(Array.from(g.values)).toEqual([NaN, 12, NaN, 21, 22, 23, NaN, 32, NaN]);
  });

  it('全体の範囲からはみ出す分は切り詰める', () => {
    const g = subsetGrid(full, 10, 290, 100); // 左上の隅。円は x -90〜110、y 190〜390
    expect([g.minX, g.maxX, g.maxY, g.minY]).toEqual([0, 150, 300, 150]);
    expect([g.width, g.height]).toEqual([3, 3]);
    // (0,0) のセルは NaN（元データがなし）、中心 (25,275) は円の中
    expect(at(g, 0, 0)).toBeNaN();
    expect(at(g, 0, 1)).toBe(1); // 中心 (75, 275)：距離 66 で中
    expect(at(g, 1, 0)).toBe(10);
    // 元データは変えない
    expect(full.values[6]).toBe(10);
    expect(full.width).toBe(6);
  });

  it('円が全体を覆う：全セルが範囲内なら元と同じ（円の外の角は NaN）', () => {
    const g = subsetGrid(full, 150, 150, 1000);
    expect([g.width, g.height, g.minX, g.maxY]).toEqual([6, 6, 0, 300]);
    expect(Array.from(g.values).map((v, i) => (Number.isNaN(v) ? Number.isNaN(full.values[i]) : v === full.values[i])).every(Boolean)).toBe(true);
  });

  it('円が全体と重ならない：1×1 の NaN', () => {
    const g = subsetGrid(full, 5000, 5000, 100);
    expect([g.width, g.height, g.values.length]).toEqual([1, 1, 1]);
    expect(g.values[0]).toBeNaN();
    expect(g.min).toBeNaN();
  });

  it('切り出しを重ねても、座標が元の格子に合う', () => {
    const a = subsetGrid(full, 125, 175, 120);
    const b = subsetGrid(a, 125, 175, 60);
    const direct = subsetGrid(full, 125, 175, 60);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([direct.minX, direct.maxX, direct.minY, direct.maxY]);
    expect(Array.from(b.values)).toEqual(Array.from(direct.values));
  });
});

describe('elevation.subset', () => {
  const sub = elevation.subset(full, 125, 175, 60);

  it('画像は切り出した格子から作り直す（NaN のセルは透明）', () => {
    expect(sub.image.width).toBe(3);
    expect(sub.image.height).toBe(3);
    expect(sub.image.data).toHaveLength(36);
    expect(sub.image.data[3]).toBe(0); // (0,0) は NaN
    expect(sub.image.data[7]).toBe(255); // (0,1) は有効
  });

  it('sample：円の中のセルでは全体と同じ値、円の外では値なし', () => {
    for (const [x, y] of [
      [125, 175],
      [75, 175],
      [175, 175],
      [125, 225],
      [140, 190],
    ] as const)
      expect(elevation.sample(sub, x, y)).toEqual(elevation.sample(full, x, y));
    // 円の外（正方形の中でも外でも）
    expect(elevation.sample(sub, 125, 250)[0].value).toBeNull(); // 円の外、正方形の中
    expect(elevation.sample(sub, 20, 20)[0].value).toBeNull(); // 正方形の外
    expect(elevation.sample(sub, 80, 220)[0].value).toBeNull(); // 中心が円の外にあるセル（NaN）
  });

  it('円の外の地点は、同じセルの中でも値なし', () => {
    // 中心 (125,175)、半径 60：セル (2,3) = 値 23 の中心は (175,175)。x=185 はセルの中だが円の外（距離 60 を超える）
    expect(elevation.sample(sub, 184, 175)[0].value).toBe(23);
    expect(elevation.sample(sub, 186, 175)[0].value).toBeNull();
  });

  it('render：画像を、切り出したデータの範囲に置く', () => {
    const ctx: LayerRenderContext = {
      z: 0,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      opacity: 1,
      solo: false,
      boundary: null,
    };
    const [layer] = elevation.render(sub, ctx);
    expect(propsOf(layer).bounds).toEqual([50, 100, 200, 250]);
    expect(propsOf(layer).image).toBe(sub.image);
    const [whole] = elevation.render(full, ctx);
    expect(propsOf(whole).bounds).toEqual([0, 0, 300, 300]);
  });
});

describe('elevation.summarize', () => {
  it('最小〜最大（小数1桁）と平均', () => {
    const sub = elevation.subset(full, 125, 175, 60); // 有効なセル 12, 21, 22, 23, 32
    expect(elevation.summarize(sub)).toEqual([
      { label: '標高', value: '12.0〜32.0', unit: 'm' },
      { label: '平均', value: 22, unit: 'm' },
    ]);
  });

  it('小数1桁に丸める。-0 は 0 にする', () => {
    const g: ElevationLayerData = {
      ...makeGrid(),
      width: 3,
      height: 1,
      maxX: 150,
      minY: 250,
      values: new Float32Array([2.14, -0.03, 31.449]),
    };
    expect(elevation.summarize(g)).toEqual([
      { label: '標高', value: '0.0〜31.4', unit: 'm' },
      { label: '平均', value: 11.2, unit: 'm' },
    ]);
  });

  it('有効なセルが無ければ値なし', () => {
    const sub = elevation.subset(full, 5000, 5000, 100);
    expect(elevation.summarize(sub)).toEqual([
      { label: '標高', value: null },
      { label: '平均', value: null },
    ]);
  });
});
