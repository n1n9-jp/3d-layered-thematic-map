// 河川（水域の面）の前処理で使う、数値の計算だけの部品。ネットワークやファイルには触れない（テストしやすいように分けた）。
// 元データは、国土地理院 最適化ベクトルタイルの WA（水域）と Anno（注記）。`scripts/build-rivers.mjs` が使う。

/** 多角形（外周＋穴）の、リング1つの符号つき面積（シューレース公式。反時計回りが正）。 */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}

/** ポリゴン（リングの配列）の面積（符号なし）。MVT は外周と穴のリングの向きが逆なので、符号つきの面積を足し合わせる。 */
export function polygonArea(rings) {
  // MVT の面は、外周が時計回り（画面の座標で正）、穴が反時計回り。最初のリングの符号を基準に、同じ向きを足し、逆を引く。
  if (rings.length === 0) return 0;
  const first = signedArea(rings[0]);
  const sign = first >= 0 ? 1 : -1;
  let total = 0;
  for (const ring of rings) total += signedArea(ring) * sign;
  return Math.abs(total);
}

/** リング群の周長の合計。 */
export function ringPerimeter(rings) {
  let total = 0;
  for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) total += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  return total;
}

/**
 * Sutherland–Hodgman 法で、リングを軸に平行な長方形で切り抜く。閉じたリング（始点＝終点）を受け取り、閉じたリングを返す。
 * 結果が 3 頂点未満なら null。凹んだ形では、長方形の縁に沿った面積 0 の辺が残ることがある（塗りには影響しない）。
 */
export function clipRingToBox(ring, minX, minY, maxX, maxY) {
  let pts = ring.slice(0, -1);
  const edges = [
    { inside: (p) => p[0] >= minX, cut: (a, b) => [minX, a[1] + ((b[1] - a[1]) * (minX - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[0] <= maxX, cut: (a, b) => [maxX, a[1] + ((b[1] - a[1]) * (maxX - a[0])) / (b[0] - a[0])] },
    { inside: (p) => p[1] >= minY, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (minY - a[1])) / (b[1] - a[1]), minY] },
    { inside: (p) => p[1] <= maxY, cut: (a, b) => [a[0] + ((b[0] - a[0]) * (maxY - a[1])) / (b[1] - a[1]), maxY] },
  ];
  for (const { inside, cut } of edges) {
    if (pts.length === 0) return null;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ai = inside(a);
      const bi = inside(b);
      if (ai && bi) next.push(b);
      else if (ai && !bi) next.push(cut(a, b));
      else if (!ai && bi) next.push(cut(a, b), b);
    }
    pts = next;
  }
  if (pts.length < 3) return null;
  return [...pts, pts[0]];
}

/** 点 p から線分 ab までの距離。 */
function distToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas–Peucker 法で、折れ線を許容誤差 tolerance（m）で間引く。`pinned(p)` が真の点は必ず残す。
 * 閉じたリング（始点＝終点）は、始点と、始点から最も遠い点を固定して、2本の折れ線として間引く。
 * 結果が 4 点未満になる（面として成り立たない）ときは null。
 */
export function simplifyRing(ring, tolerance, pinned = () => false) {
  const n = ring.length - 1; // 重複する終点を除いた頂点数
  if (n < 3) return null;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  let far = 1;
  let farDist = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farDist) { farDist = d; far = i; }
  }
  keep[far] = 1;
  for (let i = 0; i < n; i++) if (pinned(ring[i])) keep[i] = 1;

  // 固定した点どうしの間を、再帰なしで間引く
  const stack = [];
  const kept = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  for (let k = 0; k < kept.length; k++) stack.push([kept[k], k + 1 < kept.length ? kept[k + 1] : n]);
  while (stack.length > 0) {
    const [lo, hiRaw] = stack.pop();
    const a = ring[lo];
    const b = ring[hiRaw % n];
    let idx = -1;
    let max = tolerance;
    for (let i = lo + 1; i < hiRaw; i++) {
      const d = distToSegment(ring[i], a, b);
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hiRaw]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
}

/**
 * 細かい格子（セル `cell` m、左下が (minX, minY)、幅 w、高さ h）に、ポリゴン群を塗る。
 * 辺が通るセルと、内側のセル（セルの中心が偶奇則で内側）を 1 にする。細くて内側のセルがない面（幅が 1 セルに満たない川）も、
 * 辺が通るセルが途切れずにつながるので、連結成分を数えられる。
 */
export class Mask {
  constructor(minX, minY, cell, w, h) {
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
  }
  #mark(x, y) {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((y - this.minY) / this.cell);
    if (c >= 0 && c < this.w && r >= 0 && r < this.h) this.data[r * this.w + c] = 1;
  }
  /** セルの位置（列、行）。範囲外は null。 */
  cellOf(x, y) {
    const c = Math.floor((x - this.minX) / this.cell);
    const r = Math.floor((y - this.minY) / this.cell);
    return c >= 0 && c < this.w && r >= 0 && r < this.h ? r * this.w + c : null;
  }
  /** ポリゴン（リングの配列。外周と穴）を塗る。 */
  paint(rings) {
    const step = this.cell / 2;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const [ax, ay] = ring[i];
        const [bx, by] = ring[i + 1];
        y0 = Math.min(y0, ay, by);
        y1 = Math.max(y1, ay, by);
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 0; k <= n; k++) this.#mark(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
      }
    }
    const rowLo = Math.max(0, Math.floor((y0 - this.minY) / this.cell));
    const rowHi = Math.min(this.h - 1, Math.floor((y1 - this.minY) / this.cell));
    for (let r = rowLo; r <= rowHi; r++) {
      const y = this.minY + (r + 0.5) * this.cell;
      const xs = [];
      for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[i + 1];
          if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - this.minX) / this.cell - 0.5));
        const c1 = Math.min(this.w - 1, Math.floor((xs[k + 1] - this.minX) / this.cell - 0.5));
        for (let c = c0; c <= c1; c++) this.data[r * this.w + c] = 1;
      }
    }
  }
  /** 1 のセルの連結成分（8 近傍）に番号を振る。戻り値は、セルごとの番号（0 = 成分なし、1 以上 = 成分）と、成分の数。 */
  label() {
    const { w, h, data } = this;
    const labels = new Int32Array(w * h);
    let count = 0;
    const stack = new Int32Array(w * h);
    for (let start = 0; start < data.length; start++) {
      if (!data[start] || labels[start]) continue;
      count++;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = count;
      while (sp > 0) {
        const cur = stack[--sp];
        const r = (cur / w) | 0;
        const c = cur - r * w;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= h) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= w) continue;
            const n = rr * w + cc;
            if (data[n] && !labels[n]) {
              labels[n] = count;
              stack[sp++] = n;
            }
          }
        }
      }
    }
    return { labels, count };
  }
}

/** 点（[x, y]）が、リング（穴を含む複数）の内側か（偶奇則）。 */
export function pointInRings(p, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 点から、リング群のいちばん近い辺までの距離。 */
export function distanceToRings(p, rings) {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) best = Math.min(best, distToSegment(p, ring[i], ring[i + 1]));
  }
  return best;
}

/** 折れ線の、長さに沿った真ん中の点。 */
export function midpointOf(line) {
  let total = 0;
  for (let i = 0; i < line.length - 1; i++) total += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  let rest = total / 2;
  for (let i = 0; i < line.length - 1; i++) {
    const len = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    if (rest <= len && len > 0) {
      const t = rest / len;
      return [line[i][0] + t * (line[i + 1][0] - line[i][0]), line[i][1] + t * (line[i + 1][1] - line[i][1])];
    }
    rest -= len;
  }
  return line[0];
}

/** (x, y) にいちばん近い、`allowed` の成分に属する水のセル（mask のセル番号）。`radius`（m）以内になければ null。 */
export function nearestWaterCell(mask, labels, allowed, x, y, radius) {
  const c0 = Math.floor((x - mask.minX) / mask.cell);
  const r0 = Math.floor((y - mask.minY) / mask.cell);
  const n = Math.ceil(radius / mask.cell);
  let best = null;
  let bestD = Infinity;
  for (let r = Math.max(0, r0 - n); r <= Math.min(mask.h - 1, r0 + n); r++) {
    for (let c = Math.max(0, c0 - n); c <= Math.min(mask.w - 1, c0 + n); c++) {
      const idx = r * mask.w + c;
      if (!mask.data[idx] || !allowed.has(labels[idx])) continue;
      const d = Math.hypot((c + 0.5) * mask.cell + mask.minX - x, (r + 0.5) * mask.cell + mask.minY - y);
      if (d < bestD) { bestD = d; best = idx; }
    }
  }
  return bestD <= radius ? best : null;
}

/**
 * 水のセル（mask が 1 で、成分が `allowed` に入るもの）の上で、複数の起点（セル番号の配列）からの、水に沿った距離（8 近傍、斜めは √2）が
 * いちばん近い起点の番号を、セルごとに求める（Dijkstra 法）。`stepCost(セル番号)` があれば、そのセルに入る 1 歩の距離にその倍率を掛ける。`maxDistance`（m）より遠いセル、起点につながらないセルは -1。
 */
export function nameWaterCells(mask, labels, allowed, sourceCells, maxDistance, stepCost = null) {
  const { w, h, data, cell } = mask;
  const dist = new Float64Array(w * h).fill(Infinity);
  const owner = new Int32Array(w * h).fill(-1);
  // 2分ヒープ（距離、セル）
  const heapD = [];
  const heapC = [];
  const push = (d, c) => {
    let i = heapD.length;
    heapD.push(d);
    heapC.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= d) break;
      heapD[i] = heapD[p]; heapC[i] = heapC[p];
      i = p;
    }
    heapD[i] = d; heapC[i] = c;
  };
  const pop = () => {
    const d0 = heapD[0];
    const c0 = heapC[0];
    const d = heapD.pop();
    const c = heapC.pop();
    const n = heapD.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        if (l + 1 < n && heapD[l + 1] < heapD[l]) l++;
        if (heapD[l] >= d) break;
        heapD[i] = heapD[l]; heapC[i] = heapC[l];
        i = l;
      }
      heapD[i] = d; heapC[i] = c;
    }
    return [d0, c0];
  };
  sourceCells.forEach((c, k) => {
    if (dist[c] > 0) {
      dist[c] = 0;
      owner[c] = k;
      push(0, c);
    }
  });
  while (heapD.length > 0) {
    const [d, c] = pop();
    if (d > dist[c]) continue;
    const r = (c / w) | 0;
    const col = c - r * w;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= h) continue;
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const cc = col + dc;
        if (cc < 0 || cc >= w) continue;
        const n = rr * w + cc;
        if (!data[n] || !allowed.has(labels[n])) continue;
        const nd = d + (dr !== 0 && dc !== 0 ? cell * Math.SQRT2 : cell) * (stepCost ? stepCost(n) : 1);
        if (nd < dist[n] && nd <= maxDistance) {
          dist[n] = nd;
          owner[n] = owner[c];
          push(nd, n);
        }
      }
    }
  }
  return owner;
}

/** mask の水のセルごとに、いちばん近い水でないセルまでの距離（m。チャンファー距離）。川の幅の目安（幅の半分に近い値）。 */
export function distanceToLand(mask) {
  const { w, h, data, cell } = mask;
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = data[i] ? INF : 0;
  const a = cell;
  const b = cell * Math.SQRT2;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!data[i]) continue;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + a);
      if (r > 0) {
        v = Math.min(v, d[i - w] + a);
        if (c > 0) v = Math.min(v, d[i - w - 1] + b);
        if (c < w - 1) v = Math.min(v, d[i - w + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let r = h - 1; r >= 0; r--) {
    for (let c = w - 1; c >= 0; c--) {
      const i = r * w + c;
      if (!data[i]) continue;
      let v = d[i];
      if (c < w - 1) v = Math.min(v, d[i + 1] + a);
      if (r < h - 1) {
        v = Math.min(v, d[i + w] + a);
        if (c < w - 1) v = Math.min(v, d[i + w + 1] + b);
        if (c > 0) v = Math.min(v, d[i + w - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}
