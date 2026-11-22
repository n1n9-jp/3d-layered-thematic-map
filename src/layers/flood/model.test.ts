import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../../config';
import type { LayerOptions } from '../../config';
import { OUTSIDE, floodScheme } from './classes';
import { buildFloodData, cellIndexAt, classShares, floodPixels, percentText, sampleFlood, sectionFlood, subsetFlood, summarizeFlood } from './model';
import type { FloodData, FloodMeta } from './model';

/** 4×4 セル（50 m）の小さな格子。x は -100〜100、y は -100〜100。行は北から南。 */
function grid(parts: Partial<Record<'riverDepth' | 'tideDepth' | 'riverDuration' | 'tideDuration', number[]>> = {}): FloodData {
  const n = 16;
  const fill = (v: number) => new Uint8Array(n).fill(v);
  return {
    width: 4,
    height: 4,
    cellSize: 50,
    minX: -100,
    minY: -100,
    maxX: 100,
    maxY: 100,
    riverDepth: parts.riverDepth ? Uint8Array.from(parts.riverDepth) : fill(0),
    tideDepth: parts.tideDepth ? Uint8Array.from(parts.tideDepth) : fill(0),
    riverDuration: parts.riverDuration ? Uint8Array.from(parts.riverDuration) : fill(0),
    tideDuration: parts.tideDuration ? Uint8Array.from(parts.tideDuration) : fill(0),
  };
}
const opts = (o: Partial<LayerOptions>): LayerOptions => ({ ...DEFAULT_OPTIONS, ...o });

describe('sampleFlood：切り替えにかかわらず、4つの値をランクの名前で返す', () => {
  const d = grid({
    riverDepth: [3, 0, 0, 0, ...new Array(12).fill(0)],
    tideDepth: [3, 0, 0, 0, ...new Array(12).fill(0)],
    riverDuration: [4, ...new Array(15).fill(0)],
    tideDuration: [5, ...new Array(15).fill(0)],
  });
  it('左上のセル（x -100〜-50、y 50〜100）', () => {
    const v = sampleFlood(d, -75, 75);
    expect(v.map((x) => x.label)).toEqual(['洪水の深さ', '高潮の深さ', '洪水の継続', '高潮の継続']);
    expect(v.map((x) => x.value)).toEqual(['3〜5m', '3〜5m', '3日〜1週間', '1週間以上（上限なし）']);
  });
  it('浸水なしのセルは「浸水なし」。格子の外は値なし', () => {
    expect(sampleFlood(d, 75, -75).map((x) => x.value)).toEqual(['浸水なし', '浸水なし', 'なし', 'なし']);
    expect(sampleFlood(d, 500, 0).map((x) => x.value)).toEqual([null, null, null, null]);
  });
  it('255（23区の外）は値なし。深さ 0.5m 未満のセルの継続時間は、値がない理由を添える', () => {
    const o = grid({ riverDepth: [OUTSIDE, 1], tideDepth: [OUTSIDE, 1], riverDuration: [OUTSIDE, 0], tideDuration: [OUTSIDE, 0] });
    expect(sampleFlood(o, -75, 75).map((x) => x.value)).toEqual([null, null, null, null]);
    expect(sampleFlood(o, -25, 75).map((x) => x.value)).toEqual(['0.5m 未満', '0.5m 未満', 'なし（浸水が 0.5m 未満）', 'なし（浸水が 0.5m 未満）']);
  });
});

describe('cellIndexAt と切り出し', () => {
  it('地点を含むセルの添字（行は北から南）', () => {
    const d = grid();
    expect(cellIndexAt(d, -75, 75)).toBe(0);
    expect(cellIndexAt(d, 75, -75)).toBe(15);
    expect(cellIndexAt(d, 101, 0)).toBeNull();
  });
  it('円の外のセルは 255、中のセルは元の値。円の外の sample は値なし', () => {
    const d = grid({ riverDepth: new Array(16).fill(2), tideDepth: new Array(16).fill(4) });
    const s = subsetFlood(d, 0, 0, 60);
    expect(s.clip).toEqual({ cx: 0, cy: 0, r: 60 });
    // 中央の 2×2 のセル（中心 (±25, ±25)、原点から約 35 m）は円の中、四隅のセル（中心 (±75, ±75)）は外
    let inside = 0;
    for (let i = 0; i < s.width * s.height; i++) if (s.riverDepth[i] !== OUTSIDE) inside++;
    expect(inside).toBeGreaterThanOrEqual(4);
    expect(sampleFlood(s, 10, 10)[0].value).toBe('0.5〜3m');
    expect(sampleFlood(s, 90, 90)[0].value).toBeNull();
  });
  it('円が格子と重ならないときも、幅・高さは 0 にならない', () => {
    const s = subsetFlood(grid(), 5000, 5000, 100);
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
    expect(s.riverDepth.every((v) => v === OUTSIDE)).toBe(true);
  });
});

describe('画像と集計', () => {
  it('23区の外（255）は透明、浸水なしは暗い色、深さの段はその色', () => {
    const d = grid({ riverDepth: [OUTSIDE, 0, 1, 6], tideDepth: [OUTSIDE, 0, 0, 0] });
    const px = floodPixels(d, floodScheme('river', 'depth'));
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(255);
    expect([...px.slice(8, 11)]).toEqual([247, 245, 169]);
    expect([...px.slice(12, 15)]).toEqual([220, 122, 220]);
    // 高潮の想定では、同じセルは浸水なし
    const tide = floodPixels(d, floodScheme('tide', 'depth'));
    expect([...tide.slice(8, 11)]).not.toEqual([247, 245, 169]);
  });
  it('大きいほうの画像は、セルごとの大きいほう', () => {
    const d = grid({ riverDepth: [1, 4, 0, 0], tideDepth: [3, 2, 0, 5] });
    const s = floodScheme('max', 'depth');
    const px = floodPixels(d, s);
    expect([...px.slice(0, 3)]).toEqual([255, 183, 183]); // 3 > 1
    expect([...px.slice(4, 7)]).toEqual([255, 145, 145]); // 4 > 2
    expect([...px.slice(12, 15)]).toEqual([242, 133, 201]); // 5
  });
  it('段ごとの面積の割合：23区内のセルだけを数える', () => {
    const d = grid({ riverDepth: [OUTSIDE, OUTSIDE, 0, 0, 2, 2, 2, 2, ...new Array(8).fill(0)], tideDepth: new Array(16).fill(0) });
    const { total, shares } = classShares(d, floodScheme('river', 'depth'));
    expect(total).toBe(14);
    expect(shares.find((s) => s.position === 2)?.cells).toBe(4);
    expect(shares.find((s) => s.position === 2)?.percent).toBeCloseTo((100 * 4) / 14, 6);
    expect(shares.reduce((a, s) => a + s.percent, 0)).toBeCloseTo(100, 6);
  });
  it('summarize：深い段を先に、割合が 0 の段は出さない。切り替え（見るもの）に従う', () => {
    const d = grid({ riverDepth: [4, 4, 2, 0, ...new Array(12).fill(0)], tideDepth: new Array(16).fill(0), riverDuration: [3, 3, 3, 0, ...new Array(12).fill(0)] });
    const depth = summarizeFlood(d, opts({ floodScenario: 'river', floodView: 'depth' }));
    expect(depth.map((v) => v.label)).toEqual(['5〜10m', '0.5〜3m', '浸水なし']);
    expect(depth[0].value).toBe(percentText((100 * 2) / 16));
    const dur = summarizeFlood(d, opts({ floodScenario: 'river', floodView: 'duration' }));
    expect(dur.map((v) => v.label)).toEqual(['1日〜3日', '浸水なし（0.5m 未満を含む）']);
  });
  it('percentText：小数1桁。0 でなければ 0.1% 未満と書く', () => {
    expect(percentText(12.34)).toBe('12.3%');
    expect(percentText(0)).toBe('0.0%');
    expect(percentText(0.01)).toBe('0.1% 未満');
  });
  it('円の中が23区の外だけのとき、集計は値なし', () => {
    const s = subsetFlood(grid(), 5000, 5000, 100);
    expect(summarizeFlood(s, DEFAULT_OPTIONS)[0].value).toBeNull();
  });
});

describe('sectionFlood：段の階段', () => {
  // 西から東へ、2 セルずつ：なし、2、4、23区の外（x = -100〜100、y = 75 の行）
  const d = grid({ riverDepth: [0, 0, 2, 2, ...new Array(12).fill(0)], tideDepth: [0, 0, 0, 5, ...new Array(12).fill(0)] });
  const line = { ax: -99, ay: 75, bx: 99, by: 75 };
  it('値は段の位置。同じ段は1つにまとまり、線の端から端まで隙間なく続く', () => {
    const s = sectionFlood(d, line, opts({ floodScenario: 'max', floodView: 'depth' }));
    expect(s.label).toBe('浸水の深さ');
    expect(s.domain).toEqual([0, 6]);
    const pts = s.points;
    expect(pts[0].d).toBe(0);
    expect(pts.at(-1)?.d).toBe(198);
    for (let i = 0; i + 1 < pts.length; i += 2) {
      expect(pts[i].value).toBe(pts[i + 1].value); // 段の両端は同じ値
      if (i + 2 < pts.length) expect(pts[i + 1].d).toBe(pts[i + 2].d); // 次の段へ、隙間なく
    }
    const stairs = pts.filter((_, i) => i % 2 === 0).map((p) => p.value);
    expect(stairs).toEqual([0, 2, 5]); // なし → 0.5〜3m → 10〜20m（高潮の 5 が大きい）
    // 段の境目は、セルの境（x = 0, 50 は d = 99, 149）に、1 m 以内で合う（標本は 25 m ごとだが、境目は二分法で詰める）
    expect(Math.abs(pts[1].d - 99)).toBeLessThan(1);
    expect(Math.abs(pts[3].d - 149)).toBeLessThan(1);
  });
  it('想定が違えば、段が違う（洪水だけ・高潮だけ）', () => {
    const river = sectionFlood(d, line, opts({ floodScenario: 'river' }));
    expect(river.points.filter((_, i) => i % 2 === 0).map((p) => p.value)).toEqual([0, 2]);
    const tide = sectionFlood(d, line, opts({ floodScenario: 'tide' }));
    expect(tide.points.filter((_, i) => i % 2 === 0).map((p) => p.value)).toEqual([0, 5]);
  });
  it('縦軸は段のラベル（ranks）で読む。色は段の色', () => {
    const s = sectionFlood(d, line, DEFAULT_OPTIONS);
    expect(s.ranks?.map((r) => r.label)).toEqual(['0.5m 未満', '0.5〜3m', '3〜5m', '5〜10m', '10〜20m', '20m 以上']);
    expect(s.color(2)).toEqual([255, 216, 192]);
    const dur = sectionFlood(d, line, opts({ floodView: 'duration' }));
    expect(dur.label).toBe('浸水の継続');
    expect(dur.ranks).toHaveLength(9);
  });
  it('23区の外は null、格子に届かない線・長さ 0 の線は点がない', () => {
    const o = grid({ riverDepth: [OUTSIDE, OUTSIDE, 1, 1, ...new Array(12).fill(0)], tideDepth: [OUTSIDE, OUTSIDE, 0, 0, ...new Array(12).fill(0)] });
    const s = sectionFlood(o, line, DEFAULT_OPTIONS);
    expect(s.points[0].value).toBeNull();
    expect(sectionFlood(d, { ax: 5000, ay: 5000, bx: 6000, by: 5000 }, DEFAULT_OPTIONS).points).toEqual([]);
    expect(sectionFlood(d, { ax: 0, ay: 0, bx: 0, by: 0 }, DEFAULT_OPTIONS).points).toEqual([]);
  });
});

describe('buildFloodData', () => {
  const meta = {
    width: 2,
    height: 2,
    cellSize: 50,
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 100,
    depthRanks: [],
    durationRanks: [],
    tideDurationRanks: [],
    files: { riverDepth: 'a', tideDepth: 'b', riverDuration: 'c', tideDuration: 'd' },
  } as unknown as FloodMeta;
  it('ランクの表が画面の定義と合わなければ、例外', () => {
    const b = new ArrayBuffer(4);
    expect(() => buildFloodData(meta, { riverDepth: b, tideDepth: b, riverDuration: b, tideDuration: b })).toThrow(/ランク/);
  });
});
