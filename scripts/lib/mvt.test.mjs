import { describe, expect, it } from 'vitest';
import { decodeTile } from './mvt.mjs';

// --- 手書きの MVT エンコーダ（テスト用。デコーダとは別に、仕様どおりに組み立てる）
const varint = (n) => {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const tag = (field, wire) => varint((field << 3) | wire);
const lenDelim = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const str = (s) => [...new TextEncoder().encode(s)];
const cmd = (id, count) => varint((count << 3) | id);

function feature({ type, tags = [], geometry }) {
  return lenDelim(2 /* features */, [
    ...lenDelim(2, tags.flatMap(varint)),
    ...tag(3, 0), ...varint(type),
    ...lenDelim(4, geometry.flatMap((g) => g)),
  ]);
}
const value = {
  string: (s) => lenDelim(4, lenDelim(1, str(s))),
  uint: (n) => lenDelim(4, [...tag(5, 0), ...varint(n)]),
};
const layer = (name, features, keys = [], values = [], extent = 4096) =>
  lenDelim(3, [
    ...lenDelim(1, str(name)),
    ...features.flat(),
    ...keys.flatMap((k) => lenDelim(3, str(k))),
    ...values.flat(),
    ...tag(5, 0), ...varint(extent),
  ]);

describe('decodeTile', () => {
  it('点・線・面と、属性（文字列と整数）を読む', () => {
    const point = feature({ type: 1, tags: [0, 0, 1, 1], geometry: [[...cmd(1, 1), ...varint(zig(25)), ...varint(zig(17))]] });
    const line = feature({
      type: 2,
      geometry: [[...cmd(1, 1), ...varint(zig(2)), ...varint(zig(2)), ...cmd(2, 2), ...varint(zig(3)), ...varint(zig(0)), ...varint(zig(0)), ...varint(zig(3))]],
    });
    // 面：外周 (0,0)→(10,0)→(10,10)→(0,10)、閉じる。続けて穴（逆向き）(3,3)→(3,6)→(6,6)→(6,3)
    const polygon = feature({
      type: 3,
      tags: [0, 2, 1, 3],
      geometry: [
        [
          ...cmd(1, 1), ...varint(zig(0)), ...varint(zig(0)),
          ...cmd(2, 3), ...varint(zig(10)), ...varint(zig(0)), ...varint(zig(0)), ...varint(zig(10)), ...varint(zig(-10)), ...varint(zig(0)),
          ...cmd(7, 1),
          ...cmd(1, 1), ...varint(zig(3)), ...varint(zig(-7)), // 直前の点 (0,10) から (3,3) へ
          ...cmd(2, 3), ...varint(zig(0)), ...varint(zig(3)), ...varint(zig(3)), ...varint(zig(0)), ...varint(zig(0)), ...varint(zig(-3)),
          ...cmd(7, 1),
        ],
      ],
    });
    const buf = Uint8Array.from([
      ...layer('Anno', [point], ['vt_text', 'vt_code'], [value.string('荒川'), value.uint(322)]),
      ...layer('RvrCL', [line]),
      ...layer('WA', [polygon], ['vt_code', 'k'], [value.uint(7), value.uint(8), value.uint(5200), value.uint(9)], 4096),
    ]);
    const t = decodeTile(buf);
    expect(Object.keys(t)).toEqual(['Anno', 'RvrCL', 'WA']);
    expect(t.Anno.extent).toBe(4096);
    expect(t.Anno.features[0]).toEqual({ type: 1, properties: { vt_text: '荒川', vt_code: 322 }, geometry: [[[25, 17]]] });
    expect(t.RvrCL.features[0].type).toBe(2);
    expect(t.RvrCL.features[0].geometry).toEqual([[[2, 2], [5, 2], [5, 5]]]);
    const wa = t.WA.features[0];
    expect(wa.properties).toEqual({ vt_code: 5200, k: 9 });
    expect(wa.geometry).toHaveLength(2);
    expect(wa.geometry[0]).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    expect(wa.geometry[1]).toEqual([[3, 3], [3, 6], [6, 6], [6, 3], [3, 3]]);
  });

  it('大きな整数（2^32 以上）の varint も読む', () => {
    const big = 2 ** 33 + 5;
    const f = feature({ type: 1, tags: [0, 0], geometry: [[...cmd(1, 1), ...varint(zig(0)), ...varint(zig(0))]] });
    const t = decodeTile(Uint8Array.from(layer('L', [f], ['n'], [value.uint(big)])));
    expect(t.L.features[0].properties.n).toBe(big);
  });

  it('同じ名前のレイヤーが2つあれば、地物をつなげる', () => {
    const f = (x) => feature({ type: 1, geometry: [[...cmd(1, 1), ...varint(zig(x)), ...varint(zig(0))]] });
    const t = decodeTile(Uint8Array.from([...layer('L', [f(1)]), ...layer('L', [f(2)])]));
    expect(t.L.features.map((x) => x.geometry[0][0][0])).toEqual([1, 2]);
  });

  it('空のタイルは、レイヤーなし', () => {
    expect(decodeTile(new Uint8Array(0))).toEqual({});
  });
});
