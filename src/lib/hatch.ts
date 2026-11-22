import { lineInsidePolygon } from './section';
import type { Position } from '../types';

type Rings = readonly (readonly Position[])[];

/**
 * 多角形の中に、斜め（右上がり 45 度）の平行線の網掛けを引く。線の間隔（垂直方向）は spacing（m）。
 * 返すのは、多角形の内側にある線分（2点）の列。外周と穴（偶奇規則）を扱う。位相は座標の原点に固定するので、同じ多角形からは同じ線ができる。
 */
export function hatchPolygon(polygon: Rings, spacing: number): Position[][] {
  const out: Position[][] = [];
  if (!(spacing > 0)) return out;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polygon)
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (minX === Infinity) return out;
  // 線 y = x - u。垂直方向の間隔 spacing は、u の間隔 spacing × √2。
  const du = spacing * Math.SQRT2;
  const uLo = Math.floor((minX - maxY) / du) * du;
  const uHi = maxX - minY;
  const reach = maxX - minX + (maxY - minY) + 2;
  for (let u = uLo; u <= uHi; u += du) {
    const ax = minX - reach;
    const bx = maxX + reach;
    const line = { ax, ay: ax - u, bx, by: bx - u };
    const len = Math.hypot(line.bx - line.ax, line.by - line.ay);
    for (const [d0, d1] of lineInsidePolygon(line, polygon as never)) {
      const p = (d: number): Position => [Math.round(line.ax + ((line.bx - line.ax) * d) / len), Math.round(line.ay + ((line.by - line.ay) * d) / len)];
      out.push([p(d0), p(d1)]);
    }
  }
  return out;
}
