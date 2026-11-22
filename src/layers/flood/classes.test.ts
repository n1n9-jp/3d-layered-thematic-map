import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOOD_SCENARIOS, FLOOD_VIEWS } from '../../config';
import {
  DEPTH_CLASSES,
  DURATION_COLORS,
  NONE_COLOR,
  OUTSIDE,
  checkRanksMeta,
  classAt,
  colorOf,
  depthLabel,
  floodScheme,
  labelOf,
  maxDurationCanon,
  riverDurationLabel,
  schemeLegend,
  tideDurationLabel,
} from './classes';
import type { FloodRanksMeta, RGB } from './classes';

/** 相対輝度（WCAG）。 */
function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function hsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

describe('浸水の深さの配色', () => {
  it('国のハザードマップの浸水深の配色と同じ6段', () => {
    expect(DEPTH_CLASSES.map((c) => c.color)).toEqual([
      [247, 245, 169],
      [255, 216, 192],
      [255, 183, 183],
      [255, 145, 145],
      [242, 133, 201],
      [220, 122, 220],
    ]);
    expect(DEPTH_CLASSES.map((c) => c.label)).toEqual(['0.5m 未満', '0.5〜3m', '3〜5m', '5〜10m', '10〜20m', '20m 以上']);
  });

  it('黒の背景の上で、どの段も十分に明るい（浅い段が沈まない）', () => {
    for (const c of DEPTH_CLASSES) {
      const contrast = (luminance(c.color) + 0.05) / 0.05;
      expect(contrast).toBeGreaterThan(7);
    }
    // 浸水なしの色は、背景（黒）より明るく、浅い段より暗い
    expect(luminance(NONE_COLOR)).toBeGreaterThan(0);
    expect(luminance(NONE_COLOR)).toBeLessThan(luminance(DEPTH_CLASSES[0].color) / 4);
  });

  it('想定にかかわらず、同じ深さの段は同じ色', () => {
    for (const sc of FLOOD_SCENARIOS) {
      const s = floodScheme(sc, 'depth');
      expect(s.classes).toBe(DEPTH_CLASSES);
    }
  });
});

describe('浸水継続時間の配色', () => {
  it('深さの色とは別の色相（青緑〜青）で、長いほど飽和度が単調に上がり、黒の背景の上でも読める', () => {
    const sats = DURATION_COLORS.map((c) => hsl(c)[1]);
    for (let i = 1; i < sats.length; i++) expect(sats[i]).toBeGreaterThan(sats[i - 1]);
    for (const c of DURATION_COLORS) {
      const [h] = hsl(c);
      expect(h).toBeGreaterThanOrEqual(160);
      expect(h).toBeLessThanOrEqual(250);
      expect((luminance(c) + 0.05) / 0.05).toBeGreaterThan(2.5);
    }
    // 深さの6色のどれとも、色相が 40 度以上離れている
    for (const d of DEPTH_CLASSES) {
      const hd = hsl(d.color)[0];
      for (const c of DURATION_COLORS) {
        const diff = Math.abs(hsl(c)[0] - hd);
        expect(Math.min(diff, 360 - diff)).toBeGreaterThan(40);
      }
    }
  });

  it('洪水7段・高潮5段・大きいほう9段。同じ時間の段は、想定が違っても同じ色', () => {
    expect(floodScheme('river', 'duration').classes).toHaveLength(7);
    expect(floodScheme('tide', 'duration').classes).toHaveLength(5);
    expect(floodScheme('max', 'duration').classes).toHaveLength(9);
    const river = floodScheme('river', 'duration').classes;
    const tide = floodScheme('tide', 'duration').classes;
    const max = floodScheme('max', 'duration').classes;
    for (let i = 0; i < 4; i++) {
      expect(river[i].color).toEqual(tide[i].color);
      expect(river[i].color).toEqual(max[i].color);
    }
    // 洪水の 4週間以上は、大きいほうの最上段と同じ
    expect(river[6].color).toEqual(max[8].color);
    expect(river[6].label).toBe('4週間以上');
  });

  it('高潮の最上段は「1週間以上」で、上限がないことが、凡例の名前と値の表示で分かる', () => {
    const tide = floodScheme('tide', 'duration');
    const top = tide.classes[4];
    expect(top.open).toBe(true);
    expect(top.max).toBeNull();
    expect(top.label).toContain('1週間以上');
    expect(top.label).toContain('上限なし');
    expect(tideDurationLabel(5)).toBe('1週間以上（上限なし）');
    // 洪水の 5 は「1週間〜2週間」。同じ数字でも意味が違う
    expect(riverDurationLabel(5)).toBe('1週間〜2週間');
    expect(tideDurationLabel(4)).toBe(riverDurationLabel(4));
    const legend = schemeLegend(floodScheme('max', 'duration')).map((l) => l.label);
    expect(legend).toContain('1週間〜2週間');
    expect(legend.some((l) => l.startsWith('1週間以上') && l.includes('高潮'))).toBe(true);
  });
});

describe('大きいほうの段', () => {
  const depth = floodScheme('max', 'depth');
  it('深さ：セルごとに、洪水と高潮の大きいほう。23区の外はどちらかが 255 なら null', () => {
    expect(depth.position(2, 4)).toBe(4);
    expect(depth.position(5, 0)).toBe(5);
    expect(depth.position(0, 0)).toBe(0);
    expect(depth.position(OUTSIDE, 0)).toBeNull();
    expect(depth.position(0, OUTSIDE)).toBeNull();
    expect(floodScheme('river', 'depth').position(3, 6)).toBe(3);
    expect(floodScheme('tide', 'depth').position(3, 6)).toBe(6);
  });

  it('継続時間：高潮の 1週間以上（5）は上限がないので、洪水との大きいほうの意味が変わる', () => {
    // 同じ程度のとき
    expect(maxDurationCanon(0, 0)).toBe(0);
    expect(maxDurationCanon(2, 3)).toBe(3);
    expect(maxDurationCanon(4, 1)).toBe(4);
    // 洪水が 1〜2週間（5）、高潮が 4 以下：洪水の段
    expect(maxDurationCanon(5, 4)).toBe(5);
    // 高潮が 1週間以上（5）：洪水が 1〜2週間以下なら「1週間以上」
    expect(maxDurationCanon(0, 5)).toBe(6);
    expect(maxDurationCanon(3, 5)).toBe(6);
    expect(maxDurationCanon(5, 5)).toBe(6);
    // 洪水が 2〜4週間（6）と重なると「2週間以上」（高潮に上限がないので、2〜4週間とは言えない）
    expect(maxDurationCanon(6, 5)).toBe(8);
    expect(maxDurationCanon(6, 2)).toBe(7);
    // 洪水が 4週間以上（7）なら、どちらでも「4週間以上」
    expect(maxDurationCanon(7, 5)).toBe(9);
    expect(maxDurationCanon(7, 0)).toBe(9);
    const max = floodScheme('max', 'duration');
    expect(labelOf(max, 8)).toBe('2週間以上');
    expect(labelOf(max, 6)).toContain('1週間以上');
    expect(max.position(6, 5)).toBe(8);
    expect(max.position(OUTSIDE, 0)).toBeNull();
  });

  it('位置の単調性：位置が大きいほど、段の下限が小さくならない', () => {
    const max = floodScheme('max', 'duration');
    for (let i = 1; i < max.classes.length; i++) expect(max.classes[i].min).toBeGreaterThanOrEqual(max.classes[i - 1].min);
  });

  it('classAt・colorOf・labelOf：0 は浸水なし', () => {
    expect(classAt(depth, 0)).toBeNull();
    expect(colorOf(depth, 0)).toEqual(NONE_COLOR);
    expect(labelOf(depth, 0)).toBe('浸水なし');
    expect(labelOf(depth, 3)).toBe('3〜5m');
    expect(depthLabel(0)).toBe('浸水なし');
    expect(depthLabel(6)).toBe('20m 以上');
  });

  it('見るものと想定のすべての組に、段・凡例・題がある', () => {
    for (const sc of FLOOD_SCENARIOS)
      for (const v of FLOOD_VIEWS) {
        const s = floodScheme(sc, v);
        expect(s).toBe(floodScheme(sc, v));
        expect(s.classes.length).toBeGreaterThan(0);
        const legend = schemeLegend(s);
        expect(legend).toHaveLength(s.classes.length + 1);
        expect(legend.at(-1)?.label).toContain('浸水なし');
        expect(s.title.length).toBeGreaterThan(0);
      }
  });
});

describe('flood.json との突き合わせ', () => {
  it('実データの flood.json のランクの表と一致する', () => {
    const meta = JSON.parse(readFileSync('public/data/flood.json', 'utf8')) as FloodRanksMeta;
    expect(checkRanksMeta(meta)).toBeNull();
    // 表のラベルも、画面の名前と同じ
    expect(meta.depthRanks.map((r) => r.label.replace(' ', ''))).toEqual(DEPTH_CLASSES.map((c) => c.label.replace(' ', '')));
    expect(meta.tideDurationRanks[4].label).toBe('1週間以上');
  });
  it('食い違いがあれば説明を返す', () => {
    const meta = JSON.parse(readFileSync('public/data/flood.json', 'utf8')) as FloodRanksMeta;
    const bad = { ...meta, depthRanks: meta.depthRanks.map((r, i) => (i === 2 ? { ...r, minM: 4 } : r)) };
    expect(checkRanksMeta(bad)).toContain('depthRanks');
    expect(checkRanksMeta({ ...meta, tideDurationRanks: meta.tideDurationRanks.slice(0, 4) })).toContain('tideDurationRanks');
  });
});
