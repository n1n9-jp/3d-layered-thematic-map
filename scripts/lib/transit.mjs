// 公共交通データ（鉄道路線・駅）の前処理で使う、座標に対する純粋な処理。
// 座標はローカル座標（m）の [x, y]。

/** 線に沿った長さ（m）。 */
export function lineLength(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) {
    sum += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return sum;
}

/** 線に沿った長さの半分の位置の点 [x, y]。長さが0（全点が同じ位置）なら先頭の点。 */
export function lineMidpoint(coords) {
  if (!Array.isArray(coords) || coords.length === 0) throw new Error('座標が空です');
  const half = lineLength(coords) / 2;
  if (half === 0) return [coords[0][0], coords[0][1]];
  let walked = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (walked + seg >= half) {
      const t = seg === 0 ? 0 : (half - walked) / seg;
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    walked += seg;
  }
  const last = coords[coords.length - 1];
  return [last[0], last[1]];
}

const keyOf = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;

/**
 * 端点（1m に丸めた座標）が一致して一筆でつながる線を連結する。
 * ある地点に線の端がちょうど2つ（別々の線のもの）集まるときだけつなぎ、3つ以上の端が集まる分岐点ではつながない。
 * 線の向きは必要に応じて反転する。つないだ点の重複は1つにする。入力の線は変更しない。
 * 戻り値は連結後の線（座標の配列）の配列。
 */
export function mergeLines(lines) {
  const n = lines.length;
  // 端点キー → その地点に集まる線の端 { line, end: 0（始点）| 1（終点） }
  const ends = new Map();
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (line.length < 2) continue;
    for (const end of [0, 1]) {
      const key = keyOf(end === 0 ? line[0] : line[line.length - 1]);
      let list = ends.get(key);
      if (!list) ends.set(key, (list = []));
      list.push({ line: i, end });
    }
  }

  // links[i][end] = つながる相手の端 { line, end }（なければ undefined）
  const links = Array.from({ length: n }, () => [undefined, undefined]);
  for (const list of ends.values()) {
    if (list.length !== 2 || list[0].line === list[1].line) continue;
    const [a, b] = list;
    links[a.line][a.end] = b;
    links[b.line][b.end] = a;
  }

  const visited = new Array(n).fill(false);
  const result = [];

  /** line を、entryEnd 側（0: 始点, 1: 終点）から入って反対側へ向かう向きで、つながる限りたどる。 */
  const walk = (first, entryEnd) => {
    const out = [];
    let cur = first;
    let enter = entryEnd;
    for (;;) {
      visited[cur] = true;
      const pts = enter === 0 ? lines[cur] : [...lines[cur]].reverse();
      for (let k = out.length === 0 ? 0 : 1; k < pts.length; k++) out.push([pts[k][0], pts[k][1]]);
      const exitEnd = 1 - enter;
      const next = links[cur][exitEnd];
      if (!next || visited[next.line]) break;
      cur = next.line;
      enter = next.end;
    }
    return out;
  };

  // まず、片方の端がどこにもつながらない線（連なりの端）から始める
  for (let i = 0; i < n; i++) {
    if (visited[i] || lines[i].length < 2) continue;
    if (!links[i][0]) result.push(walk(i, 0));
    else if (!links[i][1]) result.push(walk(i, 1));
  }
  // 残りは輪になっている連なり
  for (let i = 0; i < n; i++) {
    if (!visited[i] && lines[i].length >= 2) result.push(walk(i, 0));
  }
  return result;
}

/** 線分 (p, q) を矩形で切り取る（Liang-Barsky）。矩形と交わらなければ null、交われば [切り取った始点, 切り取った終点]。 */
function clipSegment(p, q, { minX, minY, maxX, maxY }) {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const checks = [
    [-dx, p[0] - minX],
    [dx, maxX - p[0]],
    [-dy, p[1] - minY],
    [dy, maxY - p[1]],
  ];
  for (const [d, dist] of checks) {
    if (d === 0) {
      if (dist < 0) return null;
    } else {
      const t = dist / d;
      if (d < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [
    t0 === 0 ? p : [p[0] + dx * t0, p[1] + dy * t0],
    t1 === 1 ? q : [p[0] + dx * t1, p[1] + dy * t1],
  ];
}

/**
 * 線を矩形（{ minX, minY, maxX, maxY }）の内側だけに切り取る。矩形の外へ出てまた入る線は複数の線に分かれる。
 * 戻り値は切り取った線の配列（2点以上のものだけ。矩形の外にあれば空）。
 */
export function clipLineToRect(coords, rect) {
  const pieces = [];
  let current = null;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  for (let i = 1; i < coords.length; i++) {
    const seg = clipSegment(coords[i - 1], coords[i], rect);
    if (!seg || same(seg[0], seg[1])) {
      current = null;
      continue;
    }
    if (current && same(current[current.length - 1], seg[0])) {
      current.push(seg[1]);
    } else {
      current = [seg[0], seg[1]];
      pieces.push(current);
    }
  }
  return pieces;
}
