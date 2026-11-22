import { describe, expect, it } from 'vitest';
import type { Exposure } from '../aggregate/exposure';
import { overallHeadline } from './overallModel';

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
  it('大きく見せる概数と、正確な値（マウスオーバー用）', () => {
    const h = overallHeadline(e());
    expect(h.severe.people).toEqual({ approx: '約242万人', exact: '2,415,153 人' });
    expect(h.severe.elderly.approx).toBe('約56万人');
  });
});
