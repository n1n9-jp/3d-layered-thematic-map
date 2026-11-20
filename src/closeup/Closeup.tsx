import { useMemo, useSyncExternalStore } from 'react';
import DeckGL from '@deck.gl/react';
import type { Layer } from '@deck.gl/core';
import { CLOSEUP_RADII, LAYER_IDS } from '../config';
import type { CloseupRadius, LayerId } from '../config';
import { registry } from '../layers';
import { cachedDistrictLookup } from '../probe/district';
import { probeMarkLayers } from '../probe/controller';
import { formatValue } from '../probe/formatValue';
import { layerZ, translationMatrix } from '../stack';
import { useMapStore } from '../store';
import type { BoundaryData } from '../types';
import { boundaryLayer } from '../view/boundaryLines';
import { VIEW } from '../view/camera';
import type { Size } from '../view/camera';
import { getSliderActive, subscribeSliderActive } from '../view/sliderActivity';
import { stackLabelLayers } from '../view/labelLayers';
import { topOf, withHeight } from '../view/layerHeights';
import { RIGHT_PANEL_W } from '../view/layout';
import { useDisplayedZ } from '../view/useDisplayedZ';
import { useElementSize } from '../view/useElementSize';
import { circleFillLayer, circleLayer } from './closeupLayers';
import { closeupBox, closeupHeights, closeupView, radiusLabel } from './closeupModel';
import type { CloseupCircle } from './closeupModel';
import { cutCloseup } from './cut';
import type { CloseupCut } from './cut';
import './Closeup.css';

/** 領域の下端に空ける高さ（px）。右下の出典の1行（画面の下端から約 24 px）を避ける。 */
const BOTTOM_RESERVE = 30;

/** 描画の設定。全体の地図と同じ（下から上へ描き、深度テストを切る）。 */
const DECK_PARAMETERS = { depthCompare: 'always', depthWriteEnabled: false } as const;

function useCloseupCut(circle: CloseupCircle): CloseupCut {
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  // 切り出しは、固定した地点・半径・データが変わったときだけ行う。視点の角度や間隔が変わっても作り直さない。
  return useMemo(() => cutCloseup(data, status, circle), [data, status, circle.x, circle.y, circle.r]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** 積層（切り出した範囲だけを拡大したもの）。表示専用で、ドラッグも探針も受け付けない。 */
function CloseupStack({ cut, size }: { cut: CloseupCut; size: Size }) {
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

  return (
    <DeckGL
      views={VIEW}
      viewState={view}
      controller={false}
      parameters={DECK_PARAMETERS}
      layers={layers}
      style={{ background: '#000' }}
    />
  );
}

function RadiusButtons({ radius }: { radius: CloseupRadius }) {
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

/** 円の中の集計。表示中の各レイヤー（上の段から）の summarize の結果を、探針の値の一覧と同じ形で並べる。 */
function CloseupSummary({ cut }: { cut: CloseupCut }) {
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const status = useMapStore((s) => s.status);

  const stack = { order, visible, solo, spacing };
  const ids = [...order].reverse().filter((id) => layerZ(stack, id) !== null);
  return (
    <dl className="cu-summary" data-testid="closeup-summary">
      {ids.map((id) => {
        const label = registry[id].label;
        const values = cut.summaries[id];
        return (
          <div key={id} className="cu-row" data-layer={id}>
            <dt>{label}</dt>
            <dd>
              {values ? (
                values.map((v, i) => (
                  <div key={i}>
                    {v.label && v.label !== label && <span className="cu-dim">{v.label} </span>}
                    {formatValue(v)}
                  </div>
                ))
              ) : (
                <span className="cu-dim">{status[id] === 'error' ? '読み込み失敗' : status[id] === 'ready' ? '—' : '読み込み中…'}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * クローズアップの領域。探針が固定されているあいだ、全体の地図の右隣（右上のパネルの左）に置く。
 * 見出し（区名と半径）と半径の切り替え、切り出した範囲の積層、円の中の集計を縦に並べる。
 * (x, y) は固定した地点（ローカルのメートル座標）、width は領域の幅（px）。
 */
export default function Closeup({ x, y, width }: { x: number; y: number; width: number }) {
  const radius = useMapStore((s) => s.closeupRadius);
  const boundary = useMapStore((s) => s.data.boundary);
  const boundaryReady = useMapStore((s) => s.status.boundary === 'ready');
  const [canvasBox, size] = useElementSize<HTMLDivElement>();

  const circle = useMemo<CloseupCircle>(() => ({ x, y, r: radius }), [x, y, radius]);
  const cut = useCloseupCut(circle);
  const district = boundaryReady && boundary ? cachedDistrictLookup(boundary as BoundaryData)(x, y) : null;

  return (
    <section
      className="cu"
      data-testid="closeup"
      aria-label="クローズアップ"
      style={{ right: RIGHT_PANEL_W, width, paddingBottom: BOTTOM_RESERVE }}
    >
      <header className="cu-head">
        <div className="cu-title" data-testid="closeup-title">
          <span className="cu-district">{district ?? '区の外'}</span>
          <span className="cu-radius-text">{radiusLabel(radius)}</span>
        </div>
        <RadiusButtons radius={radius} />
      </header>
      <div className="cu-canvas" ref={canvasBox}>
        {size && <CloseupStack cut={cut} size={size} />}
      </div>
      <CloseupSummary cut={cut} />
    </section>
  );
}
