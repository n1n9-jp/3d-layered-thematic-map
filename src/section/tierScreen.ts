/**
 * 全体の地図の各段の、画面上の位置を、右の列へ渡す小さな共有の状態。
 * 全体の地図（StackView）が、表示用の高さ（アニメーション中の補間した値）と目標の高さ、視点、描画領域の大きさを置き、
 * 右の列のチャート（SectionPanel）が、それを読んで各チャートの高さを決める。
 * 描画のフレームごとに更新されるので、zustand の store には置かない（購読するのは断面の右の列だけ）。
 */
import { useSyncExternalStore } from 'react';
import type { LayerId } from '../config';
import { EXTENT } from '../config';
import type { ViewState } from '../store';
import { projectPoint } from '../view/camera';
import type { Size } from '../view/camera';

export type ZByLayer = Record<LayerId, number | null>;

export interface TierScreen {
  size: Size;
  /** いまの視点（アニメーション中は、途中の値）。 */
  viewState: ViewState;
  /** 落ち着いたあとの視点（段の高さが目標に着き、積層が画面に収まり直したあと）。視点を利用者が動かしているときは、いまの視点と同じ。 */
  goalView: ViewState;
  /** 表示用の高さ（補間中）。 */
  shown: ZByLayer;
  /** 目標の高さ。 */
  goal: ZByLayer;
  /** 描画領域の上端の、ブラウザの画面での位置（px）。 */
  top: number;
}

let current: TierScreen | null = null;
const listeners = new Set<() => void>();

export function publishTierScreen(next: TierScreen): void {
  const c = current;
  if (c && c.size === next.size && c.viewState === next.viewState && c.goalView === next.goalView && c.shown === next.shown && c.goal === next.goal && c.top === next.top) return;
  current = next;
  for (const l of listeners) l();
}

export function clearTierScreen(): void {
  if (current === null) return;
  current = null;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 全体の地図が公開している、各段の画面上の位置の素材。まだなければ null。 */
export function useTierScreen(): TierScreen | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** 平面の中心（描画範囲の中心）の、画面（ブラウザの画面）上の高さ（px）。全体の地図の段の名前の位置と同じ高さ。 */
export function planeCenterY(ts: Pick<TierScreen, 'viewState' | 'size' | 'top'>, z: number): number {
  const cx = (EXTENT.minX + EXTENT.maxX) / 2;
  const cy = (EXTENT.minY + EXTENT.maxY) / 2;
  return ts.top + projectPoint(ts.viewState, ts.size, [cx, cy, z])[1];
}
