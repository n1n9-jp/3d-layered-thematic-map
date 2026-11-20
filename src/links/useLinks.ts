import { useMemo } from 'react';
import { useMapStore } from '../store';
import { cachedLinks } from './compute';
import type { Circle3, LinkSet } from './compute';

/**
 * 固定した円についての、対応の線の関係。円が null（固定していない）か、どちらの関係もオフなら null。
 * 計算は、固定した地点・半径・データが変わったときだけ。全体の地図・クローズアップ・表は、同じ結果を共有する。
 */
export function useLinkSet(circle: Circle3 | null): LinkSet | null {
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  const anyOn = useMapStore((s) => s.links['facility-station'] || s.links['station-population']);
  const x = circle?.x;
  const y = circle?.y;
  const r = circle?.r;
  return useMemo(
    () => (x === undefined || y === undefined || r === undefined || !anyOn ? null : cachedLinks(data, status, { x, y, r })),
    [data, status, anyOn, x, y, r],
  );
}
