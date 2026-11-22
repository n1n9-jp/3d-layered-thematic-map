import { describe, expect, it } from 'vitest';
import type { LayerId } from '../config';
import { useMapStore } from '../store';
import { displayOrder, dropIndex, stepTarget, storeIndexFromDisplay } from './layerOrder';

const ORDER: LayerId[] = ['elevation', 'flood', 'population', 'transit', 'shelters'];

describe('displayOrder', () => {
  it('最上段が先頭になり、元の配列は変えない', () => {
    expect(displayOrder(ORDER)).toEqual(['shelters', 'transit', 'population', 'flood', 'elevation']);
    expect(ORDER[0]).toBe('elevation');
  });
});

describe('storeIndexFromDisplay', () => {
  it('表示の先頭は store の末尾', () => {
    expect(storeIndexFromDisplay(5, 0)).toBe(4);
    expect(storeIndexFromDisplay(5, 4)).toBe(0);
    expect(storeIndexFromDisplay(5, 1)).toBe(3);
  });
});

describe('stepTarget', () => {
  it('上へは store の添字が1増える', () => {
    expect(stepTarget(ORDER, 'flood', -1)).toBe(2);
    expect(stepTarget(ORDER, 'flood', 1)).toBe(0);
  });
  it('端では動けない', () => {
    expect(stepTarget(ORDER, 'shelters', -1)).toBeNull();
    expect(stepTarget(ORDER, 'elevation', 1)).toBeNull();
  });
});

describe('dropIndex', () => {
  const centers = [10, 40, 70, 100];
  it('指より上にある行の数が挿入位置', () => {
    expect(dropIndex(centers, 0)).toBe(0);
    expect(dropIndex(centers, 25)).toBe(1);
    expect(dropIndex(centers, 85)).toBe(3);
    expect(dropIndex(centers, 500)).toBe(4);
  });
});

describe('store との組み合わせ', () => {
  it('ボタン操作：公共交通を1段上へ', () => {
    useMapStore.setState({ order: [...ORDER] });
    const to = stepTarget(useMapStore.getState().order, 'transit', -1);
    expect(to).not.toBeNull();
    useMapStore.getState().moveLayer('transit', to!);
    expect(useMapStore.getState().order).toEqual(['elevation', 'flood', 'population', 'shelters', 'transit']);
  });

  it('ドラッグ：最上段の避難を、表示上の3番目（人口の位置）へ', () => {
    useMapStore.setState({ order: [...ORDER] });
    const shown = displayOrder(useMapStore.getState().order); // shelters, transit, population, flood, elevation
    const rest = shown.filter((x) => x !== 'shelters');
    const t = dropIndex([30, 60, 90, 120], 75); // 人口の中心より下、浸水より上
    expect(t).toBe(2);
    expect(rest.length).toBe(4);
    useMapStore.getState().moveLayer('shelters', storeIndexFromDisplay(5, t));
    expect(displayOrder(useMapStore.getState().order)).toEqual(['transit', 'population', 'shelters', 'flood', 'elevation']);
  });

  it('ドラッグ：最下段の標高を最上段へ', () => {
    useMapStore.setState({ order: [...ORDER] });
    useMapStore.getState().moveLayer('elevation', storeIndexFromDisplay(5, dropIndex([30, 60, 90, 120], -10)));
    expect(displayOrder(useMapStore.getState().order)[0]).toBe('elevation');
  });
});
