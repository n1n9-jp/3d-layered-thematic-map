import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, LAYER_IDS } from './config';
import { initialStateFromQuery, optionsQuery, useMapStore } from './store';

describe('レイヤーの構成', () => {
  it('下から、標高・浸水・人口・公共交通・避難', () => {
    expect([...LAYER_IDS]).toEqual(['elevation', 'flood', 'population', 'transit', 'shelters']);
    expect(initialStateFromQuery('').order).toEqual([...LAYER_IDS]);
  });
});

describe('切り替えの URL クエリ', () => {
  it('既定は、大きいほう・深さ・総人口', () => {
    expect(optionsQuery('')).toEqual({ floodScenario: 'max', floodView: 'depth', populationView: 'total' });
    expect(DEFAULT_OPTIONS).toEqual(optionsQuery(''));
  });
  it('flood, floodview, pop で指定できる', () => {
    expect(optionsQuery('?flood=tide&floodview=duration&pop=elderly')).toEqual({ floodScenario: 'tide', floodView: 'duration', populationView: 'elderly' });
    expect(optionsQuery('?flood=river')).toEqual({ ...DEFAULT_OPTIONS, floodScenario: 'river' });
  });
  it('合わない値は既定に戻す', () => {
    expect(optionsQuery('?flood=both&floodview=&pop=old')).toEqual(DEFAULT_OPTIONS);
    expect(initialStateFromQuery('?flood=tide').options.floodScenario).toBe('tide');
  });
  it('setOption：同じ値なら状態を作り直さない。変えると新しい options', () => {
    const before = useMapStore.getState().options;
    useMapStore.getState().setOption('floodScenario', before.floodScenario);
    expect(useMapStore.getState().options).toBe(before);
    useMapStore.getState().setOption('populationView', 'elderly');
    expect(useMapStore.getState().options).toEqual({ ...before, populationView: 'elderly' });
    useMapStore.getState().setOption('populationView', before.populationView);
  });
});
