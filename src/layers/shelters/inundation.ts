/**
 * 洪水・高潮で使える避難場所が、浸水が想定される区域の中にあるか、外にあるか。純粋な計算。
 *
 * - 「中」は、その位置の浸水の深さが 0.5m 以上（深さの段が 0.5〜3m 以上）のこと。それ以外（0.5m 未満、浸水なし、浸水想定の範囲の外）は「外」。
 * - 判定は常に深さで行う。画面の「見るもの」（深さ／水が引くまで）には従わない。想定（洪水と高潮の大きいほう・洪水・高潮）には従う。
 * - 浸水の格子と取り出し方（`../flood/model` の `cellIndexAt`・`positionAt`）は、読むだけで使う。
 * - 想定は3通りしかなく、避難場所は 700 件ほどなので、データを作るときに3通りとも求めておく（視点の操作やカーソルの移動では計算しない）。
 */
import { FLOOD_SCENARIOS } from '../../config';
import type { FloodScenario } from '../../config';
import type { Position } from '../../types';
import { DEPTH_CLASSES, floodScheme } from '../flood/classes';
import { cellIndexAt, positionAt } from '../flood/model';
import type { FloodData } from '../flood/model';

/** 「中」にする深さ（m）。 */
export const INSIDE_MIN_DEPTH_M = 0.5;

/** 深さの段のうち、下限が `INSIDE_MIN_DEPTH_M` 以上になる最初の段の位置（1 始まり）。段の定義から求める。 */
export const INSIDE_MIN_POSITION = DEPTH_CLASSES.findIndex((c) => c.min >= INSIDE_MIN_DEPTH_M) + 1;

/** 想定ごとの、各点の判定。1 = 浸水が想定される区域の中、0 = 外。 */
export type Inundation = Record<FloodScenario, Uint8Array>;

/** 点 (x, y) が、想定 scenario の浸水が想定される区域の中か。格子の外・23区の外は外。 */
export function isInside(flood: FloodData, scenario: FloodScenario, x: number, y: number): boolean {
  const i = cellIndexAt(flood, x, y);
  if (i === null) return false;
  const p = positionAt(flood, floodScheme(scenario, 'depth'), i);
  return p !== null && p >= INSIDE_MIN_POSITION;
}

/** points の各点の判定を、3つの想定すべてについて求める。 */
export function computeInundation(points: readonly Position[], flood: FloodData): Inundation {
  const out = {} as Inundation;
  for (const scenario of FLOOD_SCENARIOS) {
    const a = new Uint8Array(points.length);
    for (let i = 0; i < points.length; i++) a[i] = isInside(flood, scenario, points[i][0], points[i][1]) ? 1 : 0;
    out[scenario] = a;
  }
  return out;
}

/** 想定ごとの「外」「中」の言い方（画面の文言）。位置の記述にとどめ、使える・使えないは言わない。 */
export const INSIDE_LABEL = '浸水が想定される区域の中';
export const OUTSIDE_LABEL = '浸水が想定される区域の外';
