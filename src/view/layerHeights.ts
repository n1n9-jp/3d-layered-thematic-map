import type { Layer } from '@deck.gl/core';
import { LAYER_IDS } from '../config';
import { asModelMatrix, translationMatrix } from '../stack';
import type { ZMap } from './useDisplayedZ';

/** 表示中の段のうち、いちばん高い段の高さ。 */
export function topOf(zs: ZMap): number {
  let top = 0;
  for (const id of LAYER_IDS) top = Math.max(top, zs[id] ?? 0);
  return top;
}

/** layer の modelMatrix が `from` の高さの平行移動なら、`to` の高さに差し替えたレイヤーを返す。 */
export function withHeight(layer: Layer, from: number, to: number): Layer {
  if (from === to) return layer;
  const m = layer.props.modelMatrix as unknown as ArrayLike<number> | null | undefined;
  const expect = translationMatrix(from);
  if (!m || m.length !== 16 || !expect.every((v, i) => v === m[i])) return layer;
  return layer.clone({ modelMatrix: asModelMatrix(translationMatrix(to)) });
}
