import { describe, expect, it } from 'vitest';
import { OrbitView } from '@deck.gl/core';
import { EXTENT } from '../config';
import { LIMITS, PAD, SOLO_ANGLES, fitView, labelAnchors, nearestAngle, projectPoint, spreadLabels } from './camera';
import type { Size } from './camera';

const corners = (top: number) =>
  [EXTENT.minX, EXTENT.maxX].flatMap((x) =>
    [EXTENT.minY, EXTENT.maxY].flatMap((y) => [0, top].map((z) => [x, y, z] as [number, number, number])),
  );

describe('fitView', () => {
  const sizes: Size[] = [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
    { width: 600, height: 900 },
    { width: 1920, height: 1080 },
  ];
  for (const size of sizes)
    for (const [rotationX, rotationOrbit] of [[30, 45], [10, 0], [60, 120], [90, 0], [45, 300]])
      for (const top of [0, 20000, 48000])
        it(`${size.width}x${size.height} rx=${rotationX} ro=${rotationOrbit} top=${top}: 箱が画面に収まり、左右の余白は右が広い`, () => {
          const f = fitView({ rotationX, rotationOrbit, top, size });
          const vs = { ...f, rotationX, rotationOrbit };
          const pts = corners(top).map((p) => projectPoint(vs, size, p));
          const xs = pts.map((p) => p[0]);
          const ys = pts.map((p) => p[1]);
          const clampedZoom = f.zoom <= LIMITS.minZoom + 1e-9 || f.zoom >= LIMITS.maxZoom - 1e-9;
          if (!clampedZoom) {
            expect(Math.min(...xs)).toBeGreaterThanOrEqual(PAD.left - 1);
            expect(size.width - Math.max(...xs)).toBeGreaterThanOrEqual(PAD.right - 1);
            expect(Math.min(...ys)).toBeGreaterThanOrEqual(PAD.vertical - 1);
            expect(size.height - Math.max(...ys)).toBeGreaterThanOrEqual(PAD.vertical - 1);
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
