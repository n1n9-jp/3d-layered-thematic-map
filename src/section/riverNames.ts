/**
 * 断面のグラフに出す、川の名前の置き場所。名前は横長なので、込み合う（川が近い）ときは、重なる名前を出さない。
 * 幹となる川を優先し、同じ優先度では川幅の広いほうを先に置く。置けた名前だけを返す。
 */
import type { RiverCrossing } from '../types';

/** 名前の文字の大きさ（px）。CSS の `.sc-river-name` と合わせる。 */
export const RIVER_NAME_PX = 10;
/** 名前どうしの隙間（px）。 */
const GAP = 3;
/** 縦線から名前までの隙間（px）。 */
const OFFSET = 3;

export interface PlacedRiverName {
  /** `rivers` の添字 */
  index: number;
  name: string;
  /** 文字の基準位置の x（px）と、その側（start なら縦線の右に、end なら左に伸ばす） */
  x: number;
  anchor: 'start' | 'end';
}

/** `toX` は、線に沿った距離（m）→ 横の位置（px）、`right` はグラフの右端（px）。 */
export function placeRiverNames(rivers: readonly RiverCrossing[], toX: (d: number) => number, right: number): PlacedRiverName[] {
  const order = rivers
    .map((r, index) => ({ r, index, width: r.d1 - r.d0 }))
    .filter((c) => c.r.name !== null)
    .sort((a, b) => Number(b.r.trunk) - Number(a.r.trunk) || b.width - a.width || a.index - b.index);
  const taken: [number, number][] = [];
  const out: PlacedRiverName[] = [];
  for (const { r, index } of order) {
    const name = r.name as string;
    const w = name.length * RIVER_NAME_PX;
    const cx = (toX(r.d0) + toX(r.d1)) / 2;
    // 右に伸ばせないとき（右端に近い）は、縦線の左に置く
    const anchor: 'start' | 'end' = cx + OFFSET + w <= right ? 'start' : 'end';
    const x = anchor === 'start' ? cx + OFFSET : cx - OFFSET;
    const span: [number, number] = anchor === 'start' ? [x, x + w] : [x - w, x];
    if (taken.some(([a, b]) => span[0] < b + GAP && a < span[1] + GAP)) continue;
    taken.push(span);
    out.push({ index, name, x, anchor });
  }
  return out;
}
