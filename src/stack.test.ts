import { describe, expect, it } from 'vitest';
import { LAYER_IDS } from './config';
import type { LayerId } from './config';
import { layerZ, translationMatrix } from './stack';
import type { StackState } from './stack';

function make(over: Partial<StackState> = {}): StackState {
  return {
    order: [...LAYER_IDS],
    visible: { elevation: true, flood: true, population: true, transit: true, shelters: true },
    solo: null,
    spacing: 5000,
    ...over,
  };
}

describe('layerZ', () => {
  it('下から段の番号 × spacing', () => {
    const s = make();
    expect(LAYER_IDS.map((id) => layerZ(s, id))).toEqual([0, 5000, 10000, 15000, 20000]);
  });

  it('order に従う', () => {
    const s = make({ order: ['shelters', 'elevation', 'flood', 'population', 'transit'] });
    expect(layerZ(s, 'shelters')).toBe(0);
    expect(layerZ(s, 'elevation')).toBe(5000);
    expect(layerZ(s, 'transit')).toBe(20000);
  });

  it('非表示のレイヤーは null で、段を詰める', () => {
    const s = make({ visible: { ...make().visible, population: false } });
    expect(layerZ(s, 'population')).toBeNull();
    expect(layerZ(s, 'transit')).toBe(10000);
    expect(layerZ(s, 'shelters')).toBe(15000);
  });

  it('spacing 0 ですべて 0', () => {
    const s = make({ spacing: 0 });
    expect(LAYER_IDS.map((id) => layerZ(s, id))).toEqual([0, 0, 0, 0, 0]);
  });

  it('単独表示は対象が 0、ほかは null', () => {
    const s = make({ solo: 'flood' });
    const got = Object.fromEntries(LAYER_IDS.map((id) => [id, layerZ(s, id)])) as Record<LayerId, number | null>;
    expect(got).toEqual({ elevation: null, flood: 0, population: null, transit: null, shelters: null });
  });

  it('単独表示は visible に関係なく対象を表示する', () => {
    const s = make({ solo: 'flood', visible: { ...make().visible, flood: false } });
    expect(layerZ(s, 'flood')).toBe(0);
  });
});

describe('translationMatrix', () => {
  it('列優先で [0,0,z] への平行移動', () => {
    expect(translationMatrix(1234)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1234, 1]);
  });
});
