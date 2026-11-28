import { describe, expect, it } from 'vitest';
import type { RiverCrossing } from '../types';
import { RIVER_NAME_PX, placeRiverNames } from './riverNames';

const toX = (d: number) => d / 10; // 10 m = 1 px
const c = (d0: number, d1: number, name: string | null, trunk = false): RiverCrossing => ({ d0, d1, name, trunk });

describe('placeRiverNames', () => {
  it('離れた川の名前は、すべて縦線の右に出す', () => {
    const out = placeRiverNames([c(1000, 1100, '荒川', true), c(3000, 3100, '綾瀬川')], toX, 1000);
    expect(out.map((o) => o.name)).toEqual(['荒川', '綾瀬川']);
    expect(out.every((o) => o.anchor === 'start')).toBe(true);
    expect(out[0].x).toBeGreaterThan(toX(1050));
  });
  it('名前のない区間には、名前を出さない', () => {
    expect(placeRiverNames([c(1000, 1100, null)], toX, 1000)).toEqual([]);
  });
  it('込み合うときは、幹となる川を先に置き、重なる名前を出さない', () => {
    // 3 本の川が 20 px（= 200 m）間隔。名前は 2 文字 = 20 px 以上で、隣と重なる。
    const rivers = [c(1000, 1050, '綾瀬川'), c(1200, 1250, '荒川', true), c(1400, 1450, '新中川')];
    const out = placeRiverNames(rivers, toX, 1000);
    expect(out.map((o) => o.name)).toContain('荒川');
    const spans = out.map((o) => [o.x, o.x + o.name.length * RIVER_NAME_PX]);
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) expect(spans[i][1] <= spans[j][0] || spans[j][1] <= spans[i][0]).toBe(true);
    expect(out.length).toBeLessThan(3);
  });
  it('同じ優先度では、川幅の広いほうを先に置く', () => {
    const out = placeRiverNames([c(1000, 1050, '狭い川'), c(1100, 1400, '広い川')], toX, 1000);
    expect(out[0].name).toBe('広い川');
  });
  it('右端に近いときは、縦線の左に置く', () => {
    const out = placeRiverNames([c(9900, 9950, '多摩川')], toX, 100);
    expect(out[0].anchor).toBe('end');
    expect(out[0].x).toBeLessThan(toX(9925));
  });
});
