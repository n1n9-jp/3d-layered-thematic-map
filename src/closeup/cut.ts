import { LAYER_IDS } from '../config';
import type { LayerId, LayerOptions } from '../config';
import { computeExposure } from '../aggregate/exposure';
import type { Exposure } from '../aggregate/exposure';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
import type { ElevationData } from '../types';
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
  /** 円の中の、浸水が想定される区域に住む人（人口と浸水想定の両方が読み込めたときだけ）。想定は options に従う */
  exposure: Exposure | null;
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
  options: LayerOptions,
): CloseupCut {
  if (typeof window !== 'undefined') window.__closeupCuts = (window.__closeupCuts ?? 0) + 1;
  const subsets: CloseupCut['subsets'] = {};
  const summaries: CloseupCut['summaries'] = {};
  for (const id of LAYER_IDS) {
    if (status[id] !== 'ready') continue;
    try {
      const sub = registry[id].subset(data[id], circle.x, circle.y, circle.r);
      subsets[id] = sub;
      summaries[id] = registry[id].summarize(sub, options);
    } catch (e) {
      console.error(`[closeup] ${id}`, e);
    }
  }
  const boundary =
    status.boundary === 'ready' && data.boundary
      ? clipBoundaryPaths(cachedBoundaryPaths(data.boundary as BoundaryData), circle.x, circle.y, circle.r)
      : null;
  let exposure: Exposure | null = null;
  const pop = subsets.population as PopulationData | undefined;
  if (pop && status.flood === 'ready' && data.flood) {
    try {
      // 人口は円の中のメッシュ、浸水と標高は切り出さない全体から引く（メッシュの中心を含むセルの値）
      exposure = computeExposure(pop, data.flood as FloodData, options.floodScenario, status.elevation === 'ready' ? (data.elevation as ElevationData) : null);
    } catch (e) {
      console.error('[closeup] exposure', e);
    }
  }
  return { circle, subsets, summaries, boundary, exposure };
}
