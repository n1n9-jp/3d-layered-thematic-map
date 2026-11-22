import { describe, expect, it } from 'vitest';
import type { Exposure } from '../aggregate/exposure';
import { scenarioNote } from './exposureModel';
import { namesText, overallHeadline, wardSharesText } from './overallModel';

const e = (over: Partial<Exposure> = {}): Exposure => ({
  scenario: 'max',
  classes: [],
  total: { people: 9712741, elderly: 2023643 },
  flooded: { people: 5553930, elderly: 1200902 },
  severe: { people: 2415153, elderly: 559789 },
  belowSea: { people: 962288, elderly: 221817 },
  elderlyUnknown: { meshes: 0, people: 0 },
  outside: { meshes: 0, people: 0 },
  ...over,
});

describe('overallHeadline', () => {
  it('大きく見せる概数と、正確な値（表・マウスオーバー用）', () => {
    const h = overallHeadline(e());
    expect(h.severe.people).toEqual({ approx: '約242万人', exact: '2,415,153 人' });
    expect(h.severe.elderly.approx).toBe('約56万人');
    expect(h.flooded.approx).toBe('約555万人');
    expect(h.belowSea?.approx).toBe('約96万人');
  });
  it('標高が読めていなければ、標高 0m 未満は null', () => {
    expect(overallHeadline(e({ belowSea: null })).belowSea).toBeNull();
  });
});

describe('wardSharesText / namesText', () => {
  it('区と、深さ 3m 以上の区域に住む人の割合', () => {
    const w = (name: string, severeShare: number | null) => ({ name, total: 1, severeShare, floodedShare: severeShare });
    expect(wardSharesText([w('江戸川区', 0.754), w('足立区', 0.603)])).toBe('江戸川区 75%・足立区 60%');
    expect(wardSharesText([w('新宿区', 0.007)])).toBe('新宿区 0.7%');
    expect(wardSharesText([w('葛飾区', 0.773), w('墨田区', 0.745), w('江東区', 0.626)])).toBe('葛飾区 77%・墨田区 75%・江東区 63%');
    expect(wardSharesText([w('X区', null)])).toBe('X区');
    expect(namesText([])).toBe('なし');
    expect(namesText(['墨田区', '江東区'])).toBe('墨田区・江東区');
  });
});

describe('scenarioNote：想定の切り替えと数字の対応', () => {
  it('「大きいほう」は、洪水と高潮の足し合わせではないと書く', () => {
    const n = scenarioNote('max');
    expect(n).toContain('足し合わせたものではなく');
    expect(n).toContain('深いほう');
    expect(scenarioNote('river')).toContain('洪水だけ');
    expect(scenarioNote('tide')).toContain('高潮だけ');
  });
});
