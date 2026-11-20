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
  it('パネルを除いた幅の 31.5%。1400 px の画面では 360 px', () => {
    expect(closeupWidth(1400)).toBe(Math.round((1400 - RIGHT_PANEL_W) * CLOSEUP.share));
    expect(closeupWidth(1400)).toBe(360);
  });
  it('小さい画面では下限（340 px）、大きい画面では上限（560 px）', () => {
    expect(closeupWidth(1000)).toBe(CLOSEUP.minWidth);
    expect(closeupWidth(300)).toBe(CLOSEUP.minWidth);
    expect(closeupWidth(3000)).toBe(CLOSEUP.maxWidth);
  });
  it('1400 px 幅で、クローズアップの左に 784 px 残る（レイヤー名のぶんの余白を引いても積層が収まる）', () => {
    expect(1400 - RIGHT_PANEL_W - closeupWidth(1400)).toBe(784);
  });
});

describe('maxScale（避ける長方形と外形が別のとき、長方形が複数のとき）', () => {
  const inner: Rect = { left: 0, top: 0, right: 1000, bottom: 500 };
  const pref: Pt = [500, 250];
  const outer: Pt[] = [[-120, -60], [120, -60], [-120, 60], [120, 60]]; // 外枠（四角）
  const core: Pt[] = [[-100, 0], [100, 0], [0, -50], [0, 50]]; // データのある範囲（菱形。外枠の角にはない）
  const place = (o: Pt[], s: number, c: Pt) => o.map((p) => [c[0] + p[0] * s, c[1] + p[1] * s] as const);

  it('avoidOffsets を渡すと、外枠の角は避ける長方形の下に入ってよく、そのぶん大きくなる', () => {
    const avoid: Rect[] = [{ left: 800, top: 0, right: 1000, bottom: 500 }];
    const withSquare = maxScale(outer, pref, inner, avoid);
    const withCore = maxScale(outer, pref, inner, avoid, { avoidOffsets: core });
    expect(withCore.scale).toBeGreaterThan(withSquare.scale);
    expect(convexIntersectsRect(convexHull(place(core, withCore.scale, withCore.center)), avoid[0])).toBe(false);
    // 外枠は領域の中には収まる
    for (const p of place(outer, withCore.scale, withCore.center)) {
      expect(p[0]).toBeGreaterThanOrEqual(-1e-6);
      expect(p[0]).toBeLessThanOrEqual(1000 + 1e-6);
    }
  });
  it('長方形が2つあるとき、それぞれ単独で最もよい向きの組み合わせにこだわらず、全体で大きく置ける向きを選ぶ', () => {
    const wide: Pt[] = [[-100, -250], [100, -250], [-100, 250], [100, 250], [0, -300], [0, 300]];
    const box: Rect = { left: 0, top: 0, right: 600, bottom: 600 };
    const a: Rect = { left: 0, top: 400, right: 200, bottom: 600 }; // 左下
    const b: Rect = { left: 420, top: 0, right: 600, bottom: 600 }; // 右の全高
    const r = maxScale(wide, [300, 300], box, [a, b]);
    const poly = convexHull(place(wide, r.scale, r.center));
    expect(convexIntersectsRect(poly, a)).toBe(false);
    expect(convexIntersectsRect(poly, b)).toBe(false);
    // 総当たり（中心を 3 px 刻みで探し、倍率を 0.5% 刻みで下げる）で見つかる最大の 98% 以上
    let best = 0;
    for (let s = 2; s > 0.2 && best === 0; s *= 0.995)
      for (let cx = 0; cx <= 600 && best === 0; cx += 3)
        for (let cy = 0; cy <= 600; cy += 3) {
          const pts = place(wide, s, [cx, cy]);
          if (pts.some((p) => p[0] < 0 || p[0] > 600 || p[1] < 0 || p[1] > 600)) continue;
          const h = convexHull(pts);
          if (!convexIntersectsRect(h, a) && !convexIntersectsRect(h, b)) {
            best = s;
            break;
          }
        }
    expect(r.scale).toBeGreaterThan(best * 0.97);
  });
});

describe('computeLayout（クローズアップの領域）', () => {
  it('closeupWidth を渡すと、右端にその幅（とレイヤー名のぶん）の長方形を避ける', () => {
    const size = { width: 1144, height: 1000 };
    const l = computeLayout(size, { closeupWidth: 480 });
    expect(l.avoid).toHaveLength(2);
    expect(l.avoid[1]).toEqual({ left: 1144 - 480 - LABEL_ROOM, top: 0, right: 1144, bottom: 1000 });
    expect(computeLayout(size).avoid).toHaveLength(1);
    expect(computeLayout(size, { closeupWidth: 0 }).avoid).toHaveLength(1);
  });
});
