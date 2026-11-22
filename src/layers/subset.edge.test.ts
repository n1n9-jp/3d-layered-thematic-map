import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, LAYER_IDS } from '../config';
import type { LayerRenderContext } from '../types';
import elevation from './elevation';
import flood from './flood';
import type { FloodData } from './flood';
import population, { buildPopulationData } from './population';
import shelters from './shelters';
import { buildShelterData } from './shelters/model';
import transit from './transit';
import { buildTransitData } from './transitModel';
import { registry } from './index';

(globalThis as { ImageData?: unknown }).ImageData ??= class {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
};

const ctx: LayerRenderContext = {
  z: 0,
  modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  opacity: 1,
  solo: false,
  boundary: null,
  options: DEFAULT_OPTIONS,
};

const empty = <G>() => ({ type: 'FeatureCollection' as const, features: [] as { type: 'Feature'; geometry: G; properties: never }[] });

describe('空のデータ・円が重ならない切り出し', () => {
  it('どのレイヤーも subset の結果に対して sample / summarize / render が動く', () => {
    const grid = {
      width: 2,
      height: 2,
      cellSize: 50,
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
      min: 1,
      max: 4,
      values: new Float32Array([1, 2, 3, 4]),
      image: new ImageData(new Uint8ClampedArray(16), 2, 2),
    };
    // 浸水の格子：2×2 セル（50 m）。0 = 浸水なし、1 = 最も浅い段。
    const cellsOf = (...v: number[]) => new Uint8Array(v);
    const floodGrid: FloodData = {
      width: 2,
      height: 2,
      cellSize: 50,
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
      riverDepth: cellsOf(0, 1, 1, 0),
      tideDepth: cellsOf(0, 0, 1, 0),
      riverDuration: cellsOf(0, 1, 1, 0),
      tideDuration: cellsOf(0, 0, 1, 0),
    };
    const shelterData = buildShelterData(empty() as never, { updated: '', total: 0, wards: [] }, empty() as never, empty() as never);
    // 3つ目は、円の外の切り出しの集計が返す項目の数（標高：標高・平均、人口：人口・65歳以上・人口密度、浸水：値なしの1行、
    // 公共交通：駅・路線、避難：避難場所2種と病院）。
    const cases = [
      [elevation, grid, 2],
      [flood, floodGrid, 1],
      [population, buildPopulationData(empty() as never), 3],
      [transit, buildTransitData(empty() as never, empty() as never), 2],
      [shelters, shelterData, 3],
    ] as const;
    expect(cases.map(([m]) => m.id)).toEqual([...LAYER_IDS]);
    for (const [m, d, summaryLength] of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = m as any;
      const far = mod.subset(d, 90000, 90000, 1000);
      // 円の中心でも外でも、落ちずに答える。円の外は、どのレイヤーも値なし
      mod.sample(far, 90000, 90000);
      expect(mod.sample(far, 50, 50).every((v: { value: unknown }) => v.value === null)).toBe(true);
      expect(mod.summarize(far, DEFAULT_OPTIONS)).toHaveLength(summaryLength);
      expect(mod.render(far, ctx).length).toBeGreaterThan(0);
      // 半径 0 でも落ちない
      mod.summarize(mod.subset(d, 50, 50, 0), DEFAULT_OPTIONS);
    }
  });

  it('registry の全レイヤーが subset と summarize を持つ', () => {
    for (const id of LAYER_IDS) {
      expect(typeof registry[id].subset).toBe('function');
      expect(typeof registry[id].summarize).toBe('function');
    }
  });
});
