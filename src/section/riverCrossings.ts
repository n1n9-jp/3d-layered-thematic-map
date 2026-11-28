/**
 * 断面の線が川（水域の面）を横切る区間と、その川の名前。
 * 区間は、線と面の辺の交点から求める（面ごとに、線との交点を距離の順に並べ、外から入って出るまでが川の中）。
 * 橋や継ぎ目で隣り合う面の区間は、1つにつなぐ。名前は、区間の真ん中にいちばん近い名前の標本（`river-labels.json`）から引く。
 * 近くに標本がなければ、名前なしの区間にする。
 */
import type { RiverData } from '../layers/rivers';
import type { RiverCrossing, SectionLine } from '../types';

/** 区間をつなぐ、隣り合う面の隙間（m）。橋の下や、タイルの継ぎ目の細い隙間をまたぐ。 */
export const MERGE_GAP_M = 30;
/** 同じ名前が続く区間をつなぐ、隙間の上限（m）。中州や堤で川が2本に分かれて見える所（荒川の河川敷の中の水路など）を、1本の川として数える。 */
export const SAME_NAME_GAP_M = 150;
/** これより短い区間（m）は、川とみなさない（面の角をかすめるだけのもの）。 */
export const MIN_CROSSING_M = 6;
/** 名前の標本を探す距離（m）。標本は、水域の 250 m 四方ごとに 1 点なので、川の幅の半分を足した値。 */
export const NAME_RADIUS_M = 450;

interface Interval {
  d0: number;
  d1: number;
}

/** 面（リングの配列。外周と穴）と線（無限に延ばした直線）の交点の、線に沿った距離を、昇順で返す。 */
function crossingsOfPolygon(rings: readonly (readonly (readonly [number, number])[])[], ax: number, ay: number, ux: number, uy: number): number[] {
  const out: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const p = ring[i];
      const q = ring[i + 1];
      // 線の法線方向の符号つき距離。0 は「正でない」側に入れて、頂点にちょうど当たるときも、偶数回の数え方がずれないようにする。
      const sp = ux * (p[1] - ay) - uy * (p[0] - ax);
      const sq = ux * (q[1] - ay) - uy * (q[0] - ax);
      if (sp > 0 === sq > 0) continue;
      const t = sp / (sp - sq);
      const x = p[0] + (q[0] - p[0]) * t;
      const y = p[1] + (q[1] - p[1]) * t;
      out.push(ux * (x - ax) + uy * (y - ay));
    }
  }
  return out.sort((a, b) => a - b);
}

/** 線が川を横切る区間（線に沿った距離 d0〜d1）を、始点から順に返す。名前は付けない。 */
export function riverIntervals(rivers: Pick<RiverData, 'polygons' | 'boxes'>, line: SectionLine): Interval[] {
  const len = Math.hypot(line.bx - line.ax, line.by - line.ay);
  if (!(len > 0)) return [];
  const ux = (line.bx - line.ax) / len;
  const uy = (line.by - line.ay) / len;
  const x0 = Math.min(line.ax, line.bx);
  const x1 = Math.max(line.ax, line.bx);
  const y0 = Math.min(line.ay, line.by);
  const y1 = Math.max(line.ay, line.by);
  const raw: Interval[] = [];
  rivers.polygons.forEach((rings, i) => {
    const [bx0, by0, bx1, by1] = rivers.boxes[i];
    if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) return;
    const ts = crossingsOfPolygon(rings, line.ax, line.ay, ux, uy);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const d0 = Math.max(0, ts[k]);
      const d1 = Math.min(len, ts[k + 1]);
      if (d1 > d0) raw.push({ d0, d1 });
    }
  });
  raw.sort((a, b) => a.d0 - b.d0);
  const merged: Interval[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.d0 <= last.d1 + MERGE_GAP_M) last.d1 = Math.max(last.d1, r.d1);
    else merged.push({ ...r });
  }
  return merged.filter((m) => m.d1 - m.d0 >= MIN_CROSSING_M);
}

/** 点 (x, y) にいちばん近い名前の標本の名前。近くに標本がない、または対象外の川の標本が近ければ null。 */
export function riverNameAt(rivers: Pick<RiverData, 'samples' | 'names'>, x: number, y: number): string | null {
  let best = Infinity;
  let k = -1;
  for (const s of rivers.samples) {
    const d = Math.hypot(s[0] - x, s[1] - y);
    if (d < best) {
      best = d;
      k = s[2];
    }
  }
  return best <= NAME_RADIUS_M && k >= 0 ? rivers.names[k] : null;
}

/** 断面の線が川を横切る位置（始点から順）。名前は、区間の真ん中にいちばん近い標本から付ける。 */
export function computeRiverCrossings(rivers: RiverData, line: SectionLine): RiverCrossing[] {
  const len = Math.hypot(line.bx - line.ax, line.by - line.ay);
  const named = riverIntervals(rivers, line).map(({ d0, d1 }): RiverCrossing => {
    const mid = (d0 + d1) / 2;
    const name = riverNameAt(rivers, line.ax + ((line.bx - line.ax) * mid) / len, line.ay + ((line.by - line.ay) * mid) / len);
    return { d0, d1, name, trunk: name !== null && rivers.trunk.includes(name) };
  });
  // 同じ名前の川が、近い隙間で続くときは、1本にまとめる（名前のない区間は、まとめない）
  const out: RiverCrossing[] = [];
  for (const c of named) {
    const last = out[out.length - 1];
    if (last && c.name !== null && last.name === c.name && c.d0 - last.d1 <= SAME_NAME_GAP_M) last.d1 = c.d1;
    else out.push({ ...c });
  }
  return out;
}
