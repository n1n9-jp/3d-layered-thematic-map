import { describe, expect, it } from 'vitest';
import {
  Mask,
  clipRingToBox,
  distanceToLand,
  distanceToRings,
  midpointOf,
  nameWaterCells,
  nearestWaterCell,
  pointInRings,
  polygonArea,
  ringPerimeter,
  signedArea,
  simplifyRing,
  splitByGrid,
} from './rivers.mjs';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

describe('面積と周長', () => {
  it('signedArea は反時計回りが正', () => {
    expect(signedArea(square(0, 0, 10, 5))).toBe(50);
    expect(signedArea([...square(0, 0, 10, 5)].reverse())).toBe(-50);
  });
  it('polygonArea は、最初のリングと同じ向きを足し、逆向き（穴）を引く', () => {
    const outer = square(0, 0, 10, 10);
    const hole = [...square(2, 2, 4, 4)].reverse();
    expect(polygonArea([outer, hole])).toBe(100 - 4);
    expect(polygonArea([[...outer].reverse(), square(2, 2, 4, 4)])).toBe(100 - 4);
    expect(polygonArea([])).toBe(0);
  });
  it('ringPerimeter は周長の合計', () => {
    expect(ringPerimeter([square(0, 0, 10, 5)])).toBe(30);
    expect(ringPerimeter([square(0, 0, 10, 5), square(0, 0, 1, 1)])).toBe(34);
  });
});

describe('clipRingToBox', () => {
  it('長方形の中に収まるリングはそのまま', () => {
    const ring = square(1, 1, 3, 3);
    const out = clipRingToBox(ring, 0, 0, 10, 10);
    expect(Math.abs(signedArea(out))).toBe(4);
  });
  it('はみ出す部分を切り落とす（面積が合う）', () => {
    const out = clipRingToBox(square(-5, -5, 5, 5), 0, 0, 10, 10);
    expect(Math.abs(signedArea(out))).toBe(25);
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });
  it('閉じたリングを返す。重ならなければ null', () => {
    const out = clipRingToBox(square(-5, -5, 5, 5), 0, 0, 10, 10);
    expect(out[0]).toEqual(out[out.length - 1]);
    expect(clipRingToBox(square(20, 20, 30, 30), 0, 0, 10, 10)).toBeNull();
  });
  it('縦に長い川が枠を横切るとき、枠の縁に載った辺ができる（継ぎ目の判定に使う）', () => {
    const out = clipRingToBox([[2, -10], [4, -10], [4, 20], [2, 20], [2, -10]], 0, 0, 10, 10);
    expect(out.some(([, y]) => y === 0)).toBe(true);
    expect(out.some(([, y]) => y === 10)).toBe(true);
  });
});

describe('simplifyRing', () => {
  it('直線上の点を間引く', () => {
    const ring = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = simplifyRing(ring, 0.5);
    expect(out).toHaveLength(5);
    expect(Math.abs(signedArea(out))).toBe(100);
  });
  it('許容誤差より大きく外れる点は残す', () => {
    const ring = [[0, 0], [5, 3], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyRing(ring, 1).some(([x, y]) => x === 5 && y === 3)).toBe(true);
    expect(simplifyRing(ring, 5).some(([x, y]) => x === 5 && y === 3)).toBe(false);
  });
  it('固定した点（枠に載った点）は、誤差の内でも残す', () => {
    const ring = [[0, 0], [5, 0.1], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = simplifyRing(ring, 1, ([x]) => x === 5);
    expect(out.some(([x]) => x === 5)).toBe(true);
  });
  it('3 点未満になるものは null', () => {
    expect(simplifyRing([[0, 0], [1, 0], [0, 0]], 1)).toBeNull();
  });
});

describe('点と面', () => {
  const rings = [square(0, 0, 10, 10), [...square(4, 4, 6, 6)].reverse()];
  it('pointInRings は穴の中を外とする', () => {
    expect(pointInRings([2, 2], rings)).toBe(true);
    expect(pointInRings([5, 5], rings)).toBe(false);
    expect(pointInRings([20, 5], rings)).toBe(false);
  });
  it('distanceToRings は最も近い辺までの距離', () => {
    expect(distanceToRings([15, 5], rings)).toBe(5);
    expect(distanceToRings([5, 5], rings)).toBe(1);
  });
  it('midpointOf は長さに沿った真ん中', () => {
    expect(midpointOf([[0, 0], [10, 0]])).toEqual([5, 0]);
    expect(midpointOf([[0, 0], [10, 0], [10, 10]])).toEqual([10, 0]);
  });
});

describe('Mask：格子に塗って、つながりを求める', () => {
  const mask = () => new Mask(0, 0, 10, 40, 40);
  it('面を塗り、つながった水のまとまりに番号を振る（離れたものは別）', () => {
    const m = mask();
    m.paint([square(20, 20, 120, 60)]);
    m.paint([square(300, 300, 380, 380)]);
    const { labels, count } = m.label();
    expect(count).toBe(2);
    expect(labels[m.cellOf(50, 40)]).not.toBe(0);
    expect(labels[m.cellOf(50, 40)]).not.toBe(labels[m.cellOf(340, 340)]);
  });
  it('1 セルより細い面も、辺のセルがつながるので1つのまとまりになる', () => {
    const m = mask();
    m.paint([[[10, 10], [300, 10], [300, 14], [10, 14], [10, 10]]]);
    expect(m.label().count).toBe(1);
  });
  it('隣り合う面（共有する辺）は、つながる', () => {
    const m = mask();
    m.paint([square(10, 10, 100, 50)]);
    m.paint([square(100, 10, 200, 50)]);
    expect(m.label().count).toBe(1);
  });
  it('穴の中は水でない', () => {
    const m = mask();
    m.paint([square(10, 10, 300, 300), [...square(100, 100, 200, 200)].reverse()]);
    expect(m.data[m.cellOf(150, 150)]).toBe(0);
    expect(m.data[m.cellOf(50, 50)]).toBe(1);
  });
});

describe('distanceToLand', () => {
  it('水のセルから、水でないセルまでの距離（川幅の目安）', () => {
    const m = new Mask(0, 0, 10, 30, 15);
    m.paint([square(0, 30, 300, 120)]); // 行 3〜11 が水
    const d = distanceToLand(m);
    // 帯の真ん中の行は、端の行より遠い。水でないセルは 0
    expect(d[7 * 30 + 15]).toBeGreaterThan(d[3 * 30 + 15]);
    expect(d[7 * 30 + 15]).toBeGreaterThanOrEqual(40);
    expect(d[0 * 30 + 15]).toBe(0);
  });
});

describe('名前を水に沿って伝える', () => {
  // 横に長い川（A）と、その真ん中から北へ出る支流（B）。Aの両端に起点 a0・a1、Bの先に起点 b。
  const build = () => {
    const m = new Mask(0, 0, 10, 100, 60);
    m.paint([square(0, 200, 1000, 230)]); // 本流
    m.paint([square(490, 230, 510, 560)]); // 支流
    const { labels } = m.label();
    const allowed = new Set([labels[m.cellOf(10, 210)]]);
    return { m, labels, allowed };
  };
  it('水に沿って近い起点の名前になる（空間の近さではなく、水に沿った距離）', () => {
    const { m, labels, allowed } = build();
    const a0 = nearestWaterCell(m, labels, allowed, 20, 215, 30);
    const a1 = nearestWaterCell(m, labels, allowed, 980, 215, 30);
    const b = nearestWaterCell(m, labels, allowed, 500, 540, 30);
    expect([a0, a1, b].every((c) => c !== null)).toBe(true);
    const owner = nameWaterCells(m, labels, allowed, [a0, a1, b], 5000);
    expect(owner[m.cellOf(100, 215)]).toBe(0);
    expect(owner[m.cellOf(900, 215)]).toBe(1);
    expect(owner[m.cellOf(500, 450)]).toBe(2);
  });
  it('遠すぎる水には名前を付けない', () => {
    const { m, labels, allowed } = build();
    const a0 = nearestWaterCell(m, labels, allowed, 20, 215, 30);
    const owner = nameWaterCells(m, labels, allowed, [a0], 300);
    expect(owner[m.cellOf(900, 215)]).toBe(-1);
  });
  it('細い水路の1歩を長く数える倍率（stepCost）で、広い川の名前が細い支流へ伝わりにくくなる', () => {
    const { m, labels, allowed } = build();
    const a0 = nearestWaterCell(m, labels, allowed, 20, 215, 30);
    const free = nameWaterCells(m, labels, allowed, [a0], 5000);
    const costly = nameWaterCells(m, labels, allowed, [a0], 5000, () => 100);
    const far = m.cellOf(500, 540);
    expect(free[far]).toBe(0);
    expect(costly[far]).toBe(-1);
  });
  it('nearestWaterCell は、近くに水がなければ null', () => {
    const { m, labels, allowed } = build();
    expect(nearestWaterCell(m, labels, allowed, 900, 500, 50)).toBeNull();
  });
});

describe('splitByGrid', () => {
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  it('1つの格子に収まる面は、そのまま', () => {
    const rings = [sq(10, 10, 900, 400)];
    expect(splitByGrid(rings, 1000)).toEqual([rings]);
  });
  it('格子をまたぐ面は、格子ごとの面に切り分ける（面積の合計は変わらない。切り口は格子の線の上の整数座標）', () => {
    const rings = [sq(500, 200, 2500, 800)];
    const out = splitByGrid(rings, 1000);
    expect(out).toHaveLength(3);
    expect(out.reduce((s, p) => s + Math.abs(signedArea(p[0])), 0)).toBe(2000 * 600);
    for (const p of out) for (const [x, y] of p[0]) expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    // 隣り合う面は、格子の線 x=1000 の上に、同じ辺をもつ
    const onLine = (ring) => new Set(ring.filter(([x]) => x === 1000).map(([, y]) => y));
    expect([...onLine(out[0][0])].sort()).toEqual([200, 800]);
    expect([...onLine(out[1][0])].sort()).toEqual([200, 800]);
  });
  it('1つの格子に収まる穴は、その格子の面に付ける。格子をまたぐ穴は落とす', () => {
    const inner = [...sq(600, 300, 700, 400)].reverse();
    const across = [...sq(950, 300, 1050, 400)].reverse();
    const out = splitByGrid([sq(500, 200, 2500, 800), inner, across], 1000);
    expect(out[0]).toHaveLength(2);
    expect(out.slice(1).every((p) => p.length === 1)).toBe(true);
  });
  it('負の座標でも、格子の線で切る', () => {
    const out = splitByGrid([sq(-1500, -200, 500, 200)], 1000); // 3 列 × 2 行（y = 0 の線でも切る）
    expect(out).toHaveLength(6);
    expect(out.reduce((s, p) => s + Math.abs(signedArea(p[0])), 0)).toBe(2000 * 400);
  });
});
