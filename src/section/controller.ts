/**
 * 「断面」のときの、全体の地図の上のカーソルとクリック。
 * - 始点を置いたあと：カーソルの下の地点を覚え、線の下書きを出す
 * - 線があるとき：カーソルが切り口の線の近くなら、線に沿った距離を store に置く（右のグラフと連動する）
 * - クリック：始点 → 終点 → 引き直し（`clickSection`）
 */
import type { PickingInfo } from '@deck.gl/core';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { pickFromInfo, visiblePlanes } from '../probe/controller';
import { useMapStore } from '../store';
import type { MapState } from '../store';
import { clearSection, clickSection, distanceAlongLine } from './interaction';
import type { LineHeight } from './interaction';
import { standHeight } from './model';
import type { SectionLine } from '../types';

/** カーソルが切り口の線の「近く」と見なす距離（px）。 */
export const HOVER_NEAR_PX = 14;

type StackInput = Pick<MapState, 'order' | 'visible' | 'solo' | 'spacing'>;

/**
 * 切り口の線を画面に投影する高さ。各段の平面と、その上に立てたグラフの中ほどと上端
 * （グラフの上にカーソルがあっても、線の近くと見なす）。単独表示のときは立てないので、平面だけ。
 */
export function sectionHeights(state: StackInput): LineHeight[] {
  const h = state.solo === null ? standHeight(state.spacing) : 0;
  return visiblePlanes(state).flatMap((p) =>
    h > 0
      ? [{ plane: p.z, at: p.z, id: p.id }, { plane: p.z, at: p.z + h / 2, id: p.id }, { plane: p.z, at: p.z + h, id: p.id }]
      : [{ plane: p.z, at: p.z, id: p.id }],
  );
}

export function onSectionHover(info: PickingInfo): void {
  const s = useMapStore.getState();
  if (s.mode !== 'section') return;
  if (s.sectionStart) {
    const hit = pickFromInfo(info);
    if (!hit) {
      if (s.sectionCursor !== null) s.setSectionCursor(null);
    } else if (s.sectionCursor?.x !== hit.x || s.sectionCursor?.y !== hit.y) {
      s.setSectionCursor({ x: hit.x, y: hit.y });
    }
    return;
  }
  const { viewport } = info;
  if (!s.section || !viewport || info.x < 0 || info.y < 0) {
    s.setSectionHover(null);
    clearMapFocus(s);
    return;
  }
  const near = distanceAlongLine({
    project: (p) => viewport.project(p),
    line: s.section,
    heights: sectionHeights(s),
    px: info.x,
    py: info.y,
    maxPx: HOVER_NEAR_PX,
  });
  s.setSectionHover(near ? Math.round(near.d) : null);
  // 切り口の近くにある段の、右のチャートを目立たせる（右のチャートにカーソルがあるあいだは、そちらを優先して変えない）。
  const id = near?.height.id;
  if (id && (LAYER_IDS as readonly string[]).includes(id)) s.setSectionFocus({ id: id as LayerId, from: 'map' });
  else clearMapFocus(s);
}

/** 全体の地図のカーソルによる目立たせ方だけを消す（右のチャートにカーソルがあるときの分は残す）。 */
function clearMapFocus(s: MapState): void {
  if (s.sectionFocus?.from === 'map') s.setSectionFocus(null);
}

export function onSectionClick(info: PickingInfo): void {
  const s = useMapStore.getState();
  if (s.mode !== 'section') return;
  const hit = pickFromInfo(info);
  if (!hit) return; // 平面の外のクリックでは、何も変えない（Esc で消す）
  const next = clickSection({ line: s.section, start: s.sectionStart }, hit);
  s.setSection(next.line);
  s.setSectionStart(next.start);
  s.setSectionCursor(null);
  s.setSectionHover(null);
}

/** 例の線を、そのまま引く（クリックで始点・終点を置くのと同じ状態にする）。 */
export function placeSection(line: SectionLine): void {
  const s = useMapStore.getState();
  s.setSection(line);
  s.setSectionStart(null);
  s.setSectionCursor(null);
  s.setSectionHover(null);
  s.setSectionFocus(null);
}

/** 線と、置きかけの始点を消す。 */
export function releaseSection(): void {
  const s = useMapStore.getState();
  const next = clearSection();
  s.setSection(next.line);
  s.setSectionStart(next.start);
  s.setSectionCursor(null);
  s.setSectionHover(null);
  s.setSectionFocus(null);
}

/** 「断面」のとき、Esc で線を消す。解除関数を返す。 */
export function installSectionKeys(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const handler = (e: Event) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    const s = useMapStore.getState();
    if (s.mode === 'section' && (s.section || s.sectionStart)) releaseSection();
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}
