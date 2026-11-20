import type { Circle } from '../../lib/circleClip';
import { pointInCircle } from '../../lib/circleClip';
import { sampleGrid } from '../../lib/grid';
import { isUsableLine, lineLength, lineTouchesBox, pointAt } from '../../lib/section';
import type { ElevationData, SectionLine, SectionSeries } from '../../types';
import { elevationColor } from './color';

/** 標高を取る間隔（m）。 */
export const ELEVATION_SECTION_STEP = 25;
/** 縦軸の範囲の目安（m）。標高の配色の区切り（-5m〜50m）に合わせる。 */
export const ELEVATION_SECTION_DOMAIN: [number, number] = [-5, 50];

/**
 * 線に沿って 25 m 間隔（と、線の終点）で標高を取る。値は `sampleGrid`（探針と同じ、点を含むセルの値）で、
 * データなし（水面・23区の外・格子の外）は null。
 * 線の長さが 0 のとき、線が格子の範囲に届かないときは、点のない系列を返す。
 * subset の結果（`clip` つき）では、円の外を null にする（`sample` と同じ）。
 */
export function sectionElevation(data: ElevationData & { clip?: Circle }, line: SectionLine): SectionSeries {
  const series: SectionSeries = {
    kind: 'series',
    label: '標高',
    unit: 'm',
    points: [],
    domain: ELEVATION_SECTION_DOMAIN,
    color: (v) => {
      const [r, g, b] = elevationColor(v);
      return [r, g, b];
    },
  };
  const len = lineLength(line);
  if (!isUsableLine(line) || !lineTouchesBox(line, data)) return series;
  const valueAt = (d: number): number | null => {
    const { x, y } = pointAt(line, d);
    if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return null;
    return sampleGrid(data, x, y);
  };
  const steps = Math.floor(len / ELEVATION_SECTION_STEP);
  for (let i = 0; i <= steps; i++) {
    const d = i * ELEVATION_SECTION_STEP;
    series.points.push({ d, value: valueAt(d) });
  }
  if (len - steps * ELEVATION_SECTION_STEP > 1e-9) series.points.push({ d: len, value: valueAt(len) });
  return series;
}
