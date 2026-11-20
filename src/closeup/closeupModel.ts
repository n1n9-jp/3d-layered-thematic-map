/**
 * クローズアップの純粋な計算。
 * クローズアップは、固定した地点を中心とする円の範囲だけを、全体の地図と同じ見方（段の順番、視点の角度）で拡大した積層。
 */
import { EXTENT, LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { layerZ } from '../stack';
import type { StackState } from '../stack';
import { CLOSEUP_LAYOUT } from '../view/layout';
import { fitView } from '../view/camera';
import type { PlaneBox, Size } from '../view/camera';
import type { ViewState } from '../store';
import type { ZMap } from '../view/useDisplayedZ';

/** 切り出す円。中心 (x, y)・半径 r（m）。 */
export interface CloseupCircle {
  x: number;
  y: number;
  r: number;
}

/** 全体の地図の平面の幅（m）。 */
export const PLANE_WIDTH = EXTENT.maxX - EXTENT.minX;

/**
 * クローズアップでのレイヤー間隔（m）。
 * 全体の地図の「間隔 ÷ 平面の幅」と、クローズアップの「間隔 ÷ 円の直径」が同じになるようにする。
 */
export function closeupSpacing(spacing: number, radius: number): number {
  return (spacing * 2 * radius) / PLANE_WIDTH;
}

/** 各段の高さ（クローズアップでの値）。全体の地図の `targets` に対応する。 */
export function closeupHeights(state: StackState, radius: number): ZMap {
  const s = { ...state, spacing: closeupSpacing(state.spacing, radius) };
  return Object.fromEntries(LAYER_IDS.map((id: LayerId) => [id, layerZ(s, id)])) as ZMap;
}

/** クローズアップの平面（円）の位置と大きさ。 */
export function closeupBox(c: CloseupCircle): PlaneBox {
  return { cx: c.x, cy: c.y, half: c.r, round: true };
}

/** クローズアップで許す zoom の範囲。半径 1 km の円は、1 px が数 m になる大きさまで拡大する。 */
const ZOOM_LIMITS = { min: -9, max: 3 };

/**
 * クローズアップの視点。角度（rotationX, rotationOrbit）は全体の地図と同じで、
 * 円（高さ 0〜top）が、領域の中に収まる最大の拡大率と位置を求める。
 */
export function closeupView(opts: {
  circle: CloseupCircle;
  rotationX: number;
  rotationOrbit: number;
  top: number;
  size: Size;
}): ViewState {
  const { circle, rotationX, rotationOrbit, top, size } = opts;
  const fit = fitView({ rotationX, rotationOrbit, top, size, layout: CLOSEUP_LAYOUT, box: closeupBox(circle), zoomLimits: ZOOM_LIMITS });
  return { rotationX, rotationOrbit, ...fit };
}

/** 半径 r（m）の表示。「半径 2 km」。 */
export function radiusLabel(r: number): string {
  return `半径 ${r / 1000} km`;
}
