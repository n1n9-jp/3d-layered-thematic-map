import { describe, expect, it } from 'vitest';
import type { LayerId } from '../config';
import {
  GAP,
  HYSTERESIS,
  MAX_FRAME_H,
  MIN_FRAME_H,
  STACKED_FRAME_H,
  SUMMARY_H,
  minPitch,
  placeCharts,
  placeInOrder,
  stackedFrameH,
  stackedPlacement,
} from './alignment';
import type { Tier } from './alignment';

const IDS: LayerId[] = ['shelters', 'transit', 'population', 'flood', 'elevation'];
/** 上の段から、先頭の高さ y0、間隔 pitch で並ぶ段。 */
const tiers = (y0: number, pitch: number, ids: LayerId[] = IDS): Tier[] => ids.map((id, i) => ({ id, y: y0 + i * pitch, goalY: y0 + i * pitch }));
const REGION = { top: 2, bottom: 1000 };

describe('placeInOrder（順番を保ち、隣と離し、範囲に収める）', () => {
  it('すでに条件を満たしていれば、そのまま', () => {
    expect(placeInOrder([100, 300, 500], 50, 0, 1000)).toEqual([100, 300, 500]);
  });
  it('近すぎる2つは、中心を保って gap だけ離れる', () => {
    const r = placeInOrder([200, 210], 60, 0, 1000);
    expect(r[1] - r[0]).toBeCloseTo(60);
    expect((r[0] + r[1]) / 2).toBeCloseTo(205);
  });
  it('同じ位置に重なる3つも、順番どおり gap ずつ離れる', () => {
    const r = placeInOrder([300, 300, 300], 40, 0, 1000);
    expect(r).toEqual([260, 300, 340]);
  });
  it('上端の外にはみ出すものは、範囲の中へ寄せる（隣との間隔は保つ）', () => {
    const r = placeInOrder([-50, 100, 400], 80, 20, 1000);
    expect(r[0]).toBe(20);
    expect(r[1]).toBe(100);
    expect(r[2]).toBe(400);
    const r2 = placeInOrder([-50, -40, 400], 80, 20, 1000);
    expect(r2[0]).toBe(20);
    expect(r2[1]).toBe(100);
  });
  it('下端の外にはみ出すものも、範囲の中へ寄せる', () => {
    const r = placeInOrder([100, 950, 1100], 80, 0, 1000);
    expect(r[2]).toBe(1000);
    expect(r[1]).toBe(920);
    expect(r[0]).toBe(100);
  });
  it('並びは入力の順のまま（段が入れ替わる途中でも、順番は崩れない）', () => {
    const r = placeInOrder([500, 200, 100], 50, 0, 1000);
    for (let i = 1; i < r.length; i++) expect(r[i] - r[i - 1]).toBeGreaterThanOrEqual(50 - 1e-9);
  });
  it('全体が範囲より長いときは、上端から詰める（順番と間隔は保つ）', () => {
    const r = placeInOrder([0, 0, 0], 100, 0, 150);
    expect(r[0]).toBe(0);
    expect(r[1] - r[0]).toBeCloseTo(100);
  });
  it('空は空', () => {
    expect(placeInOrder([], 10, 0, 100)).toEqual([]);
  });
});

describe('stackedFrameH（縦並びの枠の高さ）', () => {
  it('広ければ上限、狭ければ収まる高さ、ただし下限は割らない', () => {
    expect(stackedFrameH(5, 2000)).toBe(STACKED_FRAME_H.max);
    expect(stackedFrameH(5, 5 * (SUMMARY_H + 50) + 4 * GAP)).toBe(50);
    expect(stackedFrameH(5, 100)).toBe(STACKED_FRAME_H.min);
    expect(stackedFrameH(0, 100)).toBe(STACKED_FRAME_H.max);
  });
});

describe('stackedPlacement（縦並び）', () => {
  it('上から順に、同じ高さの枠を、重ならずに並べる', () => {
    const p = stackedPlacement(tiers(0, 0), REGION);
    expect(p.mode).toBe('stacked');
    expect(p.slots.map((s) => s.id)).toEqual(IDS);
    for (let i = 1; i < p.slots.length; i++) expect(p.slots[i].center - p.slots[i - 1].center).toBeCloseTo(SUMMARY_H + p.frameH + GAP);
    // 先頭の枠の上に、要約の分の余白がある
    expect(p.slots[0].center - p.frameH / 2 - SUMMARY_H).toBeCloseTo(REGION.top);
  });
  it('段の位置（y）によらない', () => {
    const a = stackedPlacement(tiers(100, 150), REGION);
    const b = stackedPlacement(tiers(0, 0), REGION);
    expect(a).toEqual(b);
  });
});

describe('placeCharts（揃える）', () => {
  it('段の間隔が十分なら、枠の縦の中心が段の高さに一致する。5つとも同じ高さ（上限まで）', () => {
    const p = placeCharts({ tiers: tiers(200, 180), region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned');
    expect(p.frameH).toBe(MAX_FRAME_H);
    p.slots.forEach((s, i) => expect(s.center).toBeCloseTo(200 + i * 180));
  });
  it('枠は、隣の段との間隔（要約と隙間を除く）に収まる高さになる', () => {
    const pitch = 100;
    const p = placeCharts({ tiers: tiers(200, pitch), region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned');
    expect(p.frameH).toBe(pitch - SUMMARY_H - GAP);
    // 隣のチャートの要約と重ならない
    for (let i = 1; i < p.slots.length; i++) {
      expect(p.slots[i].center - p.frameH / 2 - SUMMARY_H).toBeGreaterThanOrEqual(p.slots[i - 1].center + p.frameH / 2 + GAP - 1e-9);
    }
  });
  it('段の順番が変わっても、チャートは渡した順（上の段から）に並ぶ', () => {
    const order: LayerId[] = ['elevation', 'shelters', 'transit', 'flood', 'population'];
    const p = placeCharts({ tiers: tiers(200, 180, order), region: REGION, prev: 'aligned' });
    expect(p.slots.map((s) => s.id)).toEqual(order);
    expect(p.slots.map((s) => s.center)).toEqual([200, 380, 560, 740, 920]);
  });
  it('段が3つ（2つ非表示）でも揃う', () => {
    const p = placeCharts({ tiers: tiers(250, 280, ['transit', 'population', 'elevation']), region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned');
    expect(p.slots.map((s) => s.center)).toEqual([250, 530, 810]);
  });
  it('段が上の端に近いと、チャートはその段の高さから、領域の中へ寄る。枠は下限より小さくならない', () => {
    const p = placeCharts({ tiers: tiers(40, 200), region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned');
    expect(p.frameH).toBeGreaterThanOrEqual(MIN_FRAME_H);
    const top = p.slots[0].center - p.frameH / 2 - SUMMARY_H;
    expect(top).toBeGreaterThanOrEqual(REGION.top - 1e-9);
    expect(p.slots[1].center).toBeCloseTo(240); // 中の段は、そのまま
  });
  it('段が領域の外へ大きくはみ出しても、チャートはすべて領域の中に収まる（順番を保つ）', () => {
    const p = placeCharts({ tiers: tiers(-300, 280), region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned');
    for (const s of p.slots) {
      expect(s.center - p.frameH / 2 - SUMMARY_H).toBeGreaterThanOrEqual(REGION.top - 1e-9);
      expect(s.center + p.frameH / 2).toBeLessThanOrEqual(REGION.bottom + 1e-9);
    }
    for (let i = 1; i < p.slots.length; i++) expect(p.slots[i].center).toBeGreaterThan(p.slots[i - 1].center);
  });
  it('下の端の外にはみ出すときも、領域の中に収まる', () => {
    const p = placeCharts({ tiers: tiers(500, 280), region: REGION, prev: 'aligned' });
    for (const s of p.slots) expect(s.center + p.frameH / 2).toBeLessThanOrEqual(REGION.bottom + 1e-9);
  });
  it('アニメーション中に段が入れ替わって重なっても、チャートは重ならない', () => {
    const ts = tiers(200, 180);
    const crossing = ts.map((t, i) => ({ ...t, y: i === 1 ? ts[2].y - 5 : i === 2 ? ts[1].y + 5 : t.y }));
    const p = placeCharts({ tiers: crossing, region: REGION, prev: 'aligned' });
    expect(p.mode).toBe('aligned'); // 配置の決定は落ち着いたあとの高さ（goalY）で行うので、揃えるまま
    for (let i = 1; i < p.slots.length; i++) expect(p.slots[i].center - p.slots[i - 1].center).toBeGreaterThanOrEqual(p.frameH + SUMMARY_H + GAP - 1e-9);
  });
});

describe('placeCharts（縦並びへの切り替え）', () => {
  const pitchFor = (frame: number) => frame + SUMMARY_H + GAP;
  it('段が1つだけ・空のときは縦並び', () => {
    expect(placeCharts({ tiers: tiers(300, 0, ['elevation']), region: REGION, prev: 'aligned' }).mode).toBe('stacked');
    expect(placeCharts({ tiers: [], region: REGION, prev: 'aligned' }).mode).toBe('stacked');
  });
  it('真上の視点（段が同じ高さ）・間隔 0 は縦並び', () => {
    expect(placeCharts({ tiers: tiers(300, 0), region: REGION, prev: 'aligned' }).mode).toBe('stacked');
  });
  it('間隔が狭くて、下限の枠が入らないときは縦並び。入るなら揃える', () => {
    expect(placeCharts({ tiers: tiers(200, pitchFor(MIN_FRAME_H) - 1), region: REGION, prev: 'aligned' }).mode).toBe('stacked');
    expect(placeCharts({ tiers: tiers(200, pitchFor(MIN_FRAME_H)), region: REGION, prev: 'aligned' }).mode).toBe('aligned');
  });
  it('縦並びから揃えるへ戻るには、さらに余裕（HYSTERESIS）が要る。境目で行き来しない', () => {
    const edge = pitchFor(MIN_FRAME_H);
    // 揃えている間は、下限ちょうどまで揃えたまま
    expect(placeCharts({ tiers: tiers(200, edge), region: REGION, prev: 'aligned' }).mode).toBe('aligned');
    // 縦並びのときは、同じ間隔でも戻らない
    expect(placeCharts({ tiers: tiers(200, edge), region: REGION, prev: 'stacked' }).mode).toBe('stacked');
    expect(placeCharts({ tiers: tiers(200, edge + HYSTERESIS - 1), region: REGION, prev: 'stacked' }).mode).toBe('stacked');
    expect(placeCharts({ tiers: tiers(200, edge + HYSTERESIS), region: REGION, prev: 'stacked' }).mode).toBe('aligned');
  });
  it('間隔をゆっくり 20 → 0 → 20 と動かすと、切り替えは行きに1回、帰りに1回だけ', () => {
    let prev: 'aligned' | 'stacked' = 'aligned';
    const modes: string[] = [];
    const run = (pitch: number) => {
      prev = placeCharts({ tiers: tiers(200, pitch), region: REGION, prev }).mode;
      modes.push(prev);
    };
    for (let p = 220; p >= 0; p -= 1) run(p);
    for (let p = 0; p <= 220; p += 1) run(p);
    const changes = modes.filter((m, i) => i > 0 && m !== modes[i - 1]);
    expect(changes).toEqual(['stacked', 'aligned']);
  });
  it('決定は goalY（落ち着いたあとの高さ）で行い、途中の y の揺れでは切り替わらない', () => {
    const settled = tiers(200, 150);
    const wobbling = settled.map((t, i) => ({ ...t, y: 200 + i * 20 })); // 途中の y は近づいていても
    expect(placeCharts({ tiers: wobbling, region: REGION, prev: 'aligned' }).mode).toBe('aligned');
    const settledClose = tiers(200, 50).map((t, i) => ({ ...t, y: 200 + i * 300 }));
    expect(placeCharts({ tiers: settledClose, region: REGION, prev: 'aligned' }).mode).toBe('stacked');
  });
  it('領域が狭くて全チャートが入らないときは縦並び', () => {
    const p = placeCharts({ tiers: tiers(50, 200), region: { top: 2, bottom: 200 }, prev: 'aligned' });
    expect(p.mode).toBe('stacked');
  });
});

describe('minPitch', () => {
  it('隣り合う段の、いちばん狭い間隔', () => {
    expect(minPitch(tiers(0, 100))).toBe(100);
    expect(minPitch([{ id: 'flood', y: 0, goalY: 0 }, { id: 'transit', y: 0, goalY: 40 }, { id: 'shelters', y: 0, goalY: 200 }])).toBe(40);
    expect(minPitch(tiers(0, 100, ['flood']))).toBe(Infinity);
  });
});
