import type { LayerProps } from '@deck.gl/core';
import type { LayerId } from './config';

/** 積層の計算に必要な状態。store の MapState から取り出せる。 */
export interface StackState {
  order: LayerId[];
  visible: Record<LayerId, boolean>;
  solo: LayerId | null;
  spacing: number;
}

/**
 * レイヤーの高さ（m）。
 * 表示中のレイヤーだけを order の順に下から詰め、`段の番号 × spacing` を返す。非表示なら null。
 * 単独表示中は、対象のレイヤーが 0、ほかは null。
 */
export function layerZ(state: StackState, id: LayerId): number | null {
  if (state.solo !== null) return state.solo === id ? 0 : null;
  if (!state.visible[id]) return null;
  let tier = 0;
  for (const other of state.order) {
    if (other === id) return tier * state.spacing;
    if (state.visible[other]) tier++;
  }
  return null; // order に含まれない
}

/** [0,0,z] への平行移動行列（列優先の16要素）。 */
export function translationMatrix(z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];
}

/** deck.gl レイヤーの modelMatrix prop に渡せる型。`ctx.modelMatrix` は `asModelMatrix(ctx.modelMatrix)` で渡す。 */
export type ModelMatrix = NonNullable<LayerProps['modelMatrix']>;
export function asModelMatrix(m: number[]): ModelMatrix {
  return m as unknown as ModelMatrix;
}
