import { describe, expect, it } from 'vitest';
import { projectPoint } from '../view/camera';
import { towardCamera } from '../view/camera';
import { facing, pillarMatrix, pillarSpan, pillarWalls, silhouettePoints, wallAlpha, wallColor } from './pillar';

const circle = { x: 1550, y: 130, r: 2000 };

describe('pillarWalls', () => {
  it('円を一周する steps 枚の、縦長の四角形になる', () => {
    const walls = pillarWalls(circle, 32);
    expect(walls).toHaveLength(32);
    for (const w of walls) {
      const [a, b, c, d] = w.polygon;
      // 下の2点は高さ 0、上の2点は高さ 1。同じ (x, y) が上下にある
      expect([a[2], b[2], c[2], d[2]]).toEqual([0, 0, 1, 1]);
      expect([a[0], a[1]]).toEqual([d[0], d[1]]);
      expect([b[0], b[1]]).toEqual([c[0], c[1]]);
      // 頂点はすべて円周の上
      for (const p of w.polygon) expect(Math.hypot(p[0] - circle.x, p[1] - circle.y)).toBeCloseTo(circle.r, 6);
      // 法線は単位ベクトルで、四角形の中点から外へ向く
      expect(Math.hypot(...w.normal)).toBeCloseTo(1, 9);
      const mx = (a[0] + b[0]) / 2 - circle.x;
      const my = (a[1] + b[1]) / 2 - circle.y;
      expect(mx * w.normal[0] + my * w.normal[1]).toBeGreaterThan(0);
    }
  });

  it('隣り合う四角形は端を共有し、一周して閉じる', () => {
    const walls = pillarWalls(circle, 16);
    for (let k = 0; k < walls.length; k++) {
      const end = walls[k].polygon[1];
      const next = walls[(k + 1) % walls.length].polygon[0];
      expect(end[0]).toBeCloseTo(next[0], 6);
      expect(end[1]).toBeCloseTo(next[1], 6);
    }
  });
});

describe('facing と透明度', () => {
  it('facing は法線とカメラ向きの内積（-1〜1）', () => {
    expect(facing([1, 0], [1, 0])).toBe(1);
    expect(facing([-1, 0], [1, 0])).toBe(-1);
    expect(facing([0, 1], [1, 0])).toBeCloseTo(0, 12);
  });

  it('輪郭に近いほど濃く、真正面・真後ろの中央ほど薄い。奥の壁のほうが手前の壁より濃い', () => {
    expect(wallAlpha(0)).toBeGreaterThan(wallAlpha(0.5));
    expect(wallAlpha(0.5)).toBeGreaterThan(wallAlpha(1));
    expect(wallAlpha(-0.5)).toBeGreaterThan(wallAlpha(-1));
    expect(wallAlpha(-0.5)).toBeGreaterThan(wallAlpha(0.5));
  });

  it('中のデータが読める薄さ：正面の中央は透明度 2% 以下、どの面も 30% 以下', () => {
    expect(wallAlpha(1) / 255).toBeLessThanOrEqual(0.02);
    for (let f = -1; f <= 1; f += 0.05) expect(wallAlpha(f) / 255).toBeLessThanOrEqual(0.3);
  });

  it('色は 0〜255 の整数', () => {
    for (const v of wallColor(0.3)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(255);
    }
  });
});

describe('towardCamera（カメラ側の判定）', () => {
  const size = { width: 800, height: 600 };
  it.each([0, 45, 90, 135, 200, -60, 330])('rotationOrbit %d 度で、向きに動いた点は画面の下へ動く', (orbit) => {
    const [tx, ty] = towardCamera(orbit);
    expect(Math.hypot(tx, ty)).toBeCloseTo(1, 9);
    const vs = { target: [0, 0, 0] as [number, number, number], rotationX: 30, rotationOrbit: orbit, zoom: -6 };
    const near = projectPoint(vs, size, [tx * 1000, ty * 1000, 0]);
    const far = projectPoint(vs, size, [-tx * 1000, -ty * 1000, 0]);
    expect(near[1]).toBeGreaterThan(far[1]); // 手前ほど画面の下
    // 水平方向（画面の横）のずれはない
    expect(near[0]).toBeCloseTo(far[0], 6);
  });
});

describe('silhouettePoints', () => {
  it('カメラの向きに垂直な、円の左右の端', () => {
    const toward: [number, number] = [0, 1];
    const [a, b] = silhouettePoints(circle, toward);
    expect(a[1]).toBeCloseTo(circle.y, 9);
    expect(b[1]).toBeCloseTo(circle.y, 9);
    expect(Math.abs(a[0] - b[0])).toBeCloseTo(2 * circle.r, 6);
    for (const p of [a, b]) expect(facing([(p[0] - circle.x) / circle.r, (p[1] - circle.y) / circle.r], toward)).toBeCloseTo(0, 9);
  });
});

describe('pillarSpan / pillarMatrix', () => {
  it('段が2枚以上あり、離れているときだけ高さの範囲を返す', () => {
    expect(pillarSpan([])).toBeNull();
    expect(pillarSpan([0])).toBeNull(); // 単独表示（段が1枚）
    expect(pillarSpan([0, 0, 0, 0, 0])).toBeNull(); // 間隔 0
    expect(pillarSpan([3000, 12000, 0])).toEqual({ zMin: 0, zMax: 12000 });
  });

  it('単位の高さの側面を zMin〜zMax に写す', () => {
    const m = pillarMatrix(3000, 15000);
    // 列優先：z' = m[10]·z + m[14]
    expect(m[10] * 0 + m[14]).toBe(3000);
    expect(m[10] * 1 + m[14]).toBe(15000);
    expect(m).toHaveLength(16);
  });
});
