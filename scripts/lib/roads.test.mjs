import { describe, expect, it } from 'vitest';
import {
  chainLines,
  classifyRoad,
  createNearestLineIndex,
  distanceToSegment,
  lineLength,
  lineMidpoint,
} from './roads.mjs';

const props = (over) => ({ N13_002: '1', N13_003: '3', N13_004: '1', N13_006: '4', ...over });

describe('classifyRoad', () => {
  it('道路分類を class に対応づける', () => {
    expect(classifyRoad(props({ N13_003: '4' }))).toBe('motorway');
    expect(classifyRoad(props({ N13_003: '1' }))).toBe('national');
    expect(classifyRoad(props({ N13_003: '2' }))).toBe('prefectural');
  });

  it('市区町村道等は幅員13m以上（"4" か "5"）のときだけ other', () => {
    expect(classifyRoad(props({ N13_003: '3', N13_006: '4' }))).toBe('other');
    expect(classifyRoad(props({ N13_003: '3', N13_006: '5' }))).toBe('other');
    expect(classifyRoad(props({ N13_003: '3', N13_006: '3' }))).toBeNull();
    expect(classifyRoad(props({ N13_003: '3', N13_006: '6' }))).toBeNull();
  });

  it('その他・不明の道路分類は出力しない', () => {
    expect(classifyRoad(props({ N13_003: '5' }))).toBeNull();
    expect(classifyRoad(props({ N13_003: '6' }))).toBeNull();
  });

  it('通常部以外の種別と、建設中は除く', () => {
    expect(classifyRoad(props({ N13_002: '2', N13_003: '2' }))).toBeNull();
    expect(classifyRoad(props({ N13_002: '4', N13_003: '2' }))).toBeNull();
    expect(classifyRoad(props({ N13_004: '5', N13_003: '2' }))).toBeNull();
    // 橋・高架・トンネルは対象
    expect(classifyRoad(props({ N13_004: '2', N13_003: '2' }))).toBe('prefectural');
    expect(classifyRoad(props({ N13_004: '3', N13_003: '2' }))).toBe('prefectural');
  });
});

describe('chainLines', () => {
  const line = (group, ...coords) => ({ group, coords });

  it('端点が一致する2本を1本につなぎ、つなぎ目の点は重複させない', () => {
    const out = chainLines([line('a', [0, 0], [1, 0]), line('a', [1, 0], [2, 0], [3, 0])]);
    expect(out).toEqual([{ group: 'a', coords: [[0, 0], [1, 0], [2, 0], [3, 0]] }]);
  });

  it('向きがばらばらでも一筆につなぐ', () => {
    const out = chainLines([
      line('a', [2, 0], [3, 0]), // 終点側が自由
      line('a', [2, 0], [1, 0]), // 逆向き
      line('a', [0, 0], [1, 0]),
    ]);
    expect(out).toHaveLength(1);
    const c = out[0].coords;
    expect(c).toHaveLength(4);
    const xs = c.map((p) => p[0]);
    expect(xs[0] === 0 ? xs : [...xs].reverse()).toEqual([0, 1, 2, 3]);
  });

  it('違う group はつなげない', () => {
    const out = chainLines([line('a', [0, 0], [1, 0]), line('b', [1, 0], [2, 0])]);
    expect(out).toHaveLength(2);
  });

  it('同じ group の端が3つ以上集まる点ではつなげない', () => {
    const out = chainLines([
      line('a', [0, 0], [1, 0]),
      line('a', [1, 0], [2, 0]),
      line('a', [1, 0], [1, 1]),
    ]);
    expect(out).toHaveLength(3);
  });

  it('別の group の線が交わっていても、同じ group の2本はつなぐ', () => {
    const out = chainLines([
      line('a', [0, 0], [1, 0]),
      line('a', [1, 0], [2, 0]),
      line('b', [1, 0], [1, 1]),
    ]);
    expect(out.filter((l) => l.group === 'a')).toHaveLength(1);
    expect(out.filter((l) => l.group === 'b')).toHaveLength(1);
  });

  it('端点が4つ（十字路）でもつなげない', () => {
    const out = chainLines([
      line('a', [0, 0], [1, 0]),
      line('a', [1, 0], [2, 0]),
      line('a', [1, -1], [1, 0]),
      line('a', [1, 0], [1, 1]),
    ]);
    expect(out).toHaveLength(4);
  });

  it('始点と終点が同じ線（環）はほかの線とつなげない', () => {
    const ring = line('a', [0, 0], [1, 0], [1, 1], [0, 0]);
    const out = chainLines([ring, line('a', [0, 0], [-1, 0])]);
    expect(out).toHaveLength(2);
    expect(out[0].coords).toEqual(ring.coords);
  });

  it('端のない輪（2本が両端で接する）も1本にまとめて、例外にならない', () => {
    const out = chainLines([line('a', [0, 0], [1, 1], [2, 0]), line('a', [2, 0], [1, -1], [0, 0])]);
    expect(out).toHaveLength(1);
    expect(out[0].coords).toHaveLength(5);
  });

  it('長い列を端から端まで1本にし、出力は最初に現れた線の順', () => {
    const lines = [line('b', [10, 10], [11, 10])];
    for (let i = 0; i < 50; i++) lines.push(line('a', [i, 0], [i + 1, 0]));
    const out = chainLines(lines);
    expect(out.map((l) => l.group)).toEqual(['b', 'a']);
    expect(out[1].coords).toHaveLength(51);
    expect(lineLength(out[1].coords)).toBe(50);
  });

  it('つながらない線はそのまま返す。入力を書き換えない', () => {
    const input = [line('a', [0, 0], [1, 0]), line('a', [5, 5], [6, 5])];
    const copy = JSON.parse(JSON.stringify(input));
    expect(chainLines(input)).toEqual(copy);
    expect(input).toEqual(copy);
  });
});

describe('lineMidpoint / lineLength', () => {
  it('長さで見た中点を返す（頂点の数ではない）', () => {
    // 1本目の辺が 9、2本目が 1 → 全長 10、中点は始点から 5 の位置
    expect(lineMidpoint([[0, 0], [9, 0], [9, 1]])).toEqual([5, 0]);
  });

  it('頂点上、2点だけの線、向きの違いでも正しい', () => {
    expect(lineMidpoint([[0, 0], [4, 0]])).toEqual([2, 0]);
    expect(lineMidpoint([[0, 0], [2, 0], [4, 0]])).toEqual([2, 0]);
    expect(lineMidpoint([[0, 0], [0, -6]])).toEqual([0, -3]);
  });

  it('長さ0の線は、その点を返す', () => {
    expect(lineMidpoint([[3, 4], [3, 4]])).toEqual([3, 4]);
  });

  it('lineLength は折れ線の長さ', () => {
    expect(lineLength([[0, 0], [3, 4], [3, 10]])).toBe(11);
  });
});

describe('distanceToSegment', () => {
  it('線分の途中・端点・退化した線分への距離', () => {
    expect(distanceToSegment(1, 1, 0, 0, 2, 0)).toBe(1);
    expect(distanceToSegment(5, 0, 0, 0, 2, 0)).toBe(3);
    expect(distanceToSegment(-3, 4, 0, 0, 2, 0)).toBe(5);
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('createNearestLineIndex', () => {
  const lines = [
    { name: 'A', coords: [[0, 0], [1000, 0]] },
    { name: 'B', coords: [[0, 100], [1000, 100]] },
  ];

  it('距離の上限以内で最も近い線の名前を返す', () => {
    const nearest = createNearestLineIndex(lines, 100);
    expect(nearest(500, 30, 50)).toBe('A');
    expect(nearest(500, 70, 50)).toBe('B');
    expect(nearest(500, 20, 50)).toBe('A');
  });

  it('上限を超えるときは null、ちょうど上限なら返す', () => {
    const nearest = createNearestLineIndex(lines, 100);
    expect(nearest(500, -51, 50)).toBeNull();
    expect(nearest(500, -50, 50)).toBe('A');
    expect(nearest(5000, 0, 50)).toBeNull();
  });

  it('セルをまたぐ線分・負の座標でも見つかる', () => {
    const nearest = createNearestLineIndex([{ name: 'C', coords: [[-950, -950], [950, 950]] }], 100);
    expect(nearest(-800, -790, 50)).toBe('C');
    expect(nearest(0, 5, 50)).toBe('C');
    expect(nearest(400, 0, 50)).toBeNull();
  });

  it('同じ距離なら先に与えた線を優先する', () => {
    const nearest = createNearestLineIndex(
      [
        { name: 'first', coords: [[0, 10], [100, 10]] },
        { name: 'second', coords: [[0, -10], [100, -10]] },
      ],
      100,
    );
    expect(nearest(50, 0, 50)).toBe('first');
  });

  it('線が空でも動く', () => {
    expect(createNearestLineIndex([], 100)(0, 0, 50)).toBeNull();
  });
});
