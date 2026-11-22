/**
 * 断面の線に沿った集計：浸水の深さが 3m 以上の区間の長さと、その区間から一定の距離以内にある、洪水・高潮で使える避難場所の数。
 * 純粋な計算。区間は、断面の浸水の系列（25 m ごとの標本。段の境目は標本の中間）から取る。
 */
import type { FloodScenario } from '../config';
import { SEVERE_DEPTH_POSITION } from '../layers/flood/classes';
import { sectionFlood } from '../layers/flood/model';
import type { FloodData } from '../layers/flood/model';
import type { ShelterData } from '../layers/shelters/model';
import { lineLength, pointAt } from '../lib/section';
import { closestPointOnSegment } from '../lib/spatialIndex';
import type { SectionLine } from '../types';

/** 「その区間から一定の距離」：直線距離で 1 km（徒歩で十数分）。 */
export const SEVERE_SHELTER_RADIUS = 1000;

export interface SectionFloodSummary {
  /** 線の長さ（m） */
  length: number;
  /** 浸水の深さが 3m 以上の区間（線に沿った距離 [d0, d1]。つながったものは1つ） */
  spans: [number, number][];
  /** その区間の長さの合計（m） */
  severeLength: number;
  /** その区間から SEVERE_SHELTER_RADIUS 以内にある、洪水・高潮で使える避難場所の数 */
  shelters: number;
  radius: number;
}

/** 系列の点（階段状）から、値が threshold 以上の区間をつないで返す。 */
export function spansAtLeast(points: readonly { d: number; value: number | null }[], threshold: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.value === null || b.value === null || !(a.value >= threshold) || !(b.value >= threshold) || !(b.d > a.d)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - a.d) < 1e-6) last[1] = b.d;
    else out.push([a.d, b.d]);
  }
  return out;
}

export function sectionFloodSummary(
  flood: FloodData,
  shelters: ShelterData,
  line: SectionLine,
  scenario: FloodScenario,
  radius: number = SEVERE_SHELTER_RADIUS,
): SectionFloodSummary {
  const series = sectionFlood(flood, line, { floodScenario: scenario, floodView: 'depth', populationView: 'total' });
  const spans = spansAtLeast(series.points, SEVERE_DEPTH_POSITION);
  const severeLength = spans.reduce((s, [a, b]) => s + (b - a), 0);
  const segs = spans.map(([a, b]) => {
    const p = pointAt(line, a);
    const q = pointAt(line, b);
    return [p.x, p.y, q.x, q.y] as const;
  });
  let count = 0;
  if (segs.length > 0)
    for (const [x, y] of shelters.points.usable) {
      if (segs.some((s) => closestPointOnSegment(x, y, s).distance <= radius)) count++;
    }
  return { length: lineLength(line), spans, severeLength, shelters: count, radius };
}
