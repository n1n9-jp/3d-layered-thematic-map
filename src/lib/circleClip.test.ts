import { describe, expect, it } from 'vitest';
import type { Position } from '../types';
import { clipPolylineToCircle, pointInCircle } from './circleClip';

/** 原点中心・半径 5 の円で切る。 */
const clip = (path: Position[]) => clipPolylineToCircle(path, 0, 0, 5);

function expectPath(actual: Position[], expected: Position[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((p, i) => {
    expect(actual[i][0]).toBeCloseTo(p[0], 9);
    expect(actual[i][1]).toBeCloseTo(p[1], 9);
  });
}

describe('pointInCircle', () => {
  it('縁の上は中', () => {
    expect(pointInCircle(3, 4, 0, 0, 5)).toBe(true);
    expect(pointInCircle(3, 4.0001, 0, 0, 5)).toBe(false);
    expect(pointInCircle(0, 0, 0, 0, 0)).toBe(true);
  });
});

describe('clipPolylineToCircle', () => {
  it('全部が中：元の頂点列のコピー1本', () => {
    const path: Position[] = [
      [-1, 0],
      [0, 2],
      [2, 2],
    ];
    const out = clip(path);
    expect(out).toEqual([path]);
    expect(out[0]).not.toBe(path);
  });

  it('全部が外：空', () => {
    expect(
      clip([
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toEqual([]);
    // 両端は外で、線分の延長が円を通るが、線分は届かない
    expect(
      clip([
        [10, 0],
        [8, 0],
      ]),
    ).toEqual([]);
  });

  it('1回またぐ：縁との交点で切る', () => {
    const out = clip([
      [0, 0],
      [10, 0],
    ]);
    expect(out).toHaveLength(1);
    expectPath(out[0], [
      [0, 0],
      [5, 0],
    ]);
    // 外から入る向き
    const out2 = clip([
      [10, 0],
      [0, 0],
    ]);
    expect(out2).toHaveLength(1);
    expectPath(out2[0], [
      [5, 0],
      [0, 0],
    ]);
  });

  it('両端が外で、円を貫く：両側の交点で切る', () => {
    const out = clip([
      [-10, 3],
      [10, 3],
    ]);
    expect(out).toHaveLength(1);
    expectPath(out[0], [
      [-4, 3],
      [4, 3],
    ]);
  });

  it('出て戻る：2本に分かれる', () => {
    const out = clip([
      [0, 0],
      [10, 0],
      [0, 1],
    ]);
    expect(out).toHaveLength(2);
    expectPath(out[0], [
      [0, 0],
      [5, 0],
    ]);
    // (10,0)→(0,1) と円の交点。外から入って (0,1) で終わる
    expect(out[1]).toHaveLength(2);
    expect(Math.hypot(out[1][0][0], out[1][0][1])).toBeCloseTo(5, 9);
    expect(out[1][1]).toEqual([0, 1]);
  });

  it('円に接する：長さ0なので返さない', () => {
    expect(
      clip([
        [-10, 5],
        [10, 5],
      ]),
    ).toEqual([]);
  });

  it('頂点がちょうど縁の上', () => {
    // 縁の上の頂点で外へ出る：縁までの部分が残る
    const out = clip([
      [0, 0],
      [5, 0],
      [10, 0],
    ]);
    expect(out).toEqual([
      [
        [0, 0],
        [5, 0],
      ],
    ]);
    // 縁の上の頂点を、中へ入る側から通る
    const out2 = clip([
      [10, 0],
      [5, 0],
      [0, 0],
    ]);
    expect(out2).toEqual([
      [
        [5, 0],
        [0, 0],
      ],
    ]);
    // 外から縁の上の頂点に触れて、また外へ：長さ0なので返さない
    expect(
      clip([
        [10, 0],
        [5, 0],
        [10, 5],
      ]),
    ).toEqual([]);
    // 縁の上の頂点をたどって円の中を通る（3-4-5）
    expect(
      clip([
        [3, 4],
        [0, 0],
        [-3, -4],
      ]),
    ).toEqual([
      [
        [3, 4],
        [0, 0],
        [-3, -4],
      ],
    ]);
  });

  it('長さ0の線分', () => {
    // 円の中の長さ0：返さない
    expect(
      clip([
        [1, 1],
        [1, 1],
      ]),
    ).toEqual([]);
    // 円の外の長さ0：返さない
    expect(
      clip([
        [9, 9],
        [9, 9],
      ]),
    ).toEqual([]);
    // 線の途中にある長さ0の線分は、重なる頂点を1つにして続ける
    expect(
      clip([
        [0, 0],
        [0, 0],
        [2, 0],
      ]),
    ).toEqual([
      [
        [0, 0],
        [2, 0],
      ],
    ]);
    // 縁の上の長さ0
    expect(
      clip([
        [5, 0],
        [5, 0],
      ]),
    ).toEqual([]);
  });

  it('頂点が足りない・半径が不正', () => {
    expect(clip([])).toEqual([]);
    expect(clip([[0, 0]])).toEqual([]);
    expect(clipPolylineToCircle([[0, 0], [1, 0]], 0, 0, -1)).toEqual([]);
    expect(clipPolylineToCircle([[0, 0], [1, 0]], 0, 0, NaN)).toEqual([]);
    expect(clipPolylineToCircle([[0, 0], [1, 0]], NaN, 0, 5)).toEqual([]);
  });

  it('半径0：中心を通る線は長さ0なので返さない', () => {
    expect(
      clipPolylineToCircle(
        [
          [-1, 0],
          [1, 0],
        ],
        0,
        0,
        0,
      ),
    ).toEqual([]);
  });

  it('入力を変更しない', () => {
    const path: Position[] = [
      [0, 0],
      [10, 0],
    ];
    const copy = JSON.parse(JSON.stringify(path));
    clip(path);
    expect(path).toEqual(copy);
  });

  it('中心が原点でない円', () => {
    const out = clipPolylineToCircle(
      [
        [100, 200],
        [120, 200],
      ],
      110,
      200,
      5,
    );
    expect(out).toHaveLength(1);
    expectPath(out[0], [
      [105, 200],
      [115, 200],
    ]);
  });

  describe('閉じた輪郭', () => {
    it('全部が中：閉じたまま1本', () => {
      const ring: Position[] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ];
      expect(clip(ring)).toEqual([ring]);
    });

    it('全部が外（円を内側に含む大きな輪郭）：空', () => {
      const ring: Position[] = [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
        [-10, -10],
      ];
      expect(clip(ring)).toEqual([]);
    });

    it('始点が外：輪郭の4辺それぞれが分かれて切れる', () => {
      // 一辺 8 の正方形（辺の中点は円の中、角は外）。円は半径 5。
      const ring: Position[] = [
        [-4, -4],
        [4, -4],
        [4, 4],
        [-4, 4],
        [-4, -4],
      ];
      // 角 (4,4) は中心から 5.66 で外。各辺の両端は外ではなく、角は 5.66 > 5 → 外。
      const out = clip(ring);
      expect(out).toHaveLength(4);
      for (const piece of out) {
        expect(piece).toHaveLength(2);
        for (const p of piece) expect(Math.hypot(p[0], p[1])).toBeCloseTo(5, 9);
      }
    });

    it('始点が円の中で、輪郭が円を出入りする：始点をまたぐ部分は1本につなぐ', () => {
      // 始点 (0,0) は中。(0,0)→(10,0)→(10,10)→(0,10)→(0,0)。
      const ring: Position[] = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ];
      const out = clip(ring);
      // 出ていく側 [(0,0)→(5,0)]、入ってくる側 [(0,5)→(0,0)] が始点でつながって1本
      expect(out).toHaveLength(1);
      expectPath(out[0], [
        [0, 5],
        [0, 0],
        [5, 0],
      ]);
    });

    it('途中で円に入り、始点へ戻る輪郭：入ってきた部分と始点の先の部分をつなぐ', () => {
      // 始点 (0,0)。右へ出て、上を回って戻る途中でもう一度円をかすめる輪郭。
      const ring: Position[] = [
        [0, 0],
        [8, 0],
        [8, 4],
        [0, 4], // (0,4) は中、(8,4)→(0,4) は円に入る
        [0, 0],
      ];
      const out = clip(ring);
      // (0,0)→(5,0) / (8,4)→(0,4) の円内部分 [(3,4)→(0,4)] / (0,4)→(0,0) は連続なので、後ろ2つが1本、始点でつながる
      expect(out).toHaveLength(1);
      expectPath(out[0], [
        [3, 4],
        [0, 4],
        [0, 0],
        [5, 0],
      ]);
    });
  });
});
