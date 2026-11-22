import { describe, expect, it } from 'vitest';
import { nearestOnRect, placeCallouts, segmentHitsRect, segmentInsideConvex, segmentsCross } from './calloutPlacement';
import type { CalloutItem, CalloutObstacles, Pt, Rect } from './calloutPlacement';

const rectsOverlap = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('線分と長方形・多角形の判定', () => {
  const r: Rect = { left: 10, top: 10, right: 20, bottom: 20 };
  it('segmentHitsRect：通る・外れる・かするだけ', () => {
    expect(segmentHitsRect([0, 15], [30, 15], r)).toBe(true);
    expect(segmentHitsRect([0, 0], [5, 5], r)).toBe(false);
    expect(segmentHitsRect([12, 12], [18, 18], r)).toBe(true); // 中に収まる線分
    expect(segmentHitsRect([0, 10], [30, 10], r)).toBe(false); // 縁に沿うだけ
  });
  it('segmentsCross：端点以外で交わるときだけ', () => {
    expect(segmentsCross([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true);
    expect(segmentsCross([0, 0], [10, 0], [0, 5], [10, 5])).toBe(false);
    expect(segmentsCross([0, 0], [5, 5], [5, 5], [10, 0])).toBe(false); // 端点を共有するだけ
  });
  it('nearestOnRect：外の点は縁へ、中の点はそのまま', () => {
    expect(nearestOnRect(r, [0, 15])).toEqual([10, 15]);
    expect(nearestOnRect(r, [30, 30])).toEqual([20, 20]);
    expect(nearestOnRect(r, [15, 15])).toEqual([15, 15]);
  });
  it('segmentInsideConvex：多角形の内側の長さ（向きによらない）', () => {
    const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const cw = [...sq].reverse();
    expect(segmentInsideConvex([-5, 5], [15, 5], sq)).toBeCloseTo(10);
    expect(segmentInsideConvex([-5, 5], [15, 5], cw)).toBeCloseTo(10);
    expect(segmentInsideConvex([5, 5], [5, 20], sq)).toBeCloseTo(5);
    expect(segmentInsideConvex([-5, -5], [-5, 20], sq)).toBe(0);
    expect(segmentInsideConvex([1, 1], [2, 2], sq)).toBeCloseTo(Math.SQRT2);
  });
});

describe('placeCallouts', () => {
  const bounds: Rect = { left: 0, top: 0, right: 800, bottom: 600 };
  const item = (id: string, x: number, y: number, w = 70, h = 40): CalloutItem => ({ id, anchor: [x, y], w, h });
  const none: CalloutObstacles = { bounds, rects: [], polys: [], soft: [] };

  it('隣り合う目印の札が、重ならず、引き出し線も札や線と交わらない', () => {
    const items = [item('a', 400, 300), item('b', 420, 305), item('c', 440, 300), item('d', 410, 320), item('e', 430, 322)];
    const res = placeCallouts(items, none);
    expect(res.missing).toEqual([]);
    expect(res.conflict).toBe(false);
    expect(res.placed).toHaveLength(5);
    for (const p of res.placed) {
      expect(p.rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(p.rect.right).toBeLessThanOrEqual(bounds.right);
      // 札は、自分の目印を覆わない
      expect(p.anchor[0] > p.rect.left && p.anchor[0] < p.rect.right && p.anchor[1] > p.rect.top && p.anchor[1] < p.rect.bottom).toBe(false);
    }
    for (let i = 0; i < res.placed.length; i++)
      for (let j = i + 1; j < res.placed.length; j++) {
        const a = res.placed[i];
        const b = res.placed[j];
        expect(rectsOverlap(a.rect, b.rect)).toBe(false);
        expect(segmentsCross(a.anchor, a.attach, b.anchor, b.attach)).toBe(false);
        expect(segmentHitsRect(a.anchor, a.attach, b.rect)).toBe(false);
        expect(segmentHitsRect(b.anchor, b.attach, a.rect)).toBe(false);
      }
  });

  it('重ねてはいけない長方形・凸多角形・領域の外を避ける', () => {
    const wall: Rect = { left: 300, top: 0, right: 800, bottom: 600 };
    const hull: Pt[] = [[100, 100], [250, 100], [250, 500], [100, 500]];
    const res = placeCallouts([item('a', 280, 300), item('b', 285, 310)], { bounds, rects: [wall], polys: [hull], soft: [] });
    expect(res.conflict).toBe(false);
    expect(res.placed).toHaveLength(2);
    for (const p of res.placed) {
      expect(rectsOverlap(p.rect, wall)).toBe(false);
      expect(p.rect.right <= 100 || p.rect.left >= 250 || p.rect.bottom <= 100 || p.rect.top >= 500).toBe(true);
      expect(p.rect.left).toBeGreaterThanOrEqual(0);
    }
  });

  it('近くを選ぶ：障害物がなければ、引き出し線は短い', () => {
    const res = placeCallouts([item('a', 400, 300)], none);
    const p = res.placed[0];
    expect(Math.hypot(p.attach[0] - p.anchor[0], p.attach[1] - p.anchor[1])).toBeLessThanOrEqual(13);
  });

  it('置ける場所がないものは missing、重なりを避けられないときは conflict', () => {
    const tiny: CalloutObstacles = { bounds: { left: 0, top: 0, right: 60, bottom: 40 }, rects: [], polys: [], soft: [] };
    expect(placeCallouts([item('big', 30, 20, 200, 100)], tiny).missing).toEqual(['big']);
    // 札2枚（70×40）が、同じ小さな領域に入りきらない
    const small: CalloutObstacles = { bounds: { left: 0, top: 0, right: 90, bottom: 50 }, rects: [], polys: [], soft: [] };
    const res = placeCallouts([item('a', 45, 25), item('b', 46, 25)], small);
    expect(res.missing.length > 0 || res.conflict).toBe(true);
  });

  it('同じ入力なら、同じ結果（決定的）', () => {
    const items = [item('a', 400, 300), item('b', 420, 305), item('c', 440, 300)];
    expect(placeCallouts(items, none)).toEqual(placeCallouts(items, none));
  });

  it('同じ段のデータの範囲（soft）は、置ける場所があれば避ける', () => {
    const soft: Pt[] = [[350, 250], [450, 250], [450, 350], [350, 350]];
    const res = placeCallouts([item('a', 400, 300)], { ...none, soft: [soft] });
    const r = res.placed[0].rect;
    expect(r.right <= 350 || r.left >= 450 || r.bottom <= 250 || r.top >= 350).toBe(true);
  });
});
