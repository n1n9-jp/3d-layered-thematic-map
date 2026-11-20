import { describe, expect, it } from 'vitest';
import { clipLineToRect, lineLength, lineMidpoint, mergeLines } from './transit.mjs';

describe('lineLength', () => {
  it('線分の長さを足し合わせる', () => {
    expect(lineLength([[0, 0], [3, 4], [3, 14]])).toBe(15);
  });
});

describe('lineMidpoint', () => {
  it('2点の線は線分の中点', () => {
    expect(lineMidpoint([[0, 0], [10, 20]])).toEqual([5, 10]);
  });

  it('頂点の間隔が不均一でも、線に沿った長さの半分の位置になる', () => {
    // 長さ 10 + 30 = 40、半分の 20 は2本目の線分の途中（残り 10）
    const [x, y] = lineMidpoint([[0, 0], [10, 0], [10, 30]]);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(10);
  });

  it('折れ曲がった線では頂点の平均ではなく道のり上の位置を返す', () => {
    const [x, y] = lineMidpoint([[0, 0], [100, 0], [100, 100]]);
    expect([x, y]).toEqual([100, 0]);
  });

  it('1点だけ・長さ0の線は先頭の点', () => {
    expect(lineMidpoint([[7, 8]])).toEqual([7, 8]);
    expect(lineMidpoint([[7, 8], [7, 8]])).toEqual([7, 8]);
  });

  it('空の入力は例外', () => {
    expect(() => lineMidpoint([])).toThrow();
  });
});

describe('mergeLines', () => {
  const sortLines = (lines) => lines.map((l) => JSON.stringify(l)).sort();

  it('端点が一致する2本を1本にし、つなぎ目の点を重複させない', () => {
    const merged = mergeLines([[[0, 0], [10, 0]], [[10, 0], [20, 5]]]);
    expect(merged).toEqual([[[0, 0], [10, 0], [20, 5]]]);
  });

  it('向きが逆の線も反転してつなぐ', () => {
    const merged = mergeLines([[[0, 0], [10, 0]], [[20, 5], [10, 0]]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual([[0, 0], [10, 0], [20, 5]]);
  });

  it('順序がばらばらの3本でも一筆につながる', () => {
    const merged = mergeLines([
      [[20, 0], [30, 0]],
      [[0, 0], [10, 0]],
      [[10, 0], [20, 0]],
    ]);
    expect(merged).toHaveLength(1);
    const line = merged[0];
    expect(line).toHaveLength(4);
    const ends = [line[0][0], line[3][0]].sort((a, b) => a - b);
    expect(ends).toEqual([0, 30]);
  });

  it('端点が離れていれば別の線のまま', () => {
    const lines = [[[0, 0], [10, 0]], [[11.6, 0], [20, 0]]];
    expect(sortLines(mergeLines(lines))).toEqual(sortLines(lines));
  });

  it('1m 未満のずれは同じ端点とみなしてつなぐ', () => {
    const merged = mergeLines([[[0, 0], [10, 0]], [[10.3, 0.2], [20, 0]]]);
    expect(merged).toEqual([[[0, 0], [10, 0], [20, 0]]]);
  });

  it('3本以上の端が集まる分岐点ではつながない', () => {
    const lines = [[[0, 0], [10, 0]], [[10, 0], [20, 10]], [[10, 0], [20, -10]]];
    const merged = mergeLines(lines);
    expect(merged).toHaveLength(3);
    expect(sortLines(merged)).toEqual(sortLines(lines));
  });

  it('輪になる線は、1本の閉じた線にまとまる', () => {
    const merged = mergeLines([
      [[0, 0], [10, 0]],
      [[10, 0], [10, 10]],
      [[10, 10], [0, 0]],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toHaveLength(4);
    expect(merged[0][0]).toEqual(merged[0][3]);
  });

  it('1本で閉じている線はそのまま残す', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 0]];
    expect(mergeLines([ring])).toEqual([ring]);
  });

  it('入力を書き換えない', () => {
    const lines = [[[0, 0], [10, 0]], [[20, 5], [10, 0]]];
    const copy = JSON.parse(JSON.stringify(lines));
    mergeLines(lines);
    expect(lines).toEqual(copy);
  });

  it('空の入力は空の結果', () => {
    expect(mergeLines([])).toEqual([]);
  });
});

describe('clipLineToRect', () => {
  const rect = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('矩形の内側にある線はそのまま', () => {
    const line = [[10, 10], [50, 20], [90, 90]];
    expect(clipLineToRect(line, rect)).toEqual([line]);
  });

  it('外へ出る部分を境界で切り落とす', () => {
    expect(clipLineToRect([[50, 50], [150, 50]], rect)).toEqual([[[50, 50], [100, 50]]]);
  });

  it('外へ出てまた入る線は2本に分かれる', () => {
    const pieces = clipLineToRect([[50, 50], [150, 50], [150, 80], [50, 80]], rect);
    expect(pieces).toEqual([[[50, 50], [100, 50]], [[100, 80], [50, 80]]]);
  });

  it('矩形を横切る線は両端を切り落とす', () => {
    expect(clipLineToRect([[-50, 50], [150, 50]], rect)).toEqual([[[0, 50], [100, 50]]]);
  });

  it('完全に外にある線は空、境界の1点にだけ触れる線も空', () => {
    expect(clipLineToRect([[200, 200], [300, 300]], rect)).toEqual([]);
    expect(clipLineToRect([[100, 100], [150, 150]], rect)).toEqual([]);
  });

  it('切り取った結果が矩形からはみ出さない', () => {
    const [piece] = clipLineToRect([[-30, 20], [60, 130]], rect);
    for (const [x, y] of piece) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });
});
