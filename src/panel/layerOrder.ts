import type { LayerId } from '../config';

/**
 * 並べ替えの純粋な計算。
 * store の `order` は下→上、パネルの一覧は上→下なので、添字の向きが逆になる。
 */

/** パネル表示用（最上段が先頭）の並び。 */
export function displayOrder(order: readonly LayerId[]): LayerId[] {
  return [...order].reverse();
}

/** 表示上の位置（0 が最上段）を、`moveLayer` に渡す store の添字へ変換する。 */
export function storeIndexFromDisplay(count: number, displayIndex: number): number {
  return count - 1 - displayIndex;
}

/** 1段上（dir=-1）または1段下（dir=+1）へ動かすときの、`moveLayer` に渡す store の添字。動けなければ null。 */
export function stepTarget(order: readonly LayerId[], id: LayerId, dir: -1 | 1): number | null {
  const i = order.indexOf(id);
  if (i < 0) return null;
  // 上へ = store の添字を増やす
  const to = i - dir;
  return to < 0 || to >= order.length ? null : to;
}

/**
 * ドラッグ中の指の位置から、挿入先を求める。
 * `centers` はドラッグ中の行を除いた各行の中心Y（上から順）、`y` は指のY。
 * 戻り値は、ドラッグ中の行を除いた並びの中での挿入位置（0〜centers.length）で、
 * そのまま移動後の表示上の位置になる。
 */
export function dropIndex(centers: readonly number[], y: number): number {
  let n = 0;
  for (const c of centers) if (c < y) n++;
  return n;
}
