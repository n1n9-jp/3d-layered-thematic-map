import { DEFAULT_OPTIONS } from '../config';
import type { LayerId, LayerOptions } from '../config';

const SCENARIO: Record<LayerOptions['floodScenario'], string> = { max: '大きいほう', river: '洪水', tide: '高潮' };
const FLOOD_VIEW: Record<LayerOptions['floodView'], string> = { depth: '深さ', duration: '期間' };

/**
 * レイヤー一覧の、閉じた行に小さく添える現在の選択。既定のままなら null（何も添えない）。
 * 浸水は想定と見るもの（例：「高潮・深さ」）、人口は見るもの（「65歳以上」）。
 */
export function selectionSummary(id: LayerId, o: LayerOptions): string | null {
  if (id === 'flood') {
    if (o.floodScenario === DEFAULT_OPTIONS.floodScenario && o.floodView === DEFAULT_OPTIONS.floodView) return null;
    return `${SCENARIO[o.floodScenario]}・${FLOOD_VIEW[o.floodView]}`;
  }
  if (id === 'population') return o.populationView === DEFAULT_OPTIONS.populationView ? null : '65歳以上';
  return null;
}
