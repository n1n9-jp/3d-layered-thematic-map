import { describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import type { LayerRenderContext } from '../types';
import elevation from './elevation';
import facilities from './facilities';
import { buildFacilityData } from './facilitiesModel';
import population, { buildPopulationData } from './population';
import roads from './roads';
import { buildRoadData } from './roadsModel';
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
    const cases = [
      [elevation, grid],
      [population, buildPopulationData(empty() as never)],
      [roads, buildRoadData(empty() as never)],
      [transit, buildTransitData(empty() as never, empty() as never)],
      [facilities, buildFacilityData(empty() as never)],
    ] as const;
    expect(cases.map(([m]) => m.id)).toEqual([...LAYER_IDS]);
    for (const [m, d] of cases) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = m as any;
      const far = mod.subset(d, 90000, 90000, 1000);
      // 円の中心でも外でも、落ちずに答える。円の外は、どのレイヤーも値なし
      mod.sample(far, 90000, 90000);
      expect(mod.sample(far, 50, 50).every((v: { value: unknown }) => v.value === null)).toBe(true);
      expect(mod.summarize(far)).toHaveLength(2);
      expect(mod.render(far, ctx).length).toBeGreaterThan(0);
      // 半径 0 でも落ちない
      mod.summarize(mod.subset(d, 50, 50, 0));
    }
  });

  it('registry の全レイヤーが subset と summarize を持つ', () => {
    for (const id of LAYER_IDS) {
      expect(typeof registry[id].subset).toBe('function');
      expect(typeof registry[id].summarize).toBe('function');
    }
  });
});
