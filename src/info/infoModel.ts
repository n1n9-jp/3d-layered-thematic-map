/**
 * 「選んだ地点の情報」の列の、純粋な計算。
 * 列は、探針の状態で中身が3通りに変わる（幅は変わらない）。
 *   empty  ：探針がない。操作の手がかりを出す
 *   hover  ：カーソルを置いただけ。区名と「この地点」の値だけ
 *   pinned ：固定している。クローズアップと、「この地点」と「半径 ○km 内」を並べた表
 */
import type { LayerId } from '../config';
import type { LayerStatus } from '../store';
import type { ProbeValue } from '../types';
import { formatValue } from '../probe/formatValue';

export type ColumnMode = 'empty' | 'hover' | 'pinned';

/** 探針の有無と固定から、列の中身を決める。探針がなければ、固定の値にかかわらず empty。 */
export function columnMode(probe: { x: number; y: number } | null, pinned: boolean): ColumnMode {
  if (probe === null) return 'empty';
  return pinned ? 'pinned' : 'hover';
}

export type CellState = 'values' | 'none' | 'loading' | 'error';

/** 表の1マス。値が並ぶとき（values）以外は、状態だけを持つ。 */
export interface Cell {
  state: CellState;
  values: ProbeValue[];
}

export interface InfoRow {
  id: LayerId;
  label: string;
  /** 「この地点」の値 */
  point: Cell;
  /** 「半径 ○km 内」の集計。固定していない（集計がない）ときは null */
  area: Cell | null;
}

/** 読み込みの状態が ready でないときの、マスの状態。ready なら null。 */
function notReady(status: LayerStatus): Cell | null {
  if (status === 'error') return { state: 'error', values: [] };
  if (status !== 'ready') return { state: 'loading', values: [] };
  return null;
}

/** 「この地点」のマス。sample は読み込み済みのときだけ呼び、例外は握りつぶして「値なし」にする（onError に渡す）。 */
export function pointCell(status: LayerStatus, sample: () => ProbeValue[], onError?: (e: unknown) => void): Cell {
  const pending = notReady(status);
  if (pending) return pending;
  let values: ProbeValue[] = [];
  try {
    values = sample();
  } catch (e) {
    onError?.(e);
  }
  return { state: values.length > 0 ? 'values' : 'none', values };
}

/** 「半径 ○km 内」のマス。summary は切り出しの結果（読み込み前や切り出しに失敗したときは undefined）。 */
export function areaCell(status: LayerStatus, summary: ProbeValue[] | undefined): Cell {
  if (summary) return { state: summary.length > 0 ? 'values' : 'none', values: summary };
  if (status === 'error') return { state: 'error', values: [] };
  return { state: status === 'ready' ? 'none' : 'loading', values: [] };
}

/**
 * 表の行。ids は表示中のレイヤー（上の段から）。
 * summaries が null なら、集計のない表（hover）で、area はすべて null。
 */
export function buildRows(opts: {
  ids: readonly LayerId[];
  labels: Readonly<Record<LayerId, string>>;
  status: Readonly<Record<LayerId, LayerStatus>>;
  sample: (id: LayerId) => ProbeValue[];
  summaries: Partial<Record<LayerId, ProbeValue[]>> | null;
  onError?: (id: LayerId, e: unknown) => void;
}): InfoRow[] {
  const { ids, labels, status, sample, summaries, onError } = opts;
  return ids.map((id) => ({
    id,
    label: labels[id],
    point: pointCell(status[id], () => sample(id), (e) => onError?.(id, e)),
    area: summaries ? areaCell(status[id], summaries[id]) : null,
  }));
}

/** 値の見出し。レイヤー名と同じ（または空）なら、見出しは付けない。 */
export function valueTitle(v: ProbeValue, layerLabel: string): string | null {
  return v.label && v.label !== layerLabel ? v.label : null;
}

/** 値を、列に出す文字列にする。formatValue と同じ（値がなければ「—」）。 */
export const valueText = formatValue;

/** 「半径 2 km 内」。半径は m。 */
export function areaHeading(radiusM: number): string {
  return `半径 ${radiusM / 1000} km 内`;
}

/** 座標の表示。「x 8,172 m, y -1,342 m」。 */
export function coordsText(p: { x: number; y: number }): string {
  const f = (v: number) => Math.round(v).toLocaleString('ja-JP');
  return `x ${f(p.x)} m, y ${f(p.y)} m`;
}
