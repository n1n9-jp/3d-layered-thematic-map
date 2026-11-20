import { describe, expect, it } from 'vitest';
import { LABEL_ROOM, PROBE_PANEL, RIGHT_PANEL_W, computeLayout, convexHull, convexIntersectsRect, maxScale, paddedCenter, placeBox } from './layout';
import type { Pt, Rect } from './layout';

describe('convexHull', () => {
  it('内側の点を除く', () => {
    const h = convexHull([[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [1, 3]]);
    expect(h).toHaveLength(4);
  });
});

describe('convexIntersectsRect', () => {
  const r: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
  it('重なる・離れる・接するだけ', () => {
    expect(convexIntersectsRect([[5, 5], [20, 5], [20, 20]], r)).toBe(true);
    expect(convexIntersectsRect([[20, 20], [30, 20], [30, 30]], r)).toBe(false);
    expect(convexIntersectsRect([[10, 0], [20, 0], [20, 10]], r)).toBe(false);
  });
  it('外接する長方形どうしは重なっても、斜めの三角形が角をかすめなければ重ならない', () => {
    // 外接箱は r と重なるが、三角形そのものは r から離れている
    expect(convexIntersectsRect([[20, 0], [0, 20], [20, 20]], r)).toBe(false);
  });
});

describe('computeLayout', () => {
  it('右にレイヤー名のぶん、左下に探針パネルの避ける領域をとる', () => {
    const l = computeLayout({ width: 1400 - RIGHT_PANEL_W, height: 1000 });
    expect(l.padding.right).toBe(LABEL_ROOM);
    expect(l.avoid[0]).toEqual({ left: 0, top: 1000 - PROBE_PANEL.height, right: PROBE_PANEL.width, bottom: 1000 });
  });
  it('狭い画面でも領域が潰れない', () => {
    const l = computeLayout({ width: 300, height: 300 });
    expect(300 - l.padding.left - l.padding.right).toBeGreaterThanOrEqual(100);
  });
  it('paddedCenter は padding の内側の中心', () => {
    expect(paddedCenter({ width: 1000, height: 600 }, { left: 20, right: 300, top: 10, bottom: 30 })).toEqual([360, 290]);
  });
});

describe('maxScale', () => {
  const diamond: Pt[] = [[-100, 0], [100, 0], [0, -50], [0, 50]];
  const inner: Rect = { left: 0, top: 0, right: 1000, bottom: 500 };
  const pref: Pt = [500, 250];
  const placed = (s: number, c: Pt) => convexHull(diamond).map((p) => [c[0] + p[0] * s, c[1] + p[1] * s] as const);

  it('避ける領域がなければ、領域いっぱいまで拡大し、中心は希望の位置', () => {
    const r = maxScale(diamond, pref, inner, []);
    expect(r.scale).toBeCloseTo(5); // 横 500/100、縦 250/50
    expect(r.center[0]).toBeCloseTo(500);
    expect(r.center[1]).toBeCloseTo(250);
  });
  it('避ける領域があっても、中心を動かして倍率を保てるなら保つ', () => {
    const avoid: Rect[] = [{ left: 0, top: 300, right: 300, bottom: 500 }];
    const r = maxScale(diamond, pref, inner, avoid);
    expect(r.scale).toBeGreaterThan(3.5);
    expect(convexIntersectsRect(placed(r.scale, r.center), avoid[0])).toBe(false);
    // 領域の内側
    for (const p of placed(r.scale, r.center)) {
      expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
      expect(p[0]).toBeLessThanOrEqual(1000 + 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(p[1]).toBeLessThanOrEqual(500 + 1e-6);
    }
    // これ以上は大きくできない
    expect(placeBox(diamond, r.scale * 1.02, pref, inner, avoid)).toBeNull();
  });
  it('避けても倍率を保てるほど広いなら、倍率は領域だけで決まる', () => {
    const avoid: Rect[] = [{ left: 0, top: 450, right: 100, bottom: 500 }];
    expect(maxScale(diamond, pref, inner, avoid).scale).toBeCloseTo(5);
  });
  it('どこにも置けないときは、避けずに領域だけに収める', () => {
    const avoid: Rect[] = [{ left: -10, top: -10, right: 1010, bottom: 510 }];
    expect(maxScale(diamond, pref, inner, avoid).scale).toBeCloseTo(5);
  });
});

describe('placeBox', () => {
  const sq: Pt[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  const inner: Rect = { left: 0, top: 0, right: 100, bottom: 100 };
  it('希望の位置が空いていればそこ', () => {
    expect(placeBox(sq, 1, [50, 50], inner, [{ left: 0, top: 80, right: 20, bottom: 100 }])).toEqual([50, 50]);
  });
  it('重なるときは、重ならない最も近い位置へ動かす', () => {
    const avoid: Rect[] = [{ left: 40, top: 40, right: 60, bottom: 60 }];
    const c = placeBox(sq, 1, [50, 50], inner, avoid) as Pt;
    expect(c).not.toBeNull();
    const poly = sq.map((p) => [c[0] + p[0], c[1] + p[1]] as const);
    expect(convexIntersectsRect(poly, avoid[0])).toBe(false);
    // 4方向のどれかへ 20 動かした位置（箱の半幅10 + 避ける領域の半幅10）
    expect(Math.hypot(c[0] - 50, c[1] - 50)).toBeCloseTo(20);
  });
});
