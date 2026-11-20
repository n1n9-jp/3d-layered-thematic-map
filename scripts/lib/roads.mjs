// 道路データの前処理で使う、入出力を伴わない処理（分類・連結・最近傍探索）。
// 座標は呼び出し側が決める（ここでは [x, y] の組として扱うだけで、単位を問わない）。

/**
 * N13 の属性から、出力する class を決める。出力しない道路は null。
 * 対象は種別が通常部（N13_002 = "1"）で、建設中（N13_004 = "5"）でないもの。
 * N13_003：4 → motorway、1 → national、2 → prefectural、3 かつ幅員13m以上（N13_006 が "4" か "5"）→ other。
 */
export function classifyRoad(props) {
  if (String(props.N13_002) !== '1') return null;
  if (String(props.N13_004) === '5') return null;
  switch (String(props.N13_003)) {
    case '4':
      return 'motorway';
    case '1':
      return 'national';
    case '2':
      return 'prefectural';
    case '3': {
      const width = String(props.N13_006);
      return width === '4' || width === '5' ? 'other' : null;
    }
    default:
      return null;
  }
}

const pointKey = (p) => `${p[0]},${p[1]}`;

/**
 * 同じ group の線のうち、端点が一致して一筆でつながるものを連結する。
 * 入力は `{ group, coords }` の配列（group は文字列。coords は [x, y] の配列で2点以上）。
 * 出力は同じ形の配列で、順序は入力で最初に現れた線の順。
 *
 * - 端点の一致は座標の完全一致で判定する。
 * - 1つの端点に同じ group の線の端が3つ以上集まるときは連結しない（交差点）。
 * - 始点と終点が同じ線（環）は、それ自体で閉じているので他の線とは連結しない。
 * - 連結するとき、線の向きは必要に応じて反転する。つなぎ目の点は重複させない。
 */
export function chainLines(lines) {
  const out = [];
  const byGroup = new Map();
  lines.forEach((line, index) => {
    let list = byGroup.get(line.group);
    if (!list) byGroup.set(line.group, (list = []));
    list.push({ index, coords: line.coords });
  });

  // 出力の順序を入力順に保つため、連結結果の「先頭の線の入力番号」で並べ直す
  const results = [];
  for (const [group, members] of byGroup) {
    for (const { first, coords } of chainGroup(members)) results.push({ first, group, coords });
  }
  results.sort((a, b) => a.first - b.first);
  for (const { group, coords } of results) out.push({ group, coords });
  return out;
}

/** 1つの group 内の連結。members は `{ index, coords }`。`{ first, coords }` の配列を返す。 */
function chainGroup(members) {
  const n = members.length;
  // 端点キー → その端点に集まる線の端（`{ line, end }`、end は 0 が始点、1 が終点）
  const ends = new Map();
  const addEnd = (key, line, end) => {
    const list = ends.get(key);
    if (list) list.push({ line, end });
    else ends.set(key, [{ line, end }]);
  };
  const isRing = members.map((m) => pointKey(m.coords[0]) === pointKey(m.coords[m.coords.length - 1]));
  members.forEach((m, line) => {
    if (isRing[line]) return;
    addEnd(pointKey(m.coords[0]), line, 0);
    addEnd(pointKey(m.coords[m.coords.length - 1]), line, 1);
  });

  // next[line][end] = その端でつながる相手 { line, end }（なければ undefined）
  const link = Array.from({ length: n }, () => [undefined, undefined]);
  for (const list of ends.values()) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    link[a.line][a.end] = b;
    link[b.line][b.end] = a;
  }

  const visited = new Array(n).fill(false);
  const results = [];

  /** start の線から、end の側へ向かってたどる。たどった線の並び（向き付き）を返す。 */
  const walk = (startLine, outEnd) => {
    const seq = [];
    let line = startLine;
    let leave = outEnd; // この線から出ていく端
    for (;;) {
      const next = link[line][leave];
      if (!next || visited[next.line]) break;
      visited[next.line] = true;
      // next.end で入って、反対側の端から出る
      seq.push({ line: next.line, reversed: next.end === 1 });
      line = next.line;
      leave = 1 - next.end;
    }
    return seq;
  };

  const emit = (parts) => {
    let coords = [];
    for (const { line, reversed } of parts) {
      const c = reversed ? [...members[line].coords].reverse() : members[line].coords;
      coords = coords.length === 0 ? [...c] : coords.concat(c.slice(1));
    }
    results.push({ first: Math.min(...parts.map((p) => members[p.line].index)), coords });
  };

  // 連結の端（片側がつながっていない線）から始めて、一筆の列を作る
  for (let line = 0; line < n; line++) {
    if (visited[line]) continue;
    const endsFree = [!link[line][0], !link[line][1]];
    if (!endsFree[0] && !endsFree[1]) continue; // 途中の線。端の線から回収する
    visited[line] = true;
    // 空いている端の反対側へたどる
    const goEnd = endsFree[0] ? 1 : 0;
    const seq = walk(line, goEnd);
    // 始点側が空いていれば向きはそのまま。終点側が空いている（始点側がつながっている）場合は反転して並べる
    emit([{ line, reversed: !endsFree[0] }, ...seq]);
  }
  // 残りは端のない循環（つながりが輪になったもの）。どこかで切って一筆にする
  for (let line = 0; line < n; line++) {
    if (visited[line]) continue;
    visited[line] = true;
    const seq = walk(line, 1);
    emit([{ line, reversed: false }, ...seq]);
  }
  return results;
}

/** 折れ線の長さ（座標の単位のまま）。 */
export function lineLength(coords) {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  return sum;
}

/** 折れ線を、長さで見た中点（始点からの道のりが全長の半分になる点）。 */
export function lineMidpoint(coords) {
  const half = lineLength(coords) / 2;
  let run = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1];
    const [x2, y2] = coords[i];
    const seg = Math.hypot(x2 - x1, y2 - y1);
    if (run + seg >= half && seg > 0) {
      const t = (half - run) / seg;
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    run += seg;
  }
  return [...coords[coords.length - 1]];
}

/** 点 (px, py) から線分 (x1, y1)-(x2, y2) までの距離。 */
export function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * 名前つきの折れ線の集まりに対する最近傍探索を作る。`lines` は `{ name, coords }` の配列。
 * 返す関数 `nearest(x, y, maxDistance)` は、距離が maxDistance 以下で最も近い線の name を返す
 * （なければ null）。同じ距離なら先に与えた線を優先する。
 * 一定サイズのセルに線分を登録し、点のまわりのセルだけを調べる。
 */
export function createNearestLineIndex(lines, cellSize) {
  const cells = new Map();
  const cellKey = (cx, cy) => `${cx},${cy}`;
  const segments = []; // 4つ組 [x1, y1, x2, y2] を平らに並べる
  const owners = []; // 線分ごとの線の番号
  lines.forEach((line, lineIndex) => {
    for (let i = 1; i < line.coords.length; i++) {
      const [x1, y1] = line.coords[i - 1];
      const [x2, y2] = line.coords[i];
      const id = owners.length;
      segments.push(x1, y1, x2, y2);
      owners.push(lineIndex);
      const cx1 = Math.floor(Math.min(x1, x2) / cellSize);
      const cx2 = Math.floor(Math.max(x1, x2) / cellSize);
      const cy1 = Math.floor(Math.min(y1, y2) / cellSize);
      const cy2 = Math.floor(Math.max(y1, y2) / cellSize);
      for (let cx = cx1; cx <= cx2; cx++) {
        for (let cy = cy1; cy <= cy2; cy++) {
          const key = cellKey(cx, cy);
          const list = cells.get(key);
          if (list) list.push(id);
          else cells.set(key, [id]);
        }
      }
    }
  });

  return function nearest(x, y, maxDistance) {
    const cx1 = Math.floor((x - maxDistance) / cellSize);
    const cx2 = Math.floor((x + maxDistance) / cellSize);
    const cy1 = Math.floor((y - maxDistance) / cellSize);
    const cy2 = Math.floor((y + maxDistance) / cellSize);
    let best = null;
    let bestDist = Infinity;
    let bestLine = Infinity;
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const list = cells.get(cellKey(cx, cy));
        if (!list) continue;
        for (const id of list) {
          const k = id * 4;
          const d = distanceToSegment(x, y, segments[k], segments[k + 1], segments[k + 2], segments[k + 3]);
          if (d > maxDistance) continue;
          const lineIndex = owners[id];
          if (d < bestDist || (d === bestDist && lineIndex < bestLine)) {
            bestDist = d;
            bestLine = lineIndex;
            best = lines[lineIndex].name;
          }
        }
      }
    }
    return best;
  };
}
