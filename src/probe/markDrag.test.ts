import { OrbitView } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';
import { EXTENT } from '../config';
import { createFrameThrottle, dragProbePoint, hitProbeMark, RING_RADIUS_PX } from './markDrag';

function makeViewport(rotationOrbit = 45, rotationX = 30, zoom = -6.5) {
  const vp = new OrbitView({ orthographic: true }).makeViewport({
    width: 1000,
    height: 700,
    viewState: { target: [-1000, -1000, 24000], rotationX, rotationOrbit, zoom },
  });
  if (!vp) throw new Error('viewport を作れません');
  return vp;
}

const ZS = [0, 12000, 24000, 36000, 48000];
const probe = { x: 1500, y: 100 };

describe('hitProbeMark', () => {
  const vp = makeViewport();
  const project = (p: [number, number, number]) => vp.project(p);
  const at = (z: number) => project([probe.x, probe.y, z]);

  it('輪の中心にカーソルがあれば、その段をつかむ。ずれは 0', () => {
    for (const z of ZS) {
      const [px, py] = at(z);
      const g = hitProbeMark({ project, probe, zs: ZS, px, py });
      expect(g?.z).toBe(z);
      expect(g?.offset[0]).toBeCloseTo(0, 9);
      expect(g?.offset[1]).toBeCloseTo(0, 9);
    }
  });
  it('輪の縁の近く（半径 + 4 px 以内）はつかめて、それより外はつかめない', () => {
    const [px, py] = at(24000);
    expect(hitProbeMark({ project, probe, zs: ZS, px: px + RING_RADIUS_PX + 3, py })?.z).toBe(24000);
    // 垂直線からも輪からも離れた横方向
    expect(hitProbeMark({ project, probe, zs: ZS, px: px + RING_RADIUS_PX + 12, py })).toBeNull();
  });
  it('垂直線の上（段の間）なら、画面でいちばん近い輪の段をつかむ。つかんだ位置から輪の中心までのずれを返す', () => {
    const [x1, y1] = at(12000);
    const [x2, y2] = at(24000);
    // 12000 の輪に 1/4 寄った点
    const px = x1 + (x2 - x1) * 0.25;
    const py = y1 + (y2 - y1) * 0.25;
    const g = hitProbeMark({ project, probe, zs: ZS, px, py });
    expect(g?.z).toBe(12000);
    expect(px + (g?.offset[0] ?? NaN)).toBeCloseTo(x1, 9);
    expect(py + (g?.offset[1] ?? NaN)).toBeCloseTo(y1, 9);
    // 3/4 のところは 24000 の輪が近い
    const g2 = hitProbeMark({ project, probe, zs: ZS, px: x1 + (x2 - x1) * 0.75, py: y1 + (y2 - y1) * 0.75 });
    expect(g2?.z).toBe(24000);
  });
  it('垂直線から 6 px 以内はつかめて、離れるとつかめない', () => {
    const [x1, y1] = at(12000);
    const [x2, y2] = at(24000);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    // 線に垂直な向き
    const len = Math.hypot(x2 - x1, y2 - y1);
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    expect(hitProbeMark({ project, probe, zs: ZS, px: mx + nx * 5, py: my + ny * 5 })).not.toBeNull();
    expect(hitProbeMark({ project, probe, zs: ZS, px: mx + nx * 9, py: my + ny * 9 })).toBeNull();
  });
  it('段が1つなら輪だけ（垂直線はない）', () => {
    const [px, py] = at(0);
    expect(hitProbeMark({ project, probe, zs: [0], px, py })?.z).toBe(0);
    expect(hitProbeMark({ project, probe, zs: [0], px: px + 40, py })).toBeNull();
  });
  it('段がなければつかめない', () => {
    expect(hitProbeMark({ project, probe, zs: [], px: 500, py: 350 })).toBeNull();
  });
  it('印から離れた場所はつかめない（視点の回転になる）', () => {
    expect(hitProbeMark({ project, probe, zs: ZS, px: 20, py: 20 })).toBeNull();
  });
});

describe('dragProbePoint', () => {
  for (const [ro, rx] of [[45, 30], [0, 60], [-120, 20], [200, 90]] as const) {
    const vp = makeViewport(ro, rx);
    const project = (p: [number, number, number]) => vp.project(p);
    it(`ro=${ro} rx=${rx}: つかんだ位置のまま動かさなければ、地点は動かない`, () => {
      for (const z of [0, 24000, 48000]) {
        const [px, py] = project([probe.x, probe.y, z]);
        const grab = hitProbeMark({ project, probe, zs: ZS, px: px + 3, py: py - 2 });
        expect(grab).not.toBeNull();
        const p = dragProbePoint(vp, px + 3, py - 2, grab!);
        expect(p?.x).toBeCloseTo(probe.x, 4);
        expect(p?.y).toBeCloseTo(probe.y, 4);
      }
    });
    it(`ro=${ro} rx=${rx}: カーソルを動かすと、印がその段の平面の上でカーソルに付いてくる（ずれを保つ）`, () => {
      const z = 24000;
      const [px, py] = project([probe.x, probe.y, z]);
      const grab = hitProbeMark({ project, probe, zs: ZS, px: px + 4, py: py + 4 })!;
      const p = dragProbePoint(vp, px + 4 + 60, py + 4 - 30, grab)!;
      // 新しい地点を同じ段へ投影すると、ずれのぶんだけ離れたカーソルの位置と一致する
      const [qx, qy] = project([p.x, p.y, z]);
      expect(qx).toBeCloseTo(px + 60, 3);
      expect(qy).toBeCloseTo(py - 30, 3);
    });
  }
  it('描画範囲の外へは出ない', () => {
    const vp = makeViewport(45, 30);
    const grab = { z: 0, offset: [0, 0] as [number, number] };
    const p = dragProbePoint(vp, -5000, -5000, grab)!;
    expect(p.x).toBeGreaterThanOrEqual(EXTENT.minX);
    expect(p.x).toBeLessThanOrEqual(EXTENT.maxX);
    expect(p.y).toBeGreaterThanOrEqual(EXTENT.minY);
    expect(p.y).toBeLessThanOrEqual(EXTENT.maxY);
  });
});

describe('createFrameThrottle', () => {
  function fakeRaf() {
    const queue = new Map<number, () => void>();
    let next = 1;
    return {
      raf: (cb: () => void) => {
        queue.set(next, cb);
        return next++;
      },
      caf: (id: number) => void queue.delete(id),
      frame: () => {
        const cbs = [...queue.values()];
        queue.clear();
        cbs.forEach((cb) => cb());
      },
      size: () => queue.size,
    };
  }
  it('1フレームのあいだに何度 push しても、フレームごとに最後の値で1回だけ適用する', () => {
    const f = fakeRaf();
    const got: number[] = [];
    const t = createFrameThrottle<number>((v) => got.push(v), f.raf, f.caf);
    t.push(1);
    t.push(2);
    t.push(3);
    expect(got).toEqual([]);
    expect(f.size()).toBe(1);
    f.frame();
    expect(got).toEqual([3]);
    t.push(4);
    f.frame();
    f.frame();
    expect(got).toEqual([3, 4]);
  });
  it('flush は、待っている値をすぐ適用し、予約を取り消す', () => {
    const f = fakeRaf();
    const got: number[] = [];
    const t = createFrameThrottle<number>((v) => got.push(v), f.raf, f.caf);
    t.push(7);
    t.flush();
    expect(got).toEqual([7]);
    expect(f.size()).toBe(0);
    t.flush();
    expect(got).toEqual([7]);
  });
  it('cancel は、待っている値を捨てる', () => {
    const f = fakeRaf();
    const got: number[] = [];
    const t = createFrameThrottle<number>((v) => got.push(v), f.raf, f.caf);
    t.push(1);
    t.cancel();
    f.frame();
    expect(got).toEqual([]);
  });
});
