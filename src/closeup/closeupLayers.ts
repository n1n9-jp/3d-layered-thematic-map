import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { asModelMatrix, translationMatrix } from '../stack';
import type { Position } from '../types';
import type { CloseupCircle } from './closeupModel';

/** 円の縁の線の色。探針の固定中の色（橙）と同系色で、細い線。 */
export const CIRCLE_COLOR: [number, number, number, number] = [255, 176, 0, 230];
/** クローズアップの平面の薄い塗り。 */
const CLOSEUP_FILL: [number, number, number, number] = [150, 175, 220, 9];

/** 円の外周の分割数。 */
const CIRCLE_STEPS = 128;

/** 円の縁（始点に戻る閉じた折れ線）。 */
export function circlePath(cx: number, cy: number, r: number, steps = CIRCLE_STEPS): Position[] {
  const out: Position[] = [];
  for (let k = 0; k < steps; k++) {
    const t = (2 * Math.PI * k) / steps;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  out.push([out[0][0], out[0][1]]);
  return out;
}

// 同じ円なら配列の参照を使い回す（段の高さが変わっても属性を再計算させない）。
let cached: { key: string; data: Position[][]; fill: Position[][] } | null = null;
function circleData(c: CloseupCircle) {
  const key = `${c.x},${c.y},${c.r}`;
  if (cached?.key !== key) {
    const path = circlePath(c.x, c.y, c.r);
    cached = { key, data: [path], fill: [path.slice(0, -1)] };
  }
  return cached;
}
const getPath = (d: Position[]) => d;
const getPolygon = (d: Position[]) => d;

/** 高さ z の段に描く、円の縁の線。 */
export function circleLayer(id: string, c: CloseupCircle, z: number, widthPx = 1.5): PathLayer<Position[]> {
  return new PathLayer<Position[]>({
    id,
    data: circleData(c).data,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    getPath,
    positionFormat: 'XY',
    getColor: CIRCLE_COLOR,
    getWidth: widthPx,
    widthUnits: 'pixels',
    billboard: true,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
}

/** クローズアップの各段の、円の薄い塗り（高さ z）。 */
export function circleFillLayer(id: string, c: CloseupCircle, z: number): SolidPolygonLayer<Position[]> {
  return new SolidPolygonLayer<Position[]>({
    id,
    data: circleData(c).fill,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    getPolygon,
    getFillColor: CLOSEUP_FILL,
    pickable: false,
  });
}
