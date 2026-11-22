import { describe, expect, it } from 'vitest';
import { floodScheme } from '../layers/flood/classes';
import type { Exposure } from '../aggregate/exposure';
import { exposureTable, shareText } from './exposureModel';

const e = (over: Partial<Exposure> = {}): Exposure => {
  const s = floodScheme('max', 'depth');
  return {
    scenario: 'max',
    classes: [0, 1, 2, 3, 4, 5, 6].map((p) => ({ position: p, label: p === 0 ? '浸水なし' : s.classes[p - 1].label, people: p === 0 ? 5000 : p * 100, elderly: p === 0 ? 1000 : p * 10 })),
    total: { people: 6000, elderly: 1210 },
    flooded: { people: 2100, elderly: 210 },
    severe: { people: 1800, elderly: 180 },
    belowSea: { people: 1234567, elderly: 2 },
    elderlyUnknown: { meshes: 3, people: 12 },
    outside: { meshes: 1, people: 7 },
    ...over,
  };
};

describe('exposureTable', () => {
  it('深い区分から、浸水なしまでの行。人口は桁区切り、割合つき', () => {
    const t = exposureTable(e());
    expect(t.rows.map((r) => r.label)).toEqual(['20m 以上', '10〜20m', '5〜10m', '3〜5m', '0.5〜3m', '0.5m 未満', '浸水なし']);
    expect(t.rows[0].people).toBe('600');
    expect(t.rows.at(-1)?.people).toBe('5,000');
    expect(t.rows.at(-1)?.share).toBe('83.3%');
    expect(t.total.people).toBe('6,000');
    expect(t.scenario).toBe('洪水と高潮の大きいほう');
    expect(t.belowSea?.people).toBe('1,234,567');
    expect(t.headline.flooded).toContain('2,100 人');
    expect(t.headline.severe).toContain('1,800 人');
  });
  it('注記：数え方（メッシュの中心で判定、按分なし）、65歳以上が不明のメッシュ、数えなかったメッシュ', () => {
    const t = exposureTable(e());
    expect(t.notes[0]).toContain('中心');
    expect(t.notes[0]).toContain('按分');
    expect(t.notes.some((n) => n.includes('65歳以上が不明') && n.includes('3 メッシュ') && n.includes('12 人'))).toBe(true);
    expect(t.notes.some((n) => n.includes('23区の外') && n.includes('1 メッシュ'))).toBe(true);
    const clean = exposureTable(e({ elderlyUnknown: { meshes: 0, people: 0 }, outside: { meshes: 0, people: 0 } }));
    expect(clean.notes).toHaveLength(1);
  });
  it('標高がなければ、標高 0m 未満の行は出さない。洪水だけの想定の名前', () => {
    expect(exposureTable(e({ belowSea: null })).belowSea).toBeNull();
    expect(exposureTable(e({ scenario: 'river' })).scenario).toBe('洪水');
  });
  it('shareText', () => {
    expect(shareText(1, 3)).toBe('33.3%');
    expect(shareText(0, 3)).toBe('0.0%');
    expect(shareText(1, 100000)).toBe('0.1% 未満');
    expect(shareText(1, 0)).toBe('—');
  });
});
