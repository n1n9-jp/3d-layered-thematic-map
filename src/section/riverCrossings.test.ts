import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RiverData } from '../layers/rivers';
import type { Position, SectionLine } from '../types';
import { EXAMPLE_LINES } from './examples';
import { MERGE_GAP_M, NAME_RADIUS_M, SAME_NAME_GAP_M, computeRiverCrossings, riverIntervals, riverNameAt } from './riverCrossings';

const rect = (x0: number, y0: number, x1: number, y1: number): Position[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const boxOf = (rings: Position[][]): [number, number, number, number] => {
  const xs = rings[0].map((p) => p[0]);
  const ys = rings[0].map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
function rivers(polys: Position[][][], extra: Partial<RiverData> = {}): RiverData {
  return {
    polygons: polys,
    paths: polys.flat(),
    boxes: polys.map(boxOf),
    names: ['大川', '小川'],
    trunk: ['大川'],
    anchors: [],
    samples: [],
    ...extra,
  };
}
const line = (ax: number, ay: number, bx: number, by: number): SectionLine => ({ ax, ay, bx, by });

describe('riverIntervals', () => {
  it('線が面を横切る区間（線に沿った距離）を返す', () => {
    const r = rivers([[rect(100, -50, 300, 50)]]);
    expect(riverIntervals(r, line(0, 0, 1000, 0))).toEqual([{ d0: 100, d1: 300 }]);
  });
  it('向きが逆なら、距離は終点側から数える', () => {
    const r = rivers([[rect(100, -50, 300, 50)]]);
    expect(riverIntervals(r, line(1000, 0, 0, 0))).toEqual([{ d0: 700, d1: 900 }]);
  });
  it('面の中から始まる線は、始点（0）から数える。外へ終わる線は、終点（長さ）まで', () => {
    const r = rivers([[rect(-100, -50, 300, 50)]]);
    expect(riverIntervals(r, line(0, 0, 1000, 0))).toEqual([{ d0: 0, d1: 300 }]);
    const r2 = rivers([[rect(900, -50, 2000, 50)]]);
    expect(riverIntervals(r2, line(0, 0, 1000, 0))).toEqual([{ d0: 900, d1: 1000 }]);
  });
  it('穴（中の島）は川の中に数えない', () => {
    const hole = [...rect(180, -10, 220, 10)].reverse();
    const r = rivers([[rect(100, -50, 300, 50), hole]]);
    expect(riverIntervals(r, line(0, 0, 1000, 0))).toEqual([
      { d0: 100, d1: 180 },
      { d0: 220, d1: 300 },
    ]);
  });
  it('橋や継ぎ目で隣り合う面の区間は、1つにつなぐ。隙間が広ければ別', () => {
    const near = rivers([[rect(100, -50, 300, 50)], [rect(300 + MERGE_GAP_M - 1, -50, 500, 50)]]);
    expect(riverIntervals(near, line(0, 0, 1000, 0))).toEqual([{ d0: 100, d1: 500 }]);
    const far = rivers([[rect(100, -50, 300, 50)], [rect(300 + MERGE_GAP_M + 5, -50, 500, 50)]]);
    expect(riverIntervals(far, line(0, 0, 1000, 0))).toHaveLength(2);
  });
  it('斜めの線でも、交点の距離が合う', () => {
    const r = rivers([[rect(-1000, 100, 1000, 200)]]);
    const out = riverIntervals(r, line(0, 0, 0, 1000));
    expect(out).toEqual([{ d0: 100, d1: 200 }]);
    const diag = riverIntervals(r, line(0, 0, 1000, 1000));
    expect(diag[0].d0).toBeCloseTo(100 * Math.SQRT2, 6);
    expect(diag[0].d1).toBeCloseTo(200 * Math.SQRT2, 6);
  });
  it('頂点にちょうど当たる線でも、入りと出が対になる（偶数回）', () => {
    // ひし形の頂点 (100, 0) と (300, 0) を通る線
    const diamond: Position[] = [[100, 0], [200, 50], [300, 0], [200, -50], [100, 0]];
    const out = riverIntervals(rivers([[diamond]]), line(0, 0, 1000, 0));
    expect(out).toHaveLength(1);
    expect(out[0].d0).toBeCloseTo(100, 6);
    expect(out[0].d1).toBeCloseTo(300, 6);
  });
  it('線から離れた面は無視する。長さ 0 の線は空', () => {
    const r = rivers([[rect(100, 500, 300, 600)]]);
    expect(riverIntervals(r, line(0, 0, 1000, 0))).toEqual([]);
    expect(riverIntervals(r, line(5, 5, 5, 5))).toEqual([]);
  });
});

describe('riverNameAt / computeRiverCrossings', () => {
  const samples: [number, number, number][] = [[200, 0, 0], [700, 0, -1], [900, 0, 1]];
  const r = rivers([[rect(100, -50, 300, 50)], [rect(650, -50, 750, 50)], [rect(850, -50, 950, 50)]], { samples });
  it('いちばん近い標本の名前を返す。標本が遠ければ null。対象外の川（-1）の標本が近ければ null', () => {
    expect(riverNameAt(r, 210, 10)).toBe('大川');
    expect(riverNameAt(r, 700, 0)).toBeNull();
    expect(riverNameAt(r, 900, NAME_RADIUS_M + 1)).toBeNull();
    expect(riverNameAt(r, 900, 0)).toBe('小川');
  });
  it('横切る区間ごとに、名前と、幹となる川かを付ける', () => {
    const out = computeRiverCrossings(r, line(0, 0, 1000, 0));
    expect(out).toEqual([
      { d0: 100, d1: 300, name: '大川', trunk: true },
      { d0: 650, d1: 750, name: null, trunk: false },
      { d0: 850, d1: 950, name: '小川', trunk: false },
    ]);
  });
});

describe('同じ名前の川が近い隙間で続くとき', () => {
  const samples: [number, number, number][] = [[200, 0, 0], [450, 0, 0], [900, 0, 1]];
  const r = rivers([[rect(100, -50, 300, 50)], [rect(400, -50, 500, 50)], [rect(800, -50, 1000, 50)]], { samples });
  it('同じ名前は、隙間が小さければ（SAME_NAME_GAP_M 以下）1本にまとめる', () => {
    const out = computeRiverCrossings(r, line(0, 0, 1200, 0));
    expect(out[0]).toEqual({ d0: 100, d1: 500, name: '大川', trunk: true });
    expect(out[1].name).toBe('小川');
  });
  it('隙間が大きければ、別々のまま。名前のない区間は、まとめない', () => {
    const far = rivers([[rect(100, -50, 300, 50)], [rect(300 + SAME_NAME_GAP_M + 50, -50, 800, 50)]], { samples: [[200, 0, 0], [600, 0, 0]] });
    expect(computeRiverCrossings(far, line(0, 0, 1200, 0))).toHaveLength(2);
    const unnamed = rivers([[rect(100, -50, 300, 50)], [rect(340, -50, 500, 50)]]);
    expect(computeRiverCrossings(unnamed, line(0, 0, 1200, 0))).toHaveLength(2);
  });
});

describe('実データ：例の線が川を横切る位置', () => {
  const read = (f: string) => JSON.parse(readFileSync(path.join(__dirname, '../../public/data', f), 'utf8'));
  const fc = read('rivers.geojson') as { features: { geometry: { coordinates: Position[][] } }[] };
  const labels = read('river-labels.json') as Pick<RiverData, 'names' | 'trunk' | 'anchors' | 'samples'>;
  const polygons = fc.features.map((f) => f.geometry.coordinates);
  const data: RiverData = { polygons, paths: polygons.flat(), boxes: polygons.map(boxOf), ...labels };
  const names = (id: string) => {
    const e = EXAMPLE_LINES.find((x) => x.id === id)!;
    return computeRiverCrossings(data, e.line).map((c) => c.name);
  };
  it('「荒川を横切る」の線は、隅田川・荒川・綾瀬川・新中川の順に横切る', () => {
    const n = names('arakawa').filter((x) => x !== null);
    expect(n.slice(0, 4)).toEqual(['隅田川', '荒川', '綾瀬川', '新中川']);
    expect(n.filter((x) => x === '荒川')).toHaveLength(1); // 河川敷の水路で2つに分かれて見える所も、1本にまとめる
  });
  it('「台地から低地へ」の線は、隅田川・荒川（荒川放水路）・中川を横切る', () => {
    const n = names('plateau-to-lowland');
    expect(n).toContain('隅田川');
    expect(n).toContain('荒川');
    expect(n).toContain('中川');
  });
  it('幹となる川は 荒川・隅田川・江戸川・中川・多摩川', () => {
    expect([...data.trunk].sort()).toEqual(['中川', '多摩川', '江戸川', '荒川', '隅田川'].sort());
    expect(data.anchors.filter((a) => a.trunk).map((a) => a.name).sort()).toEqual(['中川', '多摩川', '江戸川', '荒川', '隅田川'].sort());
  });
});
