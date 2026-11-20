import { describe, expect, it } from 'vitest';
import { OrbitView } from '@deck.gl/core';
import { EXTENT } from '../config';
import { LIMITS, SOLO_ANGLES, fitView, hasSize, labelAnchors, nearestAngle, projectPoint, spreadLabels } from './camera';
import type { Size } from './camera';
import { computeLayout, convexHull, convexIntersectsRect, paddedCenter } from './layout';

const corners = (top: number) =>
  [EXTENT.minX, EXTENT.maxX].flatMap((x) =>
    [EXTENT.minY, EXTENT.maxY].flatMap((y) => [0, top].map((z) => [x, y, z] as [number, number, number])),
  );

describe('fitView', () => {
  const sizes: Size[] = [
    { width: 1144, height: 1000 },
    { width: 744, height: 700 },
    { width: 600, height: 900 },
    { width: 600, height: 900 },
    { width: 1920, height: 1080 },
  ];
  for (const size of sizes)
    for (const [rotationX, rotationOrbit] of [[20, 45], [10, 0], [60, 120], [90, 0], [45, 300]])
      for (const top of [0, 20000, 48000, 80000])
        it(`${size.width}x${size.height} rx=${rotationX} ro=${rotationOrbit} top=${top}: 箱が余白の内側に収まり、探針パネルと重ならない`, () => {
          const layout = computeLayout(size);
          const f = fitView({ rotationX, rotationOrbit, top, size, layout });
          const vs = { ...f, rotationX, rotationOrbit };
          const pts = corners(top).map((p) => projectPoint(vs, size, p));
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const clampedZoom = f.zoom <= LIMITS.minZoom + 1e-9 || f.zoom >= LIMITS.maxZoom - 1e-9;
          if (!clampedZoom) {
            const { left, right, top: pt, bottom } = layout.padding;
            expect(Math.min(...xs)).toBeGreaterThanOrEqual(left - 1);
            expect(size.width - Math.max(...xs)).toBeGreaterThanOrEqual(right - 1);
            expect(Math.min(...ys)).toBeGreaterThanOrEqual(pt - 1);
            expect(size.height - Math.max(...ys)).toBeGreaterThanOrEqual(bottom - 1);
            // 左下の探針パネルの長方形に、箱の各辺が入り込まない（辺の上の点で確認）
            const r = layout.avoid[0];
            const edge: number[][] = [];
            for (let i = 0; i < pts.length; i++)
              for (let j = i + 1; j < pts.length; j++)
                for (let t = 0.05; t < 1; t += 0.05) edge.push([pts[i][0] * (1 - t) + pts[j][0] * t, pts[i][1] * (1 - t) + pts[j][1] * t]);
            const inside = edge.filter(([x, y]) => x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1);
            expect(inside).toEqual([]);
          }
        });

  it('避ける領域がなければ、箱の中心が余白の内側の領域の中心に来る', () => {
    const size = { width: 1148, height: 1000 };
    const layout = { ...computeLayout(size), avoid: [] };
    const f = fitView({ rotationX: 20, rotationOrbit: 45, top: 48000, size, layout });
    const [cx, cy] = projectPoint({ ...f, rotationX: 20, rotationOrbit: 45 }, size, [(EXTENT.minX + EXTENT.maxX) / 2, (EXTENT.minY + EXTENT.maxY) / 2, 24000]);
    const [ex, ey] = paddedCenter(size, layout.padding);
    expect(cx).toBeCloseTo(ex, 3);
    expect(cy).toBeCloseTo(ey, 3);
  });

  it('高さが増えるほど zoom は小さくなる（縦長でも収まる）', () => {
    const size = { width: 1144, height: 600 };
    const layout = { ...computeLayout(size), avoid: [] };
    const z = (top: number) => fitView({ rotationX: 20, rotationOrbit: 45, top, size, layout }).zoom;
    expect(z(80000)).toBeLessThan(z(48000));
    expect(z(48000)).toBeLessThan(z(0));
  });
});

describe('間隔スライダーを動かしたときの連続性', () => {
  const RIGHT = 256;
  const center = (top: number): [number, number, number] => [(EXTENT.minX + EXTENT.maxX) / 2, (EXTENT.minY + EXTENT.maxY) / 2, top / 2];
  // 窓の大きさ（描画領域は右のパネルの幅を除いた範囲）。冒頭の4つは、位置が跳んでいた再現条件。
  const windows: [number, number][] = [[1400, 1000], [1920, 1000], [1400, 700], [1400, 900], [1000, 700], [1280, 800], [800, 600], [1664, 1000]];
  const angles: [number, number][] = [[20, 45], [35, 120], [60, 300], [12, 10]];
  for (const [w, h] of windows)
    for (const [rotationX, rotationOrbit] of angles)
      it(`${w}x${h} rx=${rotationX} ro=${rotationOrbit}: 間隔を 0〜20km で 10m 刻みに動かすと、箱の中心は 1 刻みあたり 2px を超えて動かず、避ける領域に重ならない`, () => {
        const size: Size = { width: w - RIGHT, height: h };
        const layout = computeLayout(size);
        let prev: [number, number] | null = null;
        let prevZoom = 0;
        let worst = 0;
        for (let spacing = 0; spacing <= 20000; spacing += 10) {
          const top = 4 * spacing;
          const f = fitView({ rotationX, rotationOrbit, top, size, layout });
          expect(Number.isFinite(f.zoom) && f.target.every(Number.isFinite)).toBe(true);
          const vs = { ...f, rotationX, rotationOrbit };
          const c = projectPoint(vs, size, center(top));
          if (prev) {
            worst = Math.max(worst, Math.hypot(c[0] - prev[0], c[1] - prev[1]));
            expect(Math.abs(f.zoom - prevZoom)).toBeLessThan(0.02); // 倍率も連続（10m で 1.4% 未満）
          }
          prev = c;
          prevZoom = f.zoom;
          if (f.zoom > LIMITS.minZoom + 1e-9 && f.zoom < LIMITS.maxZoom - 1e-9) {
            const hull = convexHull(corners(top).map((p) => projectPoint(vs, size, p)));
            for (const r of layout.avoid) expect(convexIntersectsRect(hull, r)).toBe(false);
          }
        }
        expect(worst).toBeLessThanOrEqual(2);
      });
});

describe('描画領域に大きさがないとき', () => {
  it('幅か高さが 1px に満たなければ、大きさがないとみなす', () => {
    expect(hasSize({ width: 0, height: 700 })).toBe(false);
    expect(hasSize({ width: 800, height: 0 })).toBe(false);
    expect(hasSize({ width: 0.5, height: 700 })).toBe(false);
    expect(hasSize(null)).toBe(false);
    expect(hasSize({ width: 1, height: 1 })).toBe(true);
  });
  it('小さな領域でも fitView は落ちず、有限の値を返す', () => {
    for (const [width, height] of [[1, 1], [1, 700], [44, 700], [200, 5], [100, 100], [330, 300]]) {
      const f = fitView({ rotationX: 20, rotationOrbit: 45, top: 48000, size: { width, height } });
      expect(Number.isFinite(f.zoom) && f.target.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('fovy を小さくしても絵は変わらない', () => {
  it('fovy 5 と 50 で投影結果が一致する', () => {
    const vs = { target: [0, 0, 5000] as [number, number, number], rotationX: 30, rotationOrbit: 45, zoom: -5 };
    const p = [10000, -8000, 12000] as [number, number, number];
    const a = projectPoint(vs, { width: 1000, height: 700 }, p);
    const b = new OrbitView({ orthographic: true, fovy: 50 }).makeViewport({ width: 1000, height: 700, viewState: vs })!.project(p);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
  });
});

describe('labelAnchors', () => {
  it('どの方位でも、平面の中心より画面の右側に来る（同じ高さ）', () => {
    const size = { width: 1000, height: 700 };
    for (const ro of [0, 45, 90, 135, 180, 225, 270, 315, 400, -70]) {
      const rx = 30;
      const f = fitView({ rotationX: rx, rotationOrbit: ro, top: 10000, size });
      const vs = { ...f, rotationX: rx, rotationOrbit: ro };
            const [a] = labelAnchors(rx, ro, [4000]);
      const [ax, ay] = projectPoint(vs, size, a);
      const [cx, cy] = projectPoint(vs, size, [(EXTENT.minX + EXTENT.maxX) / 2, (EXTENT.minY + EXTENT.maxY) / 2, 4000]);
      expect(ax).toBeGreaterThan(cx + 100);
      expect(ay).toBeCloseTo(cy, 3);
    }
  });
  it('真上・方位0 では右辺の中央', () => {
    const [a] = labelAnchors(SOLO_ANGLES.rotationX, SOLO_ANGLES.rotationOrbit, [0]);
    expect(a[0]).toBeCloseTo(EXTENT.maxX, 3);
    expect(a[1]).toBeCloseTo((EXTENT.minY + EXTENT.maxY) / 2, 3);
  });
});

describe('nearestAngle', () => {
  it('360度の整数倍のうち近いほう', () => {
    expect(nearestAngle(0, 350)).toBe(360);
    expect(nearestAngle(0, -20)).toBe(0);
    expect(nearestAngle(30, 400)).toBe(390);
  });
});

describe('spreadLabels', () => {
  it('離れていれば動かさない', () => {
    expect(spreadLabels([10, 100, 300], 20)).toEqual([10, 100, 300]);
  });
  it('重なったものは gap だけ離し、中心を保つ（同じ位置なら添字の大きいほうが上）', () => {
    const out = spreadLabels([100, 100, 100], 20);
    expect(out).toEqual([120, 100, 80]);
  });
  it('入力の並びを保つ', () => {
    const out = spreadLabels([105, 100], 20);
    expect(out[1]).toBeLessThan(out[0]);
    expect(out[0] - out[1]).toBeCloseTo(20);
  });
});
