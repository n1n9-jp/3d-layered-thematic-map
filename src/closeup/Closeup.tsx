import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import DeckGL from '@deck.gl/react';
import type { DeckGLRef } from '@deck.gl/react';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { CLOSEUP_RADII, LAYER_IDS } from '../config';
import type { CloseupRadius, LayerId } from '../config';
import { registry } from '../layers';
import { probeMarkLayers } from '../probe/controller';
import { translationMatrix } from '../stack';
import { useMapStore } from '../store';
import { boundaryLayer } from '../view/boundaryLines';
import { VIEW } from '../view/camera';
import type { Size } from '../view/camera';
import { getSliderActive, subscribeSliderActive } from '../view/sliderActivity';
import { stackLabelLayers } from '../view/labelLayers';
import { topOf, withHeight } from '../view/layerHeights';
import { useDisplayedZ } from '../view/useDisplayedZ';
import type { Plane } from '../probe/ray';
import { circleFillLayer, circleLayer } from './closeupLayers';
import { closeupBox, closeupHeights, closeupView, pickCloseupPoint } from './closeupModel';
import type { CloseupCircle } from './closeupModel';
import { cutCloseup } from './cut';
import type { CloseupCut } from './cut';

/** 描画の設定。全体の地図と同じ（下から上へ描き、深度テストを切る）。 */
const DECK_PARAMETERS = { depthCompare: 'always', depthWriteEnabled: false } as const;

export function useCloseupCut(circle: CloseupCircle): CloseupCut {
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  // 切り出しは、固定した地点・半径・データが変わったときだけ行う。視点の角度や間隔が変わっても作り直さない。
  return useMemo(() => cutCloseup(data, status, circle), [data, status, circle.x, circle.y, circle.r]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** 積層（切り出した範囲だけを拡大したもの）。表示専用で、ドラッグも探針も受け付けない。 */
export function CloseupStack({ cut, size }: { cut: CloseupCut; size: Size }) {
  const { circle } = cut;
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const rotationX = useMapStore((s) => s.viewState.rotationX);
  const rotationOrbit = useMapStore((s) => s.viewState.rotationOrbit);

  const targets = useMemo(() => closeupHeights({ order, visible, solo, spacing }, circle.r), [order, visible, solo, spacing, circle.r]);
  const sliderActive = useSyncExternalStore(subscribeSliderActive, getSliderActive);
  const shown = useDisplayedZ(targets, sliderActive);
  const top = topOf(shown);

  const view = useMemo(
    () => closeupView({ circle, rotationX, rotationOrbit, top, size }),
    [circle, rotationX, rotationOrbit, top, size],
  );

  // 各レイヤーの描画結果は、目標の高さで作っておく。補間中の高さへは modelMatrix の差し替えだけで移す。
  const rendered = useMemo(() => {
    const out = {} as Record<LayerId, Layer[]>;
    for (const id of LAYER_IDS) {
      const z = targets[id];
      const sub = cut.subsets[id];
      out[id] =
        z === null || sub === undefined
          ? []
          : registry[id].render(sub, { z, modelMatrix: translationMatrix(z), opacity: 1, solo: solo === id, boundary: null });
    }
    return out;
  }, [cut, targets, solo]);

  const tiers = LAYER_IDS.filter((id) => shown[id] !== null)
    .map((id) => ({ id, z: shown[id] as number, i: order.indexOf(id) }))
    .sort((a, b) => a.z - b.z || a.i - b.i);

  const layers: Layer[] = [];
  let prevZ: number | null = null;
  for (const [k, { id, z }] of tiers.entries()) {
    // 間隔 0 などで同じ高さに重なる段は、塗りと円の縁を1枚ぶんだけ描く。
    const first = prevZ === null || Math.abs(z - prevZ) > 1;
    prevZ = z;
    if (first) layers.push(circleFillLayer(`closeup-fill-${id}`, circle, z), circleLayer(`closeup-edge-${id}`, circle, z, 2));
    layers.push(...rendered[id].map((l) => withHeight(l, targets[id] as number, z)));
    const next = tiers[k + 1];
    if (cut.boundary && !(next && Math.abs(next.z - z) <= 1)) layers.push(boundaryLayer(cut.boundary, `closeup-${id}`, z));
  }
  layers.push(...stackLabelLayers({ tiers, viewState: view, size, box: closeupBox(circle), prefix: 'closeup' }));
  layers.push(...probeMarkLayers(circle, true, tiers.map((t) => t.z)));

  // 円の中の平面をクリックすると、その地点が新しい中心になる（クリックした段の、その地点）。クリックできる円の中では、カーソルを十字にする。
  const planesRef = useRef<Plane[]>([]);
  planesRef.current = tiers.map((t) => ({ id: t.id, z: t.z })).reverse(); // 上の段が先頭
  const circleRef = useRef(circle);
  circleRef.current = circle;
  const pick = (info: PickingInfo) => {
    const { viewport } = info;
    if (!viewport || info.x < 0 || info.y < 0) return null;
    return pickCloseupPoint(viewport, info.x, info.y, planesRef.current, circleRef.current);
  };
  const deckRef = useRef<DeckGLRef>(null);
  const overCircle = useRef(false);
  const onHover = (info: PickingInfo) => {
    const over = pick(info) !== null;
    if (over === overCircle.current) return;
    overCircle.current = over;
    // deck.gl は描画のたびにカーソルを設定し直す。描画を待たずに、いま変える。
    const deck = deckRef.current?.deck;
    const target = (deck?.props.parent as HTMLElement | undefined) ?? deck?.getCanvas();
    if (target) target.style.cursor = over ? 'crosshair' : 'default';
  };
  const onClick = (info: PickingInfo) => {
    const p = pick(info);
    if (p) useMapStore.getState().setProbe({ x: p.x, y: p.y });
  };
  const getCursor = useCallback(() => (overCircle.current ? 'crosshair' : 'default'), []);

  return (
    <DeckGL
      ref={deckRef}
      views={VIEW}
      viewState={view}
      controller={false}
      parameters={DECK_PARAMETERS}
      layers={layers}
      onHover={onHover}
      onClick={onClick}
      getCursor={getCursor}
      style={{ background: '#000' }}
    />
  );
}

export function RadiusButtons({ radius }: { radius: CloseupRadius }) {
  return (
    <div className="cu-radius" role="group" aria-label="クローズアップの半径">
      {CLOSEUP_RADII.map((r) => (
        <button
          key={r}
          type="button"
          className="cu-btn"
          aria-pressed={r === radius}
          onClick={() => useMapStore.getState().setCloseupRadius(r)}
        >
          {r / 1000} km
        </button>
      ))}
    </div>
  );
}
