import { describe, expect, it } from 'vitest';
import {
  DEPTH_RANKS,
  DURATION_RANKS,
  accumulateMax,
  cellCenterX,
  cellCenterY,
  cellIndexAt,
  createGrid,
  depthRankOf,
  durationRankOfMinutes,
  fillPolygonMax,
  planeIXToLocal,
  polygonsOf,
  readDbfNumbers,
  TIDE_DURATION_RANKS,
  tideDurationRankOf,
} from './flood.mjs';
import { toLonLat } from './projection.mjs';
import { createWards } from './wards.mjs';

describe('ランクへの換算', () => {
  it('浸水深は、境界の値を上の区間に入れる（0.5m ちょうどは 0.5〜3m）', () => {
    const cases = [
      [0, 0], [-1, 0], [NaN, 0], [undefined, 0],
      [0.01, 1], [0.4999, 1], [0.5, 2], [2.99, 2], [3, 3], [4.99, 3], [5, 4], [9.99, 4], [10, 5], [19.99, 5], [20, 6], [100, 6],
    ];
    for (const [m, rank] of cases) expect(depthRankOf(m), `${m} m`).toBe(rank);
  });

  it('浸水継続時間は、分から換算する（12時間・24時間・3日・1週間・2週間・4週間）', () => {
    const cases = [
      [0, 0], [NaN, 0], [1, 1], [719, 1], [720, 2], [1439, 2], [1440, 3], [4319, 3], [4320, 4], [10079, 4],
      [10080, 5], [20159, 5], [20160, 6], [40319, 6], [40320, 7], [999999, 7],
    ];
    for (const [min, rank] of cases) expect(durationRankOfMinutes(min), `${min} 分`).toBe(rank);
  });

  it('高潮の継続時間は、1〜4 は洪水と同じ区切り、1週間以上（有限の値と特別値 999999）はすべて 5。値がなければ 0', () => {
    const cases = [
      [NaN, 0], [undefined, 0], [-1, 0],
      [0, 1], [1, 1], [719, 1], [720, 2], [1439, 2], [1440, 3], [4319, 3], [4320, 4], [10079, 4],
      [10080, 5], [13027, 5], [20160, 5], [40320, 5], [999999, 5],
    ];
    for (const [min, rank] of cases) expect(tideDurationRankOf(min), `${min} 分`).toBe(rank);
    // 1〜4 は洪水と同じ換算
    for (const min of [1, 719, 720, 1440, 4319, 4320, 10079]) expect(tideDurationRankOf(min)).toBe(durationRankOfMinutes(min));
  });

  it('高潮の継続時間のランクの表：1〜4 は洪水と同じ、5 は「1週間以上」で上限なし', () => {
    expect(TIDE_DURATION_RANKS.slice(0, 4)).toEqual(DURATION_RANKS.slice(0, 4));
    expect(TIDE_DURATION_RANKS[4]).toEqual({ rank: 5, label: '1週間以上', minH: 168, maxH: null });
    expect(TIDE_DURATION_RANKS.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const { rank, minH } of TIDE_DURATION_RANKS) expect(tideDurationRankOf(minH === 0 ? 1 : minH * 60)).toBe(rank);
  });

  it('ランクの表は、換算関数の区切りと一致する', () => {
    for (const { rank, minM, maxM } of DEPTH_RANKS) {
      expect(depthRankOf(minM === 0 ? 0.01 : minM)).toBe(rank);
      if (maxM !== null) expect(depthRankOf(maxM)).toBe(rank + 1);
    }
    for (const { rank, minH, maxH } of DURATION_RANKS) {
      expect(durationRankOfMinutes(minH === 0 ? 1 : minH * 60)).toBe(rank);
      if (maxH !== null) expect(durationRankOfMinutes(maxH * 60)).toBe(rank + 1);
    }
    expect(DEPTH_RANKS.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(DURATION_RANKS.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('格子', () => {
  const grid = createGrid({ minX: 0, minY: 0, maxX: 100, maxY: 60 }, 10); // 10 列 × 6 行

  it('既定は標高と同じ格子（720×720、50m）', () => {
    expect(createGrid()).toEqual({ width: 720, height: 720, cellSize: 50, minX: -19000, minY: -19000, maxX: 17000, maxY: 17000 });
  });

  it('セルの中心は、北から南・西から東の順で、標高と同じ式', () => {
    expect(grid).toMatchObject({ width: 10, height: 6 });
    expect(cellCenterX(grid, 0)).toBe(5);
    expect(cellCenterY(grid, 0)).toBe(55);
    expect(cellCenterY(grid, 5)).toBe(5);
  });

  it('地点を含むセルの添字（格子の外は -1）', () => {
    expect(cellIndexAt(grid, 5, 55)).toBe(0);
    expect(cellIndexAt(grid, 99.9, 0.1)).toBe(5 * 10 + 9);
    expect(cellIndexAt(grid, -0.1, 30)).toBe(-1);
    expect(cellIndexAt(grid, 50, 60.1)).toBe(-1);
    expect(cellIndexAt(grid, 100, 30)).toBe(-1);
  });

  it('accumulateMax は、セルの中の最大を残す', () => {
    const cells = new Float32Array(grid.width * grid.height).fill(NaN);
    expect(accumulateMax(grid, cells, 5, 55, 1.2)).toBe(true);
    accumulateMax(grid, cells, 6, 54, 3.5);
    accumulateMax(grid, cells, 4, 56, 0.4);
    expect(cells[0]).toBeCloseTo(3.5);
    expect(accumulateMax(grid, cells, -5, 30, 9)).toBe(false);
  });
});

// ---------------------------------------------------------------- 走査線法と、素朴な方法の一致

/** 素朴な方法：セルごとに、その中心が多角形（外周と穴）の内側かを調べる（wards.mjs の判定を使う）。 */
function naiveFill(grid, out, rings, value) {
  const wards = createWards([{ properties: { code: '0', name: 'x' }, geometry: { type: 'Polygon', coordinates: rings } }]);
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      if (wards.contains(cellCenterX(grid, col), cellCenterY(grid, row)) && out[row * grid.width + col] < value) {
        out[row * grid.width + col] = value;
      }
    }
  }
}

const closed = (pts) => [...pts, pts[0]];
const rect = (x1, y1, x2, y2) => closed([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);

describe('fillPolygonMax（走査線法）', () => {
  const grid = createGrid({ minX: 0, minY: 0, maxX: 200, maxY: 120 }, 10); // 20 列 × 12 行

  /** 多角形の並び [{ rings, value }]（この順に塗る）を、走査線法と素朴な方法で塗って比べる。 */
  function expectSame(polys, label = '') {
    const a = new Uint8Array(grid.width * grid.height);
    const b = new Uint8Array(grid.width * grid.height);
    for (const { rings, value } of polys) {
      fillPolygonMax(grid, a, rings, value);
      naiveFill(grid, b, rings, value);
    }
    const diff = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(`row ${Math.floor(i / grid.width)} col ${i % grid.width}: ${a[i]} ≠ ${b[i]}`);
    expect(diff, label).toEqual([]);
    return a;
  }
  const at = (out, col, row) => out[row * grid.width + col];

  it('四角形：中心が内側にあるセルだけが塗られる', () => {
    const out = expectSame([{ rings: [rect(22, 22, 58, 48)], value: 3 }]);
    // x 22〜58 → 中心 25, 35, 45, 55 の列 2〜5、y 22〜48 → 中心 25, 35, 45 の行 y→ 行 = (120 − y)/10 − 0.5：行 7〜9
    expect(at(out, 2, 9)).toBe(3);
    expect(at(out, 5, 7)).toBe(3);
    expect(at(out, 1, 8)).toBe(0);
    expect(at(out, 6, 8)).toBe(0);
    expect(out.reduce((n, v) => n + (v === 3 ? 1 : 0), 0)).toBe(4 * 3);
  });

  it('穴のある多角形：穴の中は塗らない', () => {
    const outer = rect(10, 10, 110, 90);
    const hole = rect(40, 30, 80, 70);
    const out = expectSame([{ rings: [outer, hole], value: 2 }]);
    expect(at(out, 2, 6)).toBe(2); // 外周と穴のあいだ
    expect(at(out, 5, 6)).toBe(0); // 穴の中（x=55, y=55）
    // 穴だけを塗ると、全体の偶奇が逆にならない（穴の向きは問わない）
    const reversed = [outer, [...hole].reverse()];
    expectSame([{ rings: reversed, value: 2 }], '穴の向きを逆にしても同じ');
  });

  it('複数の多角形：離れたもの、重なるもの。重なるセルは最大の値が残る（塗る順に関わらない）', () => {
    const a = { rings: [rect(10, 10, 80, 60)], value: 2 };
    const b = { rings: [rect(50, 30, 150, 100)], value: 5 };
    const c = { rings: [closed([[160, 10], [190, 10], [175, 50]])], value: 1 };
    const out1 = expectSame([a, b, c]);
    const out2 = expectSame([b, a, c]);
    expect([...out1]).toEqual([...out2]);
    expect(at(out1, 6, 8)).toBe(5); // 重なる所（x=65, y=35）
    expect(at(out1, 2, 8)).toBe(2); // a だけ
    expect(at(out1, 17, 10)).toBe(1); // 三角形（x=175, y=15）
    // 小さい値で上塗りしても、大きい値は消えない
    const o = new Uint8Array(grid.width * grid.height);
    fillPolygonMax(grid, o, [rect(0, 0, 200, 120)], 4);
    fillPolygonMax(grid, o, [rect(0, 0, 200, 120)], 2);
    expect(new Set(o)).toEqual(new Set([4]));
  });

  it('セルの中心がちょうど辺の上にある場合も、素朴な方法と一致する', () => {
    // 中心の x は 5, 15, ..., 195、y は 115, 105, ..., 5
    const cases = {
      '左の辺が中心の x の上': rect(25, 25, 85, 85),
      '右の辺が中心の x の上': rect(20, 20, 75, 75),
      '下の辺が中心の y の上': rect(20, 25, 80, 80),
      '上の辺が中心の y の上': rect(20, 20, 80, 75),
      '四辺とも中心の上': rect(25, 25, 75, 75),
      '頂点が中心の上': closed([[25, 25], [75, 25], [75, 75], [25, 75]]),
      '斜めの辺が中心を通る': closed([[5, 5], [105, 5], [5, 105]]),
      '菱形の頂点が中心の上': closed([[55, 15], [95, 55], [55, 95], [15, 55]]),
      '辺が重なる2つの四角形': null,
    };
    for (const [label, ring] of Object.entries(cases)) {
      if (ring) expectSame([{ rings: [ring], value: 1 }], label);
    }
    // 辺を共有して隣り合う2つの多角形は、どちらかに必ず塗られる（隙間も重なりも、素朴な方法と同じ）
    expectSame(
      [
        { rings: [rect(25, 25, 75, 75)], value: 1 },
        { rings: [rect(75, 25, 125, 75)], value: 2 },
      ],
      '辺を共有',
    );
  });

  it('格子の外にはみ出す多角形：はみ出し方によらず、素朴な方法と一致する', () => {
    expectSame([{ rings: [rect(-50, -50, 300, 200)], value: 1 }], '格子を覆う');
    expectSame([{ rings: [rect(-50, 30, 70, 80)], value: 1 }], '左にはみ出す');
    expectSame([{ rings: [rect(130, 30, 270, 80)], value: 1 }], '右にはみ出す');
    expectSame([{ rings: [rect(30, -40, 80, 50)], value: 1 }], '下にはみ出す');
    expectSame([{ rings: [rect(30, 70, 80, 400)], value: 1 }], '上にはみ出す');
    expectSame([{ rings: [closed([[-100, -100], [400, 50], [-100, 300]])], value: 1 }], '斜めに横切る');
    const out = expectSame([{ rings: [rect(-50, -50, 300, 200)], value: 1 }]);
    expect(out.every((v) => v === 1)).toBe(true);
  });

  it('格子と交わらない多角形は何もしない', () => {
    const out = expectSame([
      { rings: [rect(300, 30, 400, 80)], value: 1 },
      { rings: [rect(30, 200, 80, 300)], value: 1 },
      { rings: [rect(-90, -90, -10, -10)], value: 1 },
    ]);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('閉じていないリング・空のリング・退化した多角形でも落ちず、素朴な方法と一致する', () => {
    expectSame([{ rings: [[[20, 20], [80, 20], [80, 80], [20, 80]]], value: 1 }], '閉じていない');
    const out = new Uint8Array(grid.width * grid.height);
    fillPolygonMax(grid, out, [], 1);
    fillPolygonMax(grid, out, [[]], 1);
    fillPolygonMax(grid, out, [closed([[20, 20], [60, 20], [100, 20]])], 1); // 面積0
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('凹んだ多角形（櫛の形）と、頂点の多い多角形', () => {
    const comb = closed([
      [10, 10], [190, 10], [190, 100], [170, 100], [170, 40], [150, 40], [150, 100], [130, 100], [130, 40],
      [110, 40], [110, 100], [90, 100], [90, 40], [70, 40], [70, 100], [50, 100], [50, 40], [30, 40], [30, 100], [10, 100],
    ]);
    expectSame([{ rings: [comb], value: 3 }], '櫛');
    // 円（200 頂点）
    const circle = closed(Array.from({ length: 200 }, (_, i) => [100 + 80 * Math.cos((i / 200) * 2 * Math.PI), 60 + 45 * Math.sin((i / 200) * 2 * Math.PI)]));
    expectSame([{ rings: [circle], value: 4 }], '円');
  });

  it('乱数で作った多角形（星形・穴あり・格子の外へはみ出す）を、素朴な方法と比べる', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const star = (cx, cy, rMin, rMax, n) =>
      closed(
        Array.from({ length: n }, (_, i) => {
          const a = (i / n) * 2 * Math.PI;
          const r = rMin + rand() * (rMax - rMin);
          return [Math.round((cx + r * Math.cos(a)) * 2) / 2, Math.round((cy + r * Math.sin(a)) * 2) / 2]; // 0.5 刻みで、中心や辺の上に乗りやすくする
        }),
      );
    for (let k = 0; k < 60; k++) {
      const cx = rand() * 260 - 30;
      const cy = rand() * 180 - 30;
      const outer = star(cx, cy, 15, 70, 6 + Math.floor(rand() * 20));
      const rings = rand() < 0.5 ? [outer, star(cx, cy, 3, 10, 5)] : [outer];
      expectSame([{ rings, value: 1 + Math.floor(rand() * 6) }], `乱数 ${k}`);
    }
    // 同じ格子に全部塗り重ねたものも一致する
    const polys = Array.from({ length: 40 }, () => ({
      rings: [star(rand() * 200, rand() * 120, 10, 50, 8)],
      value: 1 + Math.floor(rand() * 6),
    }));
    expectSame(polys, '塗り重ね');
  });

  it('実際の格子（720×720、50m）で、23区の外周に似た複雑な形でも素朴な方法と一致する', () => {
    const big = createGrid();
    // 頂点が非整数（経緯度から変換した座標に相当）の、なだらかな不規則形
    const ring = closed(
      Array.from({ length: 400 }, (_, i) => {
        const a = (i / 400) * 2 * Math.PI;
        const r = 9000 + 2500 * Math.sin(5 * a) + 700 * Math.cos(23 * a);
        return [-2000.123 + r * Math.cos(a), -1000.456 + r * 0.8 * Math.sin(a)];
      }),
    );
    const hole = closed(Array.from({ length: 50 }, (_, i) => [-3000 + 1500 * Math.cos((i / 50) * 2 * Math.PI), 0 + 1500 * Math.sin((i / 50) * 2 * Math.PI)]));
    const a = new Uint8Array(big.width * big.height);
    const b = new Uint8Array(big.width * big.height);
    fillPolygonMax(big, a, [ring, hole], 2);
    naiveFill(big, b, [ring, hole], 2);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBe(0);
    expect(a.reduce((n, v) => n + (v ? 1 : 0), 0)).toBeGreaterThan(50_000);
  });
});

describe('polygonsOf', () => {
  it('Polygon と MultiPolygon を、多角形ごとのリングの配列にそろえる。ほかの型は空', () => {
    const ring = rect(0, 0, 1, 1);
    expect(polygonsOf({ type: 'Polygon', coordinates: [ring] })).toEqual([[ring]]);
    expect(polygonsOf({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })).toEqual([[ring], [ring]]);
    expect(polygonsOf({ type: 'LineString', coordinates: [] })).toEqual([]);
    expect(polygonsOf(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 高潮の入力

/** .dbf を作る（フィールド：X, Y が N(10)、DepthM が N(19)、備考 が C(8)）。 */
function makeDbf(rows, { deleted = [] } = {}) {
  const fields = [['X', 'N', 10], ['Y', 'N', 10], ['DepthM', 'N', 19], ['Note', 'C', 8]];
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((n, f) => n + f[2], 0);
  const buf = Buffer.alloc(headerLength + rows.length * recordLength, 0x20);
  buf[0] = 3;
  buf.writeUInt32LE(rows.length, 4);
  buf.writeUInt16LE(headerLength, 8);
  buf.writeUInt16LE(recordLength, 10);
  fields.forEach(([name, type, len], i) => {
    const o = 32 + i * 32;
    buf.fill(0, o, o + 32);
    buf.write(name, o, 'latin1');
    buf[o + 11] = type.charCodeAt(0);
    buf[o + 16] = len;
  });
  buf[headerLength - 1] = 0x0d;
  rows.forEach((row, i) => {
    const r = headerLength + i * recordLength;
    buf[r] = deleted.includes(i) ? 0x2a : 0x20;
    let o = r + 1;
    fields.forEach(([, , len], k) => {
      buf.write(String(row[k] ?? '').padStart(len, ' ').slice(-len), o, 'latin1');
      o += len;
    });
  });
  return buf;
}

describe('readDbfNumbers', () => {
  it('数値のフィールドを列ごとに読む（右寄せの空白・指数表記・負の数・空欄）', () => {
    const dbf = makeDbf([[6005, -35125, '1.20000000000e-01', 'a'], [-15035, -23885, 19.36, 'b'], [0, 5, '', 'c']]);
    const { count, columns } = readDbfNumbers(dbf, ['X', 'Y', 'DepthM']);
    expect(count).toBe(3);
    expect([...columns.X]).toEqual([6005, -15035, 0]);
    expect([...columns.Y]).toEqual([-35125, -23885, 5]);
    expect(columns.DepthM[0]).toBeCloseTo(0.12);
    expect(columns.DepthM[1]).toBeCloseTo(19.36);
    expect(columns.DepthM[2]).toBeNaN();
  });

  it('削除済みの行を飛ばす。必要なフィールドがなければ、あるフィールドを示して失敗する', () => {
    const dbf = makeDbf([[1, 2, 3, ''], [4, 5, 6, ''], [7, 8, 9, '']], { deleted: [1] });
    const { count, columns } = readDbfNumbers(dbf, ['X']);
    expect(count).toBe(2);
    expect([...columns.X]).toEqual([1, 7]);
    expect(() => readDbfNumbers(dbf, ['TermMin'])).toThrow(/TermMin.*X, Y, DepthM, Note/);
  });

  it('途中で終わっている .dbf は失敗する', () => {
    const dbf = makeDbf([[1, 2, 3, ''], [4, 5, 6, '']]);
    expect(() => readDbfNumbers(dbf.subarray(0, dbf.length - 10), ['X'])).toThrow(/途中/);
  });
});

describe('高潮の座標変換', () => {
  it('第9系の座標を、経緯度（港湾局の例）に合わせてローカル座標へ変換する', () => {
    // 調査で確かめた例：(6005, −35125) → 東経139.8997・北緯35.6834
    const [x, y] = planeIXToLocal(6005, -35125);
    const [lon, lat] = toLonLat(x, y);
    expect(lon).toBeCloseTo(139.8997, 3);
    expect(lat).toBeCloseTo(35.6834, 3);
    expect(x).toBeGreaterThan(10000); // 原点（東経139.75度）の東
    expect(Math.abs(y)).toBeLessThan(1000);
  });
});
