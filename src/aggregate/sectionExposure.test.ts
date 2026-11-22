import { describe, expect, it } from 'vitest';
import { OUTSIDE } from '../layers/flood/classes';
import type { FloodData } from '../layers/flood/model';
import type { ShelterData } from '../layers/shelters/model';
import { SEVERE_SHELTER_RADIUS, sectionFloodSummary, spansAtLeast } from './sectionExposure';

/** 西から東へ 8 セル（50 m）：深さのランク 0, 0, 3, 3, 4, 1, 0, 6（洪水）。 */
function flood(river: number[], tide: number[] = new Array(river.length).fill(0)): FloodData {
  const n = river.length;
  return {
    width: n,
    height: 1,
    cellSize: 50,
    minX: 0,
    minY: 0,
    maxX: 50 * n,
    maxY: 50,
    riverDepth: Uint8Array.from(river),
    tideDepth: Uint8Array.from(tide),
    riverDuration: new Uint8Array(n),
    tideDuration: new Uint8Array(n),
  };
}
const shelters = (pts: [number, number][]) => ({ points: { usable: pts, other: [[100, 20]], hospital: [] } }) as unknown as ShelterData;

describe('spansAtLeast', () => {
  it('階段状の系列から、しきい値以上の区間を、つながるものは1つにして返す', () => {
    const pts = [
      { d: 0, value: 1 }, { d: 10, value: 1 },
      { d: 10, value: 3 }, { d: 20, value: 3 },
      { d: 20, value: 5 }, { d: 30, value: 5 },
      { d: 30, value: null }, { d: 40, value: null },
      { d: 40, value: 4 }, { d: 50, value: 4 },
    ];
    expect(spansAtLeast(pts, 3)).toEqual([[10, 30], [40, 50]]);
    expect(spansAtLeast(pts, 6)).toEqual([]);
  });
});

describe('sectionFloodSummary：浸水 3m 以上の区間の長さと、そこから 1 km 以内の、洪水・高潮用の避難場所', () => {
  const f = flood([0, 0, 3, 3, 4, 1, 0, 6]);
  const line = { ax: 1, ay: 25, bx: 399, by: 25 }; // 8 セルを西から東へ
  it('3m 以上のランク（3〜6）のセルが続く区間の長さ（セルの境目まで、1 m 以内の精度）', () => {
    const s = sectionFloodSummary(f, shelters([]), line, 'river');
    expect(s.length).toBeCloseTo(398, 6);
    // 3, 3, 4 の 3 セル = 150 m（x = 100〜250 → d = 99〜249）と、最後の 6 の 1 セル（x = 350〜 → d = 349〜398 は 49 m）
    expect(s.spans).toHaveLength(2);
    expect(s.severeLength).toBeGreaterThan(150 + 48 - 2);
    expect(s.severeLength).toBeLessThan(150 + 49 + 2);
    expect(s.radius).toBe(SEVERE_SHELTER_RADIUS);
  });
  it('避難場所の数：区間から 1 km 以内の、洪水・高潮用だけ（それ以外の避難場所は数えない）', () => {
    const s = sectionFloodSummary(f, shelters([[150, 800], [150, 1100], [5000, 5000]]), line, 'river');
    expect(s.shelters).toBe(1); // (150, 800) は 775 m、(150, 1100) は 1075 m（1 km 超）、遠い点は対象外
  });
  it('想定に従う：高潮だけなら浸水なし、大きいほうなら高潮の深い所も入る', () => {
    expect(sectionFloodSummary(f, shelters([]), line, 'tide').severeLength).toBe(0);
    const g = flood([0, 0, 3, 3, 4, 1, 0, 6], [5, 5, 0, 0, 0, 0, 0, 0]);
    expect(sectionFloodSummary(g, shelters([]), line, 'max').severeLength).toBeGreaterThan(sectionFloodSummary(f, shelters([]), line, 'max').severeLength);
  });
  it('23区の外（255）は、区間に入らない。区間がなければ避難場所は 0', () => {
    const g = flood([OUTSIDE, OUTSIDE, 3, 3, 0, 0, 0, 0]);
    const s = sectionFloodSummary(g, shelters([[150, 100]]), line, 'river');
    expect(s.severeLength).toBeGreaterThan(98);
    expect(s.severeLength).toBeLessThan(101);
    const none = sectionFloodSummary(flood([0, 0, 0, 0]), shelters([[0, 0]]), { ax: 1, ay: 25, bx: 199, by: 25 }, 'river');
    expect(none.severeLength).toBe(0);
    expect(none.shelters).toBe(0);
    expect(none.spans).toEqual([]);
  });
});
