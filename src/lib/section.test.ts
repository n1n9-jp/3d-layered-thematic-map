import { describe, expect, it } from 'vitest';
import type { SectionLine } from '../types';
import {
  createBoxIndex,
  intersectLineSegment,
  isUsableLine,
  lineInsideCircle,
  lineInsideRing,
  lineLength,
  lineTouchesBox,
  pointAt,
  projectOnLine,
  reverseLine,
} from './section';

const L = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });

describe('lineLength / pointAt / reverseLine', () => {
  it('3-4-5 の線は長さ 5。長さ 0 は使えない線', () => {
    expect(lineLength(L(0, 0, 3, 4))).toBe(5);
    expect(lineLength(L(1, 1, 1, 1))).toBe(0);
    expect(isUsableLine(L(0, 0, 3, 4))).toBe(true);
    expect(isUsableLine(L(1, 1, 1, 1))).toBe(false);
    expect(isUsableLine(L(0, 0, NaN, 4))).toBe(false);
  });
  it('距離から地点を求める。線の外は延長線上', () => {
    const line = L(0, 0, 30, 40);
    expect(pointAt(line, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(line, 25)).toEqual({ x: 15, y: 20 });
    expect(pointAt(line, 50)).toEqual({ x: 30, y: 40 });
    expect(pointAt(line, 100)).toEqual({ x: 60, y: 80 });
    expect(pointAt(L(5, 6, 5, 6), 10)).toEqual({ x: 5, y: 6 });
  });
  it('向きを逆にすると始点と終点が入れ替わる', () => {
    expect(reverseLine(L(1, 2, 3, 4))).toEqual(L(3, 4, 1, 2));
  });
});

describe('projectOnLine', () => {
  const east = L(0, 0, 100, 0);
  it('東向きの線では、北が左（正）、南が右（負）', () => {
    expect(projectOnLine(east, 30, 20)).toMatchObject({ d: 30, offset: 20, x: 30, y: 0 });
    expect(projectOnLine(east, 30, -20)).toMatchObject({ d: 30, offset: -20, x: 30, y: 0 });
  });
  it('線の上は offset 0。始点より手前は d が負、終点の先は長さを超える', () => {
    expect(projectOnLine(east, 40, 0)).toMatchObject({ d: 40, offset: 0 });
    expect(projectOnLine(east, -10, 5)!.d).toBe(-10);
    expect(projectOnLine(east, 130, 5)!.d).toBe(130);
  });
  it('斜めの線でも、足は線の上にあり、距離は垂線の長さ', () => {
    const line = L(0, 0, 30, 40); // 長さ 50。方向 (0.6, 0.8)。左は (-0.8, 0.6)
    const p = projectOnLine(line, -8, 6)!; // 左に 10
    expect(p.d).toBeCloseTo(0, 9);
    expect(p.offset).toBeCloseTo(10, 9);
    const q = projectOnLine(line, 30 + 8, 40 - 6)!; // 終点から右に 10
    expect(q.d).toBeCloseTo(50, 9);
    expect(q.offset).toBeCloseTo(-10, 9);
    expect(Math.hypot(q.x - 38, q.y - 34)).toBeCloseTo(10, 9);
  });
  it('長さ 0 の線は null', () => {
    expect(projectOnLine(L(1, 1, 1, 1), 5, 5)).toBeNull();
  });
  it('向きを逆にすると d は「長さ − d」、offset は符号が逆になる', () => {
    const line = L(10, -20, 400, 310);
    const len = lineLength(line);
    for (const [x, y] of [[50, 50], [200, -100], [-30, 40], [500, 400]]) {
      const f = projectOnLine(line, x, y)!;
      const r = projectOnLine(reverseLine(line), x, y)!;
      expect(r.d).toBeCloseTo(len - f.d, 9);
      expect(r.offset).toBeCloseTo(-f.offset, 9);
      expect(r.x).toBeCloseTo(f.x, 9);
      expect(r.y).toBeCloseTo(f.y, 9);
    }
  });
});

describe('intersectLineSegment', () => {
  it('十字に交わる点と、線に沿った距離・線分上の位置', () => {
    const hit = intersectLineSegment(L(0, 0, 100, 0), 30, -10, 30, 10)!;
    expect(hit).toMatchObject({ d: 30, u: 0.5, x: 30, y: 0 });
  });
  it('線分が線の範囲の外、または線分の範囲の外なら交わらない', () => {
    expect(intersectLineSegment(L(0, 0, 100, 0), 130, -10, 130, 10)).toBeNull(); // 線の延長上
    expect(intersectLineSegment(L(0, 0, 100, 0), 30, 5, 30, 10)).toBeNull(); // 線分が届かない
  });
  it('平行・同一直線上は null', () => {
    expect(intersectLineSegment(L(0, 0, 100, 0), 0, 5, 100, 5)).toBeNull();
    expect(intersectLineSegment(L(0, 0, 100, 0), 20, 0, 60, 0)).toBeNull();
  });
  it('端点を含む（線の始点・終点、線分の始点・終点）', () => {
    expect(intersectLineSegment(L(0, 0, 100, 0), 0, -5, 0, 5)).toMatchObject({ d: 0, u: 0.5 });
    expect(intersectLineSegment(L(0, 0, 100, 0), 100, -5, 100, 5)).toMatchObject({ d: 100 });
    expect(intersectLineSegment(L(0, 0, 100, 0), 50, 0, 50, 8)).toMatchObject({ d: 50, u: 0 });
    expect(intersectLineSegment(L(0, 0, 100, 0), 50, -8, 50, 0)).toMatchObject({ d: 50, u: 1 });
  });
  it('向きを逆にすると d は「長さ − d」で、交点の地点は同じ', () => {
    const line = L(0, 0, 100, 60);
    const f = intersectLineSegment(line, 40, 0, 20, 80)!;
    const r = intersectLineSegment(reverseLine(line), 40, 0, 20, 80)!;
    expect(r.d).toBeCloseTo(lineLength(line) - f.d, 9);
    expect(r.x).toBeCloseTo(f.x, 9);
    expect(r.y).toBeCloseTo(f.y, 9);
  });
});

describe('lineInsideRing', () => {
  const square = [[10, -5], [30, -5], [30, 5], [10, 5], [10, -5]] as [number, number][];
  it('正方形を横切る区間を、線に沿った距離で返す', () => {
    expect(lineInsideRing(L(0, 0, 100, 0), square)).toEqual([[10, 30]]);
  });
  it('始点が内側にあれば d = 0 から、終点が内側ならその終点まで', () => {
    expect(lineInsideRing(L(20, 0, 100, 0), square)).toEqual([[0, 10]]);
    expect(lineInsideRing(L(0, 0, 20, 0), square)).toEqual([[10, 20]]);
    expect(lineInsideRing(L(15, 0, 25, 0), square)).toEqual([[0, 10]]);
  });
  it('通らない線は空。向きを逆にすると区間も反転する', () => {
    expect(lineInsideRing(L(0, 20, 100, 20), square)).toEqual([]);
    expect(lineInsideRing(L(100, 0, 0, 0), square)).toEqual([[70, 90]]);
  });
  it('頂点を通る線を二重に数えない（頂点の真上を通る、辺に重なる）', () => {
    // 頂点 (10, 5) と (30, 5) の上を通る線は、辺に重なる。上辺の上を通る線は内側か外側のどちらか一方
    const through = lineInsideRing(L(0, 5, 100, 5), square);
    const total = through.reduce((s, [a, b]) => s + (b - a), 0);
    expect(total === 0 || Math.abs(total - 20) < 1e-9).toBe(true);
    // 頂点だけを通る斜めの線（正方形の角 (10,-5) から (30,5) へ）
    expect(lineInsideRing(L(10, -5, 30, 5), square)[0][1]).toBeCloseTo(Math.hypot(20, 10), 9);
  });
  it('凹んだ多角形では、区間が2つに分かれる', () => {
    // U 字（谷が上にある）：上の中央に切り込み
    const u = [[0, 0], [30, 0], [30, 10], [20, 10], [20, 4], [10, 4], [10, 10], [0, 10]] as [number, number][];
    expect(lineInsideRing(L(-5, 8, 35, 8), u)).toEqual([[5, 15], [25, 35]]);
  });
  it('長さ 0 の線・頂点が3つ未満は空', () => {
    expect(lineInsideRing(L(1, 1, 1, 1), square)).toEqual([]);
    expect(lineInsideRing(L(0, 0, 1, 0), [[0, 0], [1, 1]])).toEqual([]);
  });
});

describe('lineTouchesBox / lineInsideCircle', () => {
  const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  it('長方形と交わるか', () => {
    expect(lineTouchesBox(L(-5, 5, 15, 5), box)).toBe(true);
    expect(lineTouchesBox(L(-5, 20, 15, 20), box)).toBe(false);
    expect(lineTouchesBox(L(-5, 5, -1, 5), box)).toBe(false); // 届かない
    expect(lineTouchesBox(L(5, 5, 6, 6), box)).toBe(true); // 内側
    expect(lineTouchesBox(L(-5, 15, 15, -5), box)).toBe(true); // 斜めに角を通る
    expect(lineTouchesBox(L(10, -5, 10, 15), box)).toBe(true); // 縁の上
  });
  it('円の中の区間', () => {
    expect(lineInsideCircle(L(0, 0, 100, 0), 50, 0, 10)).toEqual([40, 60]);
    expect(lineInsideCircle(L(0, 0, 100, 0), 50, 20, 10)).toBeNull();
    expect(lineInsideCircle(L(45, 0, 100, 0), 50, 0, 10)![0]).toBe(0);
  });
});

/** 総当たりで、線から pad 以内の bbox（pad = 0 なら bbox と線が交わる）を持つ要素を数える。 */
function bruteNear(boxes: number[], line: SectionLine, pad: number): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < boxes.length / 4; i++) {
    const [x0, y0, x1, y1] = boxes.slice(4 * i, 4 * i + 4);
    // 線を pad だけ太らせたものと bbox の距離の代わりに、bbox を pad だけ広げて線と交わるかを見る（長方形の太らせ）
    if (lineTouchesBox(line, { minX: x0 - pad, minY: y0 - pad, maxX: x1 + pad, maxY: y1 + pad })) out.add(i);
  }
  return out;
}

describe('createBoxIndex', () => {
  // 疑似乱数（再現できるように固定）
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const boxes: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const x = rnd() * 10000;
    const y = rnd() * 10000;
    boxes.push(x, y, x + rnd() * 80, y + rnd() * 80);
  }
  const index = createBoxIndex(boxes, 200);

  it('線と交わる要素をすべて渡し、重複しない（全件は調べない）', () => {
    for (let k = 0; k < 40; k++) {
      const line = L(rnd() * 12000 - 1000, rnd() * 12000 - 1000, rnd() * 12000 - 1000, rnd() * 12000 - 1000);
      const got: number[] = [];
      index.near(line, 0, (i) => got.push(i));
      expect(new Set(got).size).toBe(got.length);
      for (const i of bruteNear(boxes, line, 0)) expect(got).toContain(i);
      expect(got.length).toBeLessThan(boxes.length / 4 / 3);
    }
  });
  it('pad を指定すると、線から pad 以内の要素を漏らさない', () => {
    for (let k = 0; k < 40; k++) {
      const line = L(rnd() * 10000, rnd() * 10000, rnd() * 10000, rnd() * 10000);
      const got = new Set<number>();
      index.near(line, 300, (i) => got.add(i));
      for (const i of bruteNear(boxes, line, 300)) expect(got.has(i)).toBe(true);
    }
  });
  it('真横・真縦・点の線、範囲の外の線でも動く', () => {
    const horizontal: number[] = [];
    index.near(L(0, 5000, 10000, 5000), 0, (i) => horizontal.push(i));
    for (const i of bruteNear(boxes, L(0, 5000, 10000, 5000), 0)) expect(horizontal).toContain(i);
    const vertical: number[] = [];
    index.near(L(5000, 0, 5000, 10000), 0, (i) => vertical.push(i));
    for (const i of bruteNear(boxes, L(5000, 0, 5000, 10000), 0)) expect(vertical).toContain(i);
    const none: number[] = [];
    index.near(L(-5000, -5000, -4000, -5000), 0, (i) => none.push(i));
    expect(none).toEqual([]);
    index.near(L(1, 1, 1, 1), 0, () => {}); // 落ちない
  });
  it('セルの境界ちょうどにある要素も取りこぼさない', () => {
    // セル 100 m、x = 200 ちょうどの縦の線分と、その上を通る線
    const idx = createBoxIndex([200, 0, 200, 50, 100, 100, 300, 100], 100);
    const got: number[] = [];
    idx.near(L(0, 25, 400, 25), 0, (i) => got.push(i));
    expect(got).toContain(0);
  });
  it('座標が有限でない要素は載せない。要素がなければ bounds は null', () => {
    const idx = createBoxIndex([0, 0, 10, 10, NaN, 0, 1, 1]);
    expect(idx.count).toBe(2);
    expect(idx.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const got: number[] = [];
    idx.near(L(-5, 5, 15, 5), 0, (i) => got.push(i));
    expect(got).toEqual([0]);
    expect(createBoxIndex([]).bounds).toBeNull();
  });
});
