import { OrbitView } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';
import { EXTENT, LAYER_IDS } from '../config';
import { inExtent, intersectHorizontalPlane, pickProbePoint, rayFromPixel } from './ray';
import type { Plane } from './ray';

const W = 1000;
const H = 700;

function makeViewport(rotationOrbit = 30, rotationX = 45, zoom = Math.log2(480 / 36000)) {
  const vp = new OrbitView({ orthographic: true }).makeViewport({
    width: W,
    height: H,
    viewState: { target: [-1000, -1000, 10000], rotationX, rotationOrbit, zoom },
  });
  if (!vp) throw new Error('viewport を作れません');
  return vp;
}

/** 下から 0, 5000, ... の5段。上の段が先頭。 */
function planes(spacing: number): Plane[] {
  return LAYER_IDS.map((id, i) => ({ id, z: i * spacing })).reverse();
}

describe('rayFromPixel / intersectHorizontalPlane', () => {
  const views = [
    [30, 45],
    [120, 45],
    [-70, 30],
    [0, 60],
  ] as const;

  it('方向は単位ベクトルで、どの画素でも同じ', () => {
    const vp = makeViewport();
    const a = rayFromPixel(vp, 100, 100);
    const b = rayFromPixel(vp, 800, 600);
    expect(Math.hypot(...a.dir)).toBeCloseTo(1, 12);
    for (let i = 0; i < 3; i++) expect(a.dir[i]).toBeCloseTo(b.dir[i], 9);
  });

  it.each(views)('交点を project で戻すと元の画素に一致する（ro=%d, rx=%d）', (ro, rx) => {
    const vp = makeViewport(ro, rx);
    for (const [px, py] of [
      [500, 350],
      [120, 80],
      [900, 620],
      [333.5, 512.25],
    ]) {
      const ray = rayFromPixel(vp, px, py);
      for (const z of [0, 5000, 20000]) {
        const hit = intersectHorizontalPlane(ray, z)!;
        const [bx, by] = vp.project([hit.x, hit.y, z]);
        expect(bx).toBeCloseTo(px, 4);
        expect(by).toBeCloseTo(py, 4);
      }
    }
  });

  it('真横から見て水平面と平行な視線は null', () => {
    const vp = makeViewport(30, 0);
    const ray = rayFromPixel(vp, 500, 350);
    expect(intersectHorizontalPlane(ray, 0)).toBeNull();
  });
});

describe('pickProbePoint', () => {
  it('既知の点 (1000,-1000) を各段で project した画素から、その段と地点を取り戻す', () => {
    const vp = makeViewport();
    const ps = planes(5000);
    // 最上段だけを渡して、その段の画素から元の地点が戻ること
    for (const p of ps) {
      const [px, py] = vp.project([1000, -1000, p.z]);
      const hit = pickProbePoint(vp, px, py, [p])!;
      expect(hit.layerId).toBe(p.id);
      expect(hit.x).toBeCloseTo(1000, 3);
      expect(hit.y).toBeCloseTo(-1000, 3);
    }
  });

  it('上の段が優先される（同じ画素が複数の段の範囲内に当たるとき）', () => {
    const vp = makeViewport();
    const ps = planes(1000);
    // 最上段の (0, 0) を通る画素。下の段との交点も範囲内になることを確かめてから、最上段が選ばれることを見る
    const [px, py] = vp.project([0, 0, ps[0].z]);
    const ray = rayFromPixel(vp, px, py);
    for (const p of ps.slice(1)) {
      const h = intersectHorizontalPlane(ray, p.z)!;
      expect(h.x >= EXTENT.minX && h.x <= EXTENT.maxX && h.y >= EXTENT.minY && h.y <= EXTENT.maxY).toBe(true);
    }
    const hit = pickProbePoint(vp, px, py, ps)!;
    expect(hit.layerId).toBe('shelters');
    expect(hit.x).toBeCloseTo(0, 3);
    expect(hit.y).toBeCloseTo(0, 3);
    // 最上段を外すと、次の段（transit）の交点が選ばれる
    const second = pickProbePoint(vp, px, py, ps.slice(1))!;
    expect(second.layerId).toBe('transit');
    expect(Math.hypot(second.x, second.y)).toBeGreaterThan(500);
    // 間隔0（全段が同じ高さ）では先頭の段が採用される
    expect(pickProbePoint(vp, px, py, planes(0))!.layerId).toBe('shelters');
  });

  it('上の段が範囲外なら下の段へ落ちる', () => {
    const vp = makeViewport();
    const ps = planes(5000);
    // 最上段の平面の範囲外（左端の外）の画素：ちょうど最下段の範囲内に入る点を選ぶ
    const target = { x: EXTENT.minX + 500, y: EXTENT.minY + 500 };
    const [px, py] = vp.project([target.x, target.y, 0]);
    const upper = intersectHorizontalPlane(rayFromPixel(vp, px, py), 20000)!;
    // 上段の交点は範囲外になるシーンであることを確かめてから、下の段が選ばれることを確認する
    expect(upper.x < EXTENT.minX || upper.y < EXTENT.minY || upper.x > EXTENT.maxX || upper.y > EXTENT.maxY).toBe(true);
    const hit = pickProbePoint(vp, px, py, ps)!;
    expect(hit).not.toBeNull();
    expect(hit.layerId).not.toBe('shelters');
  });

  it('どの平面の範囲にも入らなければ null', () => {
    const vp = makeViewport();
    expect(pickProbePoint(vp, 2, 2, planes(5000))).toBeNull();
    expect(pickProbePoint(vp, W - 2, H - 2, planes(5000))).toBeNull();
    expect(pickProbePoint(vp, 500, 350, [])).toBeNull();
  });
});

describe('pickProbePoint（区の内側を優先する）', () => {
  // 視線の交点は段ごとに水平にずれる。上の段 (shelters) と最下段 (elevation) の交点を x の大小で区別する。
  const vp = makeViewport();
  const ps = planes(5000);
  const [px, py] = vp.project([0, 0, ps[ps.length - 1].z]); // 最下段の (0, 0) を通る画素
  const ray = rayFromPixel(vp, px, py);
  const hitOf = (id: string) => intersectHorizontalPlane(ray, ps.find((p) => p.id === id)!.z)!;
  const top = hitOf('shelters');
  const bottom = hitOf('elevation');

  const near = (a: { x: number; y: number }) => (x: number, y: number) => Math.hypot(x - a.x, y - a.y) < 1;

  it('シーンの前提：どの段の交点も EXTENT 内で、互いに離れている', () => {
    for (const p of ps) {
      const h = intersectHorizontalPlane(ray, p.z)!;
      expect(inExtent(h.x, h.y)).toBe(true);
    }
    expect(Math.hypot(top.x - bottom.x, top.y - bottom.y)).toBeGreaterThan(1000);
  });

  it('上の段の交点が区の外で、下の段の交点が区の中なら、下の段を採用する', () => {
    const hit = pickProbePoint(vp, px, py, ps, near(bottom))!;
    expect(hit.layerId).toBe('elevation');
    expect(hit.x).toBeCloseTo(0, 3);
    expect(hit.y).toBeCloseTo(0, 3);
  });

  it('途中の段だけが区の中なら、その段を採用する', () => {
    const mid = hitOf('population');
    const hit = pickProbePoint(vp, px, py, ps, near(mid))!;
    expect(hit.layerId).toBe('population');
    expect(hit.x).toBeCloseTo(mid.x, 6);
  });

  it('両方が区の中なら、上の段を採用する', () => {
    const hit = pickProbePoint(vp, px, py, ps, () => true)!;
    expect(hit.layerId).toBe('shelters');
    expect(hit.x).toBeCloseTo(top.x, 6);
  });

  it('どの段も区の外なら、描画範囲に入った最初（上）の段を採用する', () => {
    const hit = pickProbePoint(vp, px, py, ps, () => false)!;
    expect(hit.layerId).toBe('shelters');
    // 上の段が範囲外の画素では、範囲に入った上から最初の段になる
    const [qx, qy] = vp.project([EXTENT.minX + 500, EXTENT.minY + 500, 0]);
    const expected = pickProbePoint(vp, qx, qy, ps)!;
    expect(pickProbePoint(vp, qx, qy, ps, () => false)).toEqual(expected);
  });

  it('判定関数がない（区境界が未読み込み）ときは従来どおり', () => {
    expect(pickProbePoint(vp, px, py, ps, null)!.layerId).toBe('shelters');
    expect(pickProbePoint(vp, px, py, ps, undefined)!.layerId).toBe('shelters');
  });

  it('区の中の段がなく、どれも範囲外なら null', () => {
    expect(pickProbePoint(vp, 2, 2, ps, () => true)).toBeNull();
  });
});
