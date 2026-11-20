import type { Layer, PickingInfo } from '@deck.gl/core';
import type { MapState } from '../store';

/** 探針の描画（垂直線など）。StackView が layers の末尾に足す。 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function probeLayers(state: MapState): Layer[] {
  return [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function onHover(info: PickingInfo): void {}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function onClick(info: PickingInfo): void {}
