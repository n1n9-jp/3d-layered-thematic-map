// Mapbox Vector Tile（MVT、.pbf）の最小のデコーダ。依存を増やさないため、必要な部分だけを書いた。
// 仕様: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
// 読むのは layers（名前・extent・features）と、各 feature の type・属性・ジオメトリだけ。

/** protobuf の varint を読む（53 ビットまで）。 */
class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  varint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
      if (shift > 63) throw new Error('varint が長すぎます');
    }
  }
  /** 長さ付きの区間を返す（読み位置は区間の後ろへ進める）。 */
  bytes() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    return [start, start + len];
  }
  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.pos += 8;
    else if (wireType === 2) this.pos += this.varint();
    else if (wireType === 5) this.pos += 4;
    else throw new Error(`未対応の wire type: ${wireType}`);
  }
}

const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(buf, [start, end]) {
  const r = new Reader(buf, start, end);
  let value = null;
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const [s, e] = r.bytes();
      value = new TextDecoder('utf-8').decode(buf.subarray(s, e));
    } else if (field === 2 && wire === 5) {
      value = Buffer.from(buf.buffer, buf.byteOffset + r.pos, 4).readFloatLE(0);
      r.pos += 4;
    } else if (field === 3 && wire === 1) {
      value = Buffer.from(buf.buffer, buf.byteOffset + r.pos, 8).readDoubleLE(0);
      r.pos += 8;
    } else if ((field === 4 || field === 5) && wire === 0) {
      value = r.varint();
    } else if (field === 6 && wire === 0) {
      value = zigzag(r.varint());
    } else if (field === 7 && wire === 0) {
      value = r.varint() !== 0;
    } else r.skip(wire);
  }
  return value;
}

/** geometry のコマンド列を、リングまたは線の配列（タイル内の整数座標。y は下向き）にする。 */
function decodeGeometry(commands) {
  const parts = [];
  let current = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < commands.length) {
    const head = commands[i++];
    const id = head & 7;
    const count = head >> 3;
    if (id === 7) {
      if (current && current.length > 0) current.push(current[0]); // ClosePath
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += zigzag(commands[i++]);
      y += zigzag(commands[i++]);
      if (id === 1) {
        current = [[x, y]];
        parts.push(current);
      } else current.push([x, y]);
    }
  }
  return parts;
}

/**
 * タイルを読む。戻り値は `{ [レイヤー名]: { extent, features: [{ type, properties, geometry }] } }`。
 * type は 1 = 点、2 = 線、3 = 面。geometry は、点なら [[x, y]]、線・面なら [[[x, y], ...], ...]（面はリング）。
 */
export function decodeTile(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const top = new Reader(buf);
  const layers = {};
  while (top.pos < top.end) {
    const tag = top.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) {
      top.skip(tag & 7);
      continue;
    }
    const [ls, le] = top.bytes();
    const r = new Reader(buf, ls, le);
    let name = '';
    let extent = 4096;
    const keys = [];
    const values = [];
    const rawFeatures = [];
    while (r.pos < r.end) {
      const t = r.varint();
      const field = t >> 3;
      const wire = t & 7;
      if (field === 1 && wire === 2) {
        const [s, e] = r.bytes();
        name = new TextDecoder('utf-8').decode(buf.subarray(s, e));
      } else if (field === 2 && wire === 2) rawFeatures.push(r.bytes());
      else if (field === 3 && wire === 2) {
        const [s, e] = r.bytes();
        keys.push(new TextDecoder('utf-8').decode(buf.subarray(s, e)));
      } else if (field === 4 && wire === 2) values.push(readValue(buf, r.bytes()));
      else if (field === 5 && wire === 0) extent = r.varint();
      else r.skip(wire);
    }
    const features = rawFeatures.map(([s, e]) => {
      const f = new Reader(buf, s, e);
      let type = 0;
      let tags = [];
      let commands = [];
      while (f.pos < f.end) {
        const t = f.varint();
        const field = t >> 3;
        const wire = t & 7;
        if (field === 2 && wire === 2) {
          const [ps, pe] = f.bytes();
          const pr = new Reader(buf, ps, pe);
          tags = [];
          while (pr.pos < pr.end) tags.push(pr.varint());
        } else if (field === 3 && wire === 0) type = f.varint();
        else if (field === 4 && wire === 2) {
          const [gs, ge] = f.bytes();
          const gr = new Reader(buf, gs, ge);
          commands = [];
          while (gr.pos < gr.end) commands.push(gr.varint());
        } else f.skip(wire);
      }
      const properties = {};
      for (let i = 0; i + 1 < tags.length; i += 2) properties[keys[tags[i]]] = values[tags[i + 1]];
      const geometry = decodeGeometry(commands);
      return { type, properties, geometry };
    });
    // 同じ名前のレイヤーが複数ある場合は、後ろにつなげる
    if (layers[name]) layers[name].features.push(...features);
    else layers[name] = { extent, features };
  }
  return layers;
}
