import { describe, expect, it } from 'vitest';
import { CLOSEUP, LABEL_ROOM, PROBE_PANEL, RIGHT_PANEL_W, closeupWidth, computeLayout, convexHull, convexIntersectsRect, maxScale, paddedCenter } from './layout';
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
    for (const p of placed(r.scale, r.center)) {
      expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
      expect(p[0]).toBeLessThanOrEqual(1000 + 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(p[1]).toBeLessThanOrEqual(500 + 1e-6);
    }
  });
  it('避けても倍率を保てるほど広いなら、倍率は領域だけで決まり、中心は希望の位置', () => {
    const avoid: Rect[] = [{ left: 0, top: 450, right: 100, bottom: 500 }];
    const r = maxScale(diamond, pref, inner, avoid);
    expect(r.scale).toBeGreaterThan(5 * 0.985); // 避けるときは最大より 1% ほど小さくして、置ける範囲に幅を残す
    expect(r.scale).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.hypot(r.center[0] - 500, r.center[1] - 250)).toBeLessThan(6);
  });
  it('どこにも置けないときは、避けずに領域だけに収める', () => {
    const avoid: Rect[] = [{ left: -10, top: -10, right: 1010, bottom: 510 }];
    const r = maxScale(diamond, pref, inner, avoid);
    expect(r.scale).toBeCloseTo(5);
    expect(Number.isFinite(r.center[0]) && Number.isFinite(r.center[1])).toBe(true);
  });
  it('外形・領域・避ける領域を少しずつ変えると、倍率も中心も連続的に変わる', () => {
    let prev: { scale: number; center: Pt } | null = null;
    for (let k = 0; k <= 400; k++) {
      const h = 40 + k * 0.5; // 外形の縦を 40〜240 に変える
      const o: Pt[] = [[-100, 0], [100, 0], [0, -h], [0, h]];
      const avoid: Rect[] = [{ left: 0, top: 330, right: 330, bottom: 500 }];
      const r = maxScale(o, pref, inner, avoid);
      expect(Number.isFinite(r.scale) && r.scale > 0).toBe(true);
      if (prev) {
        expect(Math.abs(r.scale - prev.scale) / prev.scale).toBeLessThan(0.01);
        expect(Math.hypot(r.center[0] - prev.center[0], r.center[1] - prev.center[1])).toBeLessThan(5);
      }
      prev = r;
    }
  });
});

describe('closeupWidth', () => {
  it('パネルを除いた幅の 42%。1400 px の画面では 480 px', () => {
    expect(closeupWidth(1400)).toBe(Math.round((1400 - RIGHT_PANEL_W) * CLOSEUP.share));
    expect(closeupWidth(1400)).toBe(480);
  });
  it('小さい画面では下限（340 px）、大きい画面では上限（560 px）', () => {
    expect(closeupWidth(1000)).toBe(CLOSEUP.minWidth);
    expect(closeupWidth(300)).toBe(CLOSEUP.minWidth);
    expect(closeupWidth(3000)).toBe(CLOSEUP.maxWidth);
  });
  it('1400 px 幅で、全体の積層の領域に 664 px 残る（レイヤー名のぶんの余白を引いても積層が収まる）', () => {
    expect(1400 - RIGHT_PANEL_W - closeupWidth(1400)).toBe(664);
  });
});
