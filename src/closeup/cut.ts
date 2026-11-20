import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import type { DataKey, LayerStatus } from '../store';
import type { BoundaryData, ProbeValue } from '../types';
import { cachedBoundaryPaths, clipBoundaryPaths } from '../view/boundaryLines';
import type { BoundaryPath } from '../view/boundaryLines';
import type { CloseupCircle } from './closeupModel';

/** 円で切り出した結果。固定した地点か半径が変わったときだけ作り直す。 */
export interface CloseupCut {
  circle: CloseupCircle;
  /** 各レイヤーの切り出したデータ。読み込みが済んでいないレイヤーは含まない。 */
  subsets: Partial<Record<LayerId, unknown>>;
  /** 各レイヤーの集計。subsets と同じ。 */
  summaries: Partial<Record<LayerId, ProbeValue[]>>;
  /** 円で切った区境界線。区境界が読み込めていなければ null。 */
  boundary: BoundaryPath[] | null;
}

declare global {
  interface Window {
    /** 切り出しを行った回数（確認用）。固定した地点か半径が変わったときだけ増える。 */
    __closeupCuts: number;
  }
}

/** 全レイヤーと区境界線を円で切り出し、集計する。 */
export function cutCloseup(
  data: Partial<Record<DataKey, unknown>>,
  status: Record<DataKey, LayerStatus>,
  circle: CloseupCircle,
): CloseupCut {
  if (typeof window !== 'undefined') window.__closeupCuts = (window.__closeupCuts ?? 0) + 1;
  const subsets: CloseupCut['subsets'] = {};
  const summaries: CloseupCut['summaries'] = {};
  for (const id of LAYER_IDS) {
    if (status[id] !== 'ready') continue;
    try {
      const sub = registry[id].subset(data[id], circle.x, circle.y, circle.r);
      subsets[id] = sub;
      summaries[id] = registry[id].summarize(sub);
    } catch (e) {
      console.error(`[closeup] ${id}`, e);
    }
  }
  const boundary =
    status.boundary === 'ready' && data.boundary
      ? clipBoundaryPaths(cachedBoundaryPaths(data.boundary as BoundaryData), circle.x, circle.y, circle.r)
      : null;
  return { circle, subsets, summaries, boundary };
}
