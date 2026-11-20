import { describe, expect, it } from 'vitest';
import { OrbitView } from '@deck.gl/core';
import { DATA_OUTLINE, EXTENT } from '../config';
import { DATA_BOX, LIMITS, SOLO_ANGLES, fitStack, fitView, hasSize, labelAnchors, nearestAngle, projectPoint, rayToPolygon, spreadLabels } from './camera';
import type { Size } from './camera';
import { RIGHT_PANEL_W, closeupWidth, computeLayout, convexHull, convexIntersectsRect, paddedCenter } from './layout';

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

describe('rayToPolygon', () => {
  const square: [number, number][] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  it('中心から縁までの距離', () => {
    expect(rayToPolygon(0, 0, 1, 0, square)).toBeCloseTo(10);
    expect(rayToPolygon(0, 0, 0, -1, square)).toBeCloseTo(10);
    expect(rayToPolygon(0, 0, Math.SQRT1_2, Math.SQRT1_2, square)).toBeCloseTo(10 * Math.SQRT2);
    expect(rayToPolygon(5, 0, 1, 0, square)).toBeCloseTo(5);
  });
  it('向きを少しずつ回すと、距離は連続的に変わる', () => {
    let prev = rayToPolygon(-1000, -1000, 1, 0, DATA_OUTLINE);
    for (let deg = 1; deg <= 360; deg++) {
      const t = (deg * Math.PI) / 180;
      const r = rayToPolygon(-1000, -1000, Math.cos(t), Math.sin(t), DATA_OUTLINE);
      expect(r).toBeGreaterThan(10000);
      expect(Math.abs(r - prev)).toBeLessThan(1500);
      prev = r;
    }
  });
});

describe('labelAnchors（データのある範囲）', () => {
  it('データのある範囲の縁にあり、描画範囲の外枠より内側', () => {
    for (const ro of [0, 45, 90, 135, 200, -70]) {
      const [a] = labelAnchors(20, ro, [0], DATA_BOX);
      const [b] = labelAnchors(20, ro, [0]);
      expect(Math.hypot(a[0] - DATA_BOX.cx, a[1] - DATA_BOX.cy)).toBeLessThan(Math.hypot(b[0] - DATA_BOX.cx, b[1] - DATA_BOX.cy) + 1e-6);
      expect(a[0]).toBeGreaterThan(EXTENT.minX);
      expect(a[0]).toBeLessThan(EXTENT.maxX);
    }
  });
});

describe('fitStack（クローズアップが出る前後で、地図の大きさは変わらない）', () => {
  const windows: [number, number][] = [[1400, 1000], [1000, 700], [1920, 1080], [1280, 800], [1600, 900]];
  const angles: [number, number][] = [[20, 45], [12, 0], [60, 120], [90, 0], [45, 300]];
  for (const [w, h] of windows)
    for (const [rotationX, rotationOrbit] of angles)
      for (const top of [0, 24000, 48000, 80000]) {
        const size = { width: w - RIGHT_PANEL_W, height: h };
        const cw = closeupWidth(w);
        const opts = { rotationX, rotationOrbit, top, size, closeupWidth: cw };
        it(`${w}x${h} rx=${rotationX} ro=${rotationOrbit} top=${top}: zoom は出る前後で同じ。位置は、出ると左へだけ動き（縦は動かない）、右の領域には入らない`, () => {
          const off = fitStack({ ...opts, closeupOn: false });
          const on = fitStack({ ...opts, closeupOn: true });
          expect(off.zoom).toBe(on.zoom);
          const vs = (f: typeof on) => ({ ...f, rotationX, rotationOrbit });
          // 23区のデータのある範囲の画面上の外形（全段）
          const outline = (f: typeof on) => DATA_OUTLINE.flatMap(([x, y]) => [0, top].map((z) => projectPoint(vs(f), size, [x, y, z])));
          const onPts = outline(on);
          const offPts = outline(off);
          const clampedZoom = on.zoom <= LIMITS.minZoom + 1e-9 || on.zoom >= LIMITS.maxZoom - 1e-9;
          if (clampedZoom) return;
          // 出ているとき：クローズアップ（とレイヤー名の余白）、探針パネルに重ならない
          const closeupRect = { left: size.width - cw - 80, top: 0, right: size.width, bottom: size.height };
          const probeRect = computeLayout(size).avoid[0];
          expect(convexIntersectsRect(convexHull(onPts), closeupRect)).toBe(false);
          expect(convexIntersectsRect(convexHull(onPts), probeRect)).toBe(false);
          // 出ていないとき：探針パネルには重ならない（クローズアップの領域は空いている）
          expect(convexIntersectsRect(convexHull(offPts), probeRect)).toBe(false);
          // 位置は左へだけ動く（右端が、出ていないときより左。縦は同じ）
          const rightEdge = (pts: [number, number][]) => Math.max(...pts.map((p) => p[0]));
          const topEdge = (pts: [number, number][]) => Math.min(...pts.map((p) => p[1]));
          expect(rightEdge(onPts)).toBeLessThanOrEqual(rightEdge(offPts) + 1e-6);
          expect(topEdge(onPts)).toBeCloseTo(topEdge(offPts), 6);
        });
      }

  it('間隔スライダーを動かしても、出る前後の zoom は同じで、zoom は連続的に変わる', () => {
    const size = { width: 1144, height: 1000 };
    let prev: number | null = null;
    for (let top = 0; top <= 80000; top += 1000) {
      const a = fitStack({ rotationX: 20, rotationOrbit: 45, top, size, closeupWidth: 480, closeupOn: false });
      const b = fitStack({ rotationX: 20, rotationOrbit: 45, top, size, closeupWidth: 480, closeupOn: true });
      expect(a.zoom).toBe(b.zoom);
      if (prev !== null) expect(Math.abs(a.zoom - prev)).toBeLessThan(0.1);
      prev = a.zoom;
    }
  });

  it('クローズアップが出る前の地図は、クローズアップを避けない配置（出ていない配置）より小さい（出た後に合わせる）', () => {
    const size = { width: 1144, height: 1000 };
    const common = fitStack({ rotationX: 20, rotationOrbit: 45, top: 48000, size, closeupWidth: 480, closeupOn: false });
    const alone = fitView({ rotationX: 20, rotationOrbit: 45, top: 48000, size, box: DATA_BOX });
    expect(common.zoom).toBeLessThan(alone.zoom);
  });
});
