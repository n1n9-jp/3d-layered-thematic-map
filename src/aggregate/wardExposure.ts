/**
 * 区ごとの「浸水が想定される区域に住む人の割合」と、洪水・高潮用の指定が 0 件の区の分類。純粋な計算（deck.gl・React に依存しない）。
 *
 * 数え方は、23区全体の集計（`exposure.ts`）と同じ：人口の250mメッシュごとに、メッシュの中心を含む浸水想定のセル（50 m）の深さの段を引き、
 * メッシュの人口を丸ごと数える（面積での按分はしない）。メッシュは、中心を含む区に数える。想定は、洪水と高潮の大きいほう（`max`）に固定する
 * （画面の想定の切り替えで、区の分類が変わらないようにする）。
 *
 * 分類：洪水・高潮用の指定緊急避難場所が 0 件で、データを公開している区を、その区の浸水の想定で2つに分ける。
 *   深さ 3m 以上の区域に住む人が、区の人口の `DEEP_SHARE_THRESHOLD`（10%）以上 → 「浸水が深いのに指定がない」（deep-none）
 *   それ未満 → 「浸水が小さく指定がない」（shallow-none）
 * 区の名前は決め打ちにしない（データから求める）。
 */
import { gridCell } from '../lib/grid';
import { floodScheme, SEVERE_DEPTH_POSITION } from '../layers/flood/classes';
import { positionAt } from '../layers/flood/model';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
import { cachedDistrictLookup } from '../probe/district';
import type { BoundaryData } from '../types';

/** 深さ 3m 以上の区域に住む人が区の人口のこの割合以上なら、「浸水が深い区」とする。 */
export const DEEP_SHARE_THRESHOLD = 0.1;

export interface WardExposure {
  name: string;
  /** 浸水想定の格子の内側に中心があるメッシュの人口の合計（人） */
  people: number;
  /** 浸水が想定される（0.5m 未満を含む）区域に住む人（人） */
  flooded: number;
  /** 深さ 3m 以上の区域に住む人（人） */
  severe: number;
  /** flooded / people（0〜1。人口 0 なら 0） */
  floodedShare: number;
  /** severe / people（0〜1。人口 0 なら 0） */
  severeShare: number;
}

/**
 * 区ごとの集計（想定は、洪水と高潮の大きいほう）。区境界にない区は含まない。
 * 戻り値は、区境界の並びの区名 → 集計。
 */
export function computeWardExposure(pop: Pick<PopulationData, 'cells'>, flood: FloodData, boundary: BoundaryData): Map<string, WardExposure> {
  const scheme = floodScheme('max', 'depth');
  const lookup = cachedDistrictLookup(boundary);
  const acc = new Map<string, { people: number; flooded: number; severe: number }>();
  for (const f of boundary.features) acc.set(f.properties.name, { people: 0, flooded: 0, severe: 0 });
  for (const c of pop.cells) {
    const [x, y] = c.center;
    const cell = gridCell(flood, x, y);
    const p = cell ? positionAt(flood, scheme, cell.row * flood.width + cell.col) : null;
    if (p === null) continue;
    const ward = lookup(x, y);
    const a = ward === null ? undefined : acc.get(ward);
    if (!a) continue;
    const n = Number.isFinite(c.population) ? c.population : 0;
    a.people += n;
    if (p >= 1) a.flooded += n;
    if (p >= SEVERE_DEPTH_POSITION) a.severe += n;
  }
  const out = new Map<string, WardExposure>();
  for (const [name, a] of acc)
    out.set(name, {
      name,
      ...a,
      floodedShare: a.people > 0 ? a.flooded / a.people : 0,
      severeShare: a.people > 0 ? a.severe / a.people : 0,
    });
  return out;
}

/**
 * 避難場所の指定の状況で分けた区の種類。指定緊急避難場所が洪水・高潮で使える区（`null`）以外の4通り。
 *   unpublished  : データ未公開。このデータに指定緊急避難場所を公開していない（「ない」ではなく「データがない」）
 *   deep-none    : 洪水・高潮用の指定が 0 件で、浸水が深い（深さ 3m 以上の区域に住む人が区の人口の 10% 以上）
 *   shallow-none : 洪水・高潮用の指定が 0 件で、浸水が小さい
 *   unrated      : 洪水・高潮用の指定が 0 件だが、浸水の想定から区の様子を求められなかった（人口か浸水想定の読み込み失敗）
 */
export type ShelterGap = 'unpublished' | 'deep-none' | 'shallow-none' | 'unrated';

export interface WardShelterFacts {
  published: boolean;
  /** 洪水か高潮で使える避難場所の数 */
  usable: number;
}

/** 区の分類。洪水・高潮で使える避難場所がある区は null。 */
export function classifyWard(ward: WardShelterFacts, exposure: Pick<WardExposure, 'severeShare'> | undefined, threshold = DEEP_SHARE_THRESHOLD): ShelterGap | null {
  if (!ward.published) return 'unpublished';
  if (ward.usable > 0) return null;
  if (!exposure) return 'unrated';
  return exposure.severeShare >= threshold ? 'deep-none' : 'shallow-none';
}

/** 割合（0〜1）の表示。10% 以上は整数、それ未満は小数1桁、0.05% 未満で 0 でなければ「0.1% 未満」。 */
export function shareLabel(share: number): string {
  if (!(share >= 0)) return '—';
  const p = share * 100;
  if (p === 0) return '0%';
  if (p < 0.05) return '0.1% 未満';
  return Math.round(p * 10) / 10 >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1)}%`;
}

/**
 * 人数の概数。1,000 人未満：そのまま。1 万人未満：約 N,NNN 人（百の位で四捨五入）。1 万人以上 10 万人未満：約 N.N 万人（小数1桁）。
 * 10 万人以上：約 NNN 万人（万の位で四捨五入。例：2,415,153 → 約242万人）。
 */
export function approxPeople(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const r = Math.round(n);
  if (r < 1000) return `${r.toLocaleString('ja-JP')}人`;
  if (r < 10000) return `約${(Math.round(r / 100) * 100).toLocaleString('ja-JP')}人`;
  if (r < 100000) {
    const m = Math.round(r / 1000) / 10;
    return `約${m.toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}万人`;
  }
  return `約${Math.round(r / 10000).toLocaleString('ja-JP')}万人`;
}
