import { describe, expect, it } from 'vitest';
import type { Position } from '../types';
import { countVertices, simplifyPath, simplifyPaths } from './simplify';

/** 線 `path` のどの点も、線 `simple` から tolerance を超えて離れていないか（頂点だけの確認）。 */
function maxDeviation(path: Position[], simple: Position[]): number {
  let worst = 0;
  for (const p of path) {
    let best = Infinity;
    for (let i = 0; i + 1 < simple.length; i++) {
      const [ax, ay] = simple[i];
      const [bx, by] = simple[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
      best = Math.min(best, Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('simplifyPath', () => {
  it('一直線上の頂点を間引き、端点は残す', () => {
    const line: Position[] = [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]];
    expect(simplifyPath(line, 1)).toEqual([[0, 0], [40, 0]]);
  });

  it('許容誤差を超えて曲がる頂点は残す', () => {
    const line: Position[] = [[0, 0], [50, 30], [100, 0]];
    expect(simplifyPath(line, 10)).toEqual(line);
    expect(simplifyPath(line, 40)).toEqual([[0, 0], [100, 0]]);
  });

  it('許容誤差を超えて元の形から離れない', () => {
    // ゆるい蛇行。頂点は元の頂点だけを使う。
    const line: Position[] = Array.from({ length: 200 }, (_, i) => [i * 5, Math.sin(i / 7) * 40 + (i % 3)] as Position);
    for (const tol of [1, 3, 10]) {
      const s = simplifyPath(line, tol);
      expect(s.length).toBeLessThan(line.length);
      expect(maxDeviation(line, s)).toBeLessThanOrEqual(tol + 1e-9);
      for (const p of s) expect(line).toContain(p);
      // 順序を保つ
      const idx = s.map((p) => line.indexOf(p));
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    }
  });

  it('連続する同じ座標の頂点は1つにする', () => {
    expect(simplifyPath([[0, 0], [0, 0], [10, 5], [10, 5], [20, 0]], 0)).toEqual([[0, 0], [10, 5], [20, 0]]);
  });

  it('頂点が2つ以下の線や許容誤差0以下では形を変えない', () => {
    expect(simplifyPath([[0, 0], [5, 5]], 10)).toEqual([[0, 0], [5, 5]]);
    const line: Position[] = [[0, 0], [10, 1], [20, 0]];
    expect(simplifyPath(line, 0)).toEqual(line);
  });

  it('閉じた線は閉じたまま、四角形の角を残す', () => {
    // 各辺に余分な頂点を持つ 100m 四方の正方形
    const ring: Position[] = [
      [0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100], [0, 50], [0, 0],
    ];
    const s = simplifyPath(ring, 2);
    expect(s[0]).toEqual(s[s.length - 1]);
    expect(s).toHaveLength(5);
    for (const corner of [[0, 0], [100, 0], [100, 100], [0, 100]]) expect(s).toContainEqual(corner);
  });

  it('輪が3点以下に潰れるなら、元のリングを残す', () => {
    const tiny: Position[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const s = simplifyPath(tiny, 100);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(s[0]).toEqual(s[s.length - 1]);
  });

  it('元の配列を書き換えない', () => {
    const line: Position[] = [[0, 0], [10, 0], [20, 0]];
    const copy = JSON.stringify(line);
    simplifyPath(line, 5);
    expect(JSON.stringify(line)).toBe(copy);
  });

  it('頂点が非常に多い線でもスタックを溢れさせない', () => {
    // ほぼ一直線の 20 万頂点（許容誤差内の揺れだけ）。2 点に間引かれる。
    const line: Position[] = Array.from({ length: 200_000 }, (_, i) => [i, (i % 2) * 0.01] as Position);
    expect(simplifyPath(line, 1)).toHaveLength(2);
  });
});

describe('simplifyPaths / countVertices', () => {
  it('線ごとに間引き、頂点の総数を数える', () => {
    const paths: Position[][] = [
      [[0, 0], [5, 0], [10, 0]],
      [[0, 0], [5, 8], [10, 0]],
    ];
    const s = simplifyPaths(paths, 1);
    expect(s).toEqual([[[0, 0], [10, 0]], [[0, 0], [5, 8], [10, 0]]]);
    expect(countVertices(paths)).toBe(6);
    expect(countVertices(s)).toBe(5);
  });
});
