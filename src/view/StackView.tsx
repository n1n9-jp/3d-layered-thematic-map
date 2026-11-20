import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DeckGL from '@deck.gl/react';
import type { DeckGLRef } from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { EXTENT, LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import { onClick, onHover, probeLayers, visiblePlanes } from '../probe/controller';
import { installMarkDrag } from '../probe/markDrag';
import type { MarkCursor } from '../probe/markDrag';
import { onSectionClick, onSectionHover, sectionHeights } from '../section/controller';
import { draftLine } from '../section/interaction';
import { installSectionDrag } from '../section/lineDrag';
import { standHeight } from '../section/model';
import { sectionCurtainLayer, sectionCursorLayers, sectionLineLayers, sectionPoleLayers, sectionStandLayers } from '../section/sectionLayers';
import { useSectionTracks } from '../section/tracks';
import { asModelMatrix, layerZ, translationMatrix } from '../stack';
import { useMapStore, viewQuery } from '../store';
import type { MapState, ViewState } from '../store';
import type { BoundaryData } from '../types';
import { boundaryLayer, cachedBoundaryPaths } from './boundaryLines';
import { DEFAULT_ANGLES, LIMITS, SOLO_ANGLES, VIEW, clamp, fitStack, nearestAngle } from './camera';
import type { Size } from './camera';
import { circleLayer } from '../closeup/closeupLayers';
import { stackLabelLayers } from './labelLayers';
import { topOf, withHeight } from './layerHeights';
import { useElementSize } from './useElementSize';
import { RIGHT_PANEL_W } from './layout';
import { resolveAngles, subscribeViewCommand } from './viewPresets';
import type { Angles } from './viewPresets';
import { getSliderActive, subscribeSliderActive } from './sliderActivity';
import { useDisplayedZ } from './useDisplayedZ';
import type { ZMap } from './useDisplayedZ';

const { minX, minY, maxX, maxY } = EXTENT;

type P3 = [number, number, number];
const FRAME = [{ path: [[minX, minY, 0], [maxX, minY, 0], [maxX, maxY, 0], [minX, maxY, 0], [minX, minY, 0]] as P3[] }];
const PLANE = [[[minX, minY, 0], [maxX, minY, 0], [maxX, maxY, 0], [minX, maxY, 0]] as P3[]];

// 区境界線が主役なので、外枠と塗りはごく控えめにする。
const FRAME_COLOR: [number, number, number, number] = [130, 145, 170, 90];
const FILL_COLOR: [number, number, number, number] = [150, 175, 220, 9];
/** 視点を切り替えるアニメーションの長さ（ms）。 */
const TRANSITION_MS = 700;
/**
 * アニメーションの終了を deck.gl が知らせてこないときのための、遅い側の保険（ms）。
 * 描画が遅い環境（1フレーム約2秒の実データ）でも、アニメーションの最後のフレームが来る前に打ち切らないよう、長めにとる。
 * 通常は、終了の知らせ（onViewStateChange）か利用者の操作で、これより早く終わる。
 */
const TRANSITION_FAILSAFE_MS = TRANSITION_MS + 4000;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** DeckGL 全体の描画設定。平面はすべて水平でカメラは常に上側なので、下から上へ描き、深度テストを切る。 */
const DECK_PARAMETERS = { depthCompare: 'always', depthWriteEnabled: false } as const;
const CONTROLLER = { doubleClickZoom: false } as const;

const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
function sameView(a: ViewState, b: ViewState) {
  return (
    same(a.zoom, b.zoom) &&
    same(a.rotationX, b.rotationX) &&
    same(a.rotationOrbit, b.rotationOrbit) &&
    a.target.every((v, i) => same(v, b.target[i]))
  );
}

interface Saved {
  view: ViewState;
  auto: boolean;
}

interface Props {
  /**
   * 情報の列の幅（px）。列は、この描画領域の右端に重ねて置かれ、中身の有無にかかわらず常にある。
   * 積層は、この幅を避けた配置で拡大率と位置を決める（探針の有無や固定の前後で、大きさも位置も変わらない）。
   */
  columnWidth: number;
}

export default function StackView({ columnWidth }: Props) {
  const state = useMapStore();
  const { order, visible, solo, spacing, data, status, viewState, closeupRadius } = state;
  const sectionMode = state.mode === 'section';
  // 範囲の円は「地点」のときだけ。「断面」のあいだは、固定した探針は残っているが、描かない。
  const closeup = !sectionMode && state.probePinned && state.probe ? { ...state.probe, r: closeupRadius } : null;
  const { line: sectionLine, tracks: sectionTracks } = useSectionTracks();
  const { sectionStart, sectionCursor, sectionHover } = state;

  /* ---------- 画面の大きさ ---------- */
  const [box, size] = useElementSize<HTMLDivElement>();

  /* ---------- 各レイヤーの高さ（目標値と表示用） ---------- */
  const targets = useMemo(
    () => Object.fromEntries(LAYER_IDS.map((id) => [id, layerZ({ order, visible, solo, spacing }, id)])) as ZMap,
    [order, visible, solo, spacing],
  );
  const sliderActive = useSyncExternalStore(subscribeSliderActive, getSliderActive);
  const shown = useDisplayedZ(targets, sliderActive);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  /* ---------- 固定した探針の印、断面の線の端点と線をつかんで動かす ---------- */
  const deckRef = useRef<DeckGLRef>(null);
  /** 印の上のカーソル。null なら、deck.gl の既定（視点を回せる手のひら。「断面」で線を引くときは十字）。 */
  const markCursor = useRef<MarkCursor | null>(null);
  const sectionModeRef = useRef(sectionMode);
  sectionModeRef.current = sectionMode;
  const restCursor = () => (sectionModeRef.current ? 'crosshair' : 'grab');
  const setMarkCursor = useCallback((c: MarkCursor | null) => {
    markCursor.current = c;
    // deck.gl は、描画のたびにカーソルを設定し直す。描画を待たずに、いま変える。
    const deck = deckRef.current?.deck;
    const target = (deck?.props.parent as HTMLElement | undefined) ?? deck?.getCanvas();
    if (target) target.style.cursor = c ?? restCursor();
  }, []);
  const getViewport = useCallback(
    () => (deckRef.current?.deck?.getViewports()[0] as ReturnType<Parameters<typeof installMarkDrag>[1]['getViewport']>) ?? null,
    [],
  );
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const offProbe = installMarkDrag(el, {
      getViewport,
      getMarks: () => {
        const s = useMapStore.getState();
        return s.mode === 'point' && s.probePinned && s.probe ? { probe: s.probe, zs: visiblePlanes(s).map((p) => p.z) } : null;
      },
      setPoint: (p) => useMapStore.getState().setProbe(p),
      setCursor: setMarkCursor,
    });
    const offSection = installSectionDrag(el, {
      getViewport,
      getTarget: () => {
        const s = useMapStore.getState();
        return s.mode === 'section' && s.section && !s.sectionStart
          ? { line: s.section, planes: visiblePlanes(s).map((p) => p.z), heights: sectionHeights(s) }
          : null;
      },
      setLine: (l) => useMapStore.getState().setSection(l),
      setCursor: setMarkCursor,
    });
    return () => {
      offProbe();
      offSection();
    };
  }, [box, getViewport, setMarkCursor]);
  const getCursor = useCallback(
    ({ isDragging }: { isDragging: boolean }) => markCursor.current ?? (isDragging ? 'grabbing' : restCursor()),
    [],
  );

  /* ---------- 視点 ---------- */
  const [ready, setReady] = useState(false);
  const [transition, setTransition] = useState(false);
  /** true の間は、画面の大きさや積層の高さに合わせて target と zoom を追従させる（利用者が視点を動かすまで）。 */
  const autoFit = useRef(true);
  /** autoFit を変える。ボタンの選択中表示のために、store にも写す。 */
  const setAutoFit = useCallback((v: boolean) => {
    autoFit.current = v;
    useMapStore.getState().setAutoFit(v);
  }, []);
  const saved = useRef<Saved | null>(null);
  const clearTimer = useRef<number>(0);
  const prevSolo = useRef<LayerId | null>(null);
  /** 視点のボタンで移動中の、行き先の角度。連打しても、補間途中の値ではなく行き先から数える。 */
  const goal = useRef<Angles | null>(null);
  const readyRef = useRef(false);
  readyRef.current = ready;
  const sizeRef = useRef<Size | null>(null);
  sizeRef.current = size;
  const columnWidthRef = useRef(columnWidth);
  columnWidthRef.current = columnWidth;
  /** 積層が収まる視点（target と zoom）。 */
  const fit = useCallback(
    (a: { rotationX: number; rotationOrbit: number; top: number }, sz: Size) =>
      fitStack({ ...a, size: sz, columnWidth: columnWidthRef.current }),
    [],
  );

  const startTransition = useCallback((next: ViewState) => {
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => {
      setTransition(false);
      goal.current = null;
    }, TRANSITION_FAILSAFE_MS);
    setTransition(true);
    useMapStore.getState().setViewState(next);
  }, []);

  // 初期視点。URL クエリ（rx, ro, zoom）があればそちらを優先する。
  useLayoutEffect(() => {
    if (ready || !size) return;
    const { rx, ro, zoom } = viewQuery(location.search);
    const rotationX = rx ?? DEFAULT_ANGLES.rotationX;
    const rotationOrbit = ro ?? DEFAULT_ANGLES.rotationOrbit;
    const set = useMapStore.getState().setViewState;

    const view3D = { rotationX, rotationOrbit, ...fit({ rotationX, rotationOrbit, top: topOf(targets) }, size) };
    if (zoom !== null) view3D.zoom = zoom;
    setAutoFit(zoom === null);

    if (solo !== null) {
      saved.current = { view: view3D, auto: autoFit.current };
      setAutoFit(true);
      set({ ...SOLO_ANGLES, ...fit({ ...SOLO_ANGLES, top: 0 }, size) });
    } else {
      set(view3D);
    }
    prevSolo.current = solo;
    setReady(true);
  }, [ready, size, solo, targets, setAutoFit, fit]);

  // 画面の大きさや積層の高さが変わったら、収まるように追従する（アニメーション中は行わない）。
  const top = topOf(shown);
  useEffect(() => {
    if (!ready || !size || !autoFit.current || transition) return;
    const vs = useMapStore.getState().viewState;
    const next = { ...vs, ...fit({ rotationX: vs.rotationX, rotationOrbit: vs.rotationOrbit, top }, size) };
    if (!sameView(vs, next)) useMapStore.getState().setViewState(next);
  }, [ready, size, top, transition, columnWidth, fit]);

  // 単独表示の開始と解除。
  useEffect(() => {
    if (!ready || !size || solo === prevSolo.current) return;
    prevSolo.current = solo;
    const vs = useMapStore.getState().viewState;
    if (solo !== null) {
      if (!saved.current) saved.current = { view: vs, auto: autoFit.current };
      setAutoFit(true);
      startTransition({
        ...SOLO_ANGLES,
        rotationOrbit: nearestAngle(SOLO_ANGLES.rotationOrbit, vs.rotationOrbit),
        ...fit({ ...SOLO_ANGLES, top: 0 }, size),
      });
    } else if (saved.current) {
      const prev = saved.current;
      saved.current = null;
      setAutoFit(prev.auto);
      const rotationOrbit = nearestAngle(prev.view.rotationOrbit, vs.rotationOrbit);
      startTransition(
        prev.auto
          ? {
              ...prev.view,
              rotationOrbit,
              ...fit({ rotationX: prev.view.rotationX, rotationOrbit, top: topOf(targetsRef.current) }, size),
            }
          : { ...prev.view, rotationOrbit },
      );
    }
  }, [ready, size, solo, startTransition, setAutoFit, fit]);

  // 視点のボタン。決まった視点や、方位を45度回した視点へアニメーションで移り、そこで積層が収まるように合わせる。
  // 単独表示のあいだは受け付けない（2D 表示に固定されている）。
  useEffect(
    () =>
      subscribeViewCommand((cmd) => {
        const sz = sizeRef.current;
        if (!readyRef.current || !sz || useMapStore.getState().solo !== null) return;
        const angles = resolveAngles(cmd, goal.current ?? useMapStore.getState().viewState);
        goal.current = angles;
        setAutoFit(true);
        startTransition({ ...angles, ...fit({ ...angles, top: topOf(targetsRef.current) }, sz) });
      }),
    [startTransition, setAutoFit, fit],
  );

  const onViewStateChange = useCallback(
    ({ viewState: v, interactionState }: { viewState: Record<string, unknown>; interactionState?: Record<string, boolean | undefined> }) => {
      const is = interactionState ?? {};
      if (!is.inTransition) {
        window.clearTimeout(clearTimer.current);
        setTransition(false);
        goal.current = null;
        if (is.isDragging || is.isPanning || is.isRotating || is.isZooming) setAutoFit(false);
      }
      const vs = v as unknown as ViewState;
      const t = vs.target;
      // 注視点を描画範囲に収めるのは、利用者の操作のときだけ。アニメーションの途中と終わりは、収め直した視点をそのまま使う。
      // 収め直した視点の注視点は、積層を画面の中心から寄せて置くために、描画範囲の外にあることがある（傾きが小さいほど遠くなる）。
      // 操作の始めにそれを範囲の内へ引き戻すと、地図が跳ぶので、いまの位置より外へ出さないだけにする。
      const interacting = is.isDragging || is.isPanning || is.isRotating || is.isZooming;
      const cur = useMapStore.getState().viewState.target;
      const bound = (v: number, lo: number, hi: number, now: number) => clamp(v, Math.min(lo, now), Math.max(hi, now));
      const target: P3 = is.inTransition || !interacting
        ? [t[0], t[1], t[2]]
        : [bound(t[0], minX, maxX, cur[0]), bound(t[1], minY, maxY, cur[1]), bound(t[2], 0, topOf(targetsRef.current), cur[2])];
      state.setViewState({ target, rotationOrbit: vs.rotationOrbit, rotationX: vs.rotationX, zoom: vs.zoom });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const deckViewState = useMemo(
    () => ({
      ...viewState,
      ...LIMITS,
      ...(transition ? { transitionDuration: TRANSITION_MS, transitionEasing: easeInOut } : {}),
    }),
    [viewState, transition],
  );

  /* ---------- レイヤー ---------- */
  // 各レイヤーの描画結果は、目標の高さで作っておく。補間中の高さへは modelMatrix の差し替えだけで移す。
  const rendered = useMemo(() => {
    const boundary = status.boundary === 'ready' ? (data.boundary as BoundaryData) : null;
    const out = {} as Record<LayerId, Layer[]>;
    for (const id of LAYER_IDS) {
      const z = targets[id];
      out[id] =
        z === null || status[id] !== 'ready'
          ? []
          : registry[id].render(data[id], { z, modelMatrix: translationMatrix(z), opacity: 1, solo: solo === id, boundary });
    }
    return out;
  }, [targets, solo, data, status]);

  // 断面：段ごとに、切り口に沿って立てるグラフ。段の目標の高さで作っておく（補間中の高さへは withHeight で移す）。
  const standH = solo === null ? standHeight(spacing) : 0;
  const stands = useMemo(() => {
    const out = {} as Record<LayerId, Layer[]>;
    for (const id of LAYER_IDS) {
      const z = targets[id];
      const tr = sectionTracks[id];
      out[id] =
        !sectionMode || !sectionLine || z === null || !tr || standH === 0
          ? []
          : [...sectionCurtainLayer(id, sectionLine, z, standH), ...sectionStandLayers(id, sectionLine, tr, z, standH)];
    }
    return out;
  }, [sectionMode, sectionLine, sectionTracks, targets, standH]);

  const paths = useMemo(() => (status.boundary === 'ready' ? cachedBoundaryPaths(data.boundary as BoundaryData) : null), [status.boundary, data.boundary]);

  const stackLayers = [];
  let prevZ: number | null = null;
  const visibleIds = LAYER_IDS.filter((id) => shown[id] !== null)
    .map((id) => ({ id, z: shown[id] as number, i: order.indexOf(id) }))
    .sort((a, b) => a.z - b.z || a.i - b.i);
  for (const [k, { id, z }] of visibleIds.entries()) {
    const modelMatrix = asModelMatrix(translationMatrix(z));
    // 間隔 0 などで同じ高さに重なる段は、塗りと外枠を1枚ぶんだけ描く（重ねて濃くしない）。
    const first = prevZ === null || Math.abs(z - prevZ) > 1;
    prevZ = z;
    if (first)
      stackLayers.push(
        new SolidPolygonLayer({
          id: `plane-${id}`,
          data: PLANE,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          modelMatrix,
          getPolygon: (d: P3[]) => d,
          getFillColor: FILL_COLOR,
          pickable: false,
        }),
        new PathLayer({
          id: `frame-${id}`,
          data: FRAME,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          modelMatrix,
          getPath: (d: (typeof FRAME)[number]) => d.path,
          getColor: FRAME_COLOR,
          getWidth: 1,
          widthUnits: 'pixels',
          billboard: true,
          pickable: false,
        }),
      );
    stackLayers.push(...rendered[id].map((l) => withHeight(l, targets[id] as number, z)));
    // 同じ高さに重なる段の区境界線は、いちばん上の段にだけ描く（重ねて濃くしない）。
    const next = visibleIds[k + 1];
    const topOfGroup = !(next && Math.abs(next.z - z) <= 1);
    if (paths && topOfGroup) stackLayers.push(boundaryLayer(paths, id, z));
    // 断面：その段の平面の後、1つ上の段の平面の前に、立てるグラフ、切り口の線と端点を描く。
    if (sectionMode) {
      stackLayers.push(...stands[id].map((l) => withHeight(l, targets[id] as number, z)));
      if (topOfGroup) {
        if (sectionLine) stackLayers.push(...sectionLineLayers(`section-${id}`, sectionLine, z));
        else if (sectionStart && sectionCursor) stackLayers.push(...sectionLineLayers(`section-draft-${id}`, draftLine(sectionStart, sectionCursor), z, true));
      }
    }
    // クローズアップで切り出している範囲を、各段に円で示す（同じ高さに重なる段には1本だけ）。
    if (closeup && topOfGroup) stackLayers.push(circleLayer(`closeup-range-${id}`, closeup, z));
  }

  const labelLayers = stackLabelLayers({ tiers: visibleIds, viewState, size });

  // 探針（「地点」）か、断面の両端の垂直線とカーソルの印（「断面」）。いちばん上に描く。
  const zsShown = visibleIds.map((t) => t.z);
  const overlayLayers: Layer[] = sectionMode
    ? [
        ...(sectionLine ? sectionPoleLayers(sectionLine, zsShown) : []),
        ...(sectionLine && sectionHover !== null ? sectionCursorLayers(sectionLine, sectionHover, zsShown) : []),
      ]
    : probeLayers(state as MapState);

  return (
    // 右上のパネルの左までを描画領域にする。情報の列は、この右端に重なる。
    <div ref={box} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: RIGHT_PANEL_W, background: '#000' }}>
      {ready && (
        <DeckGL
          ref={deckRef}
          getCursor={getCursor}
          views={VIEW}
          viewState={deckViewState}
          onViewStateChange={onViewStateChange as never}
          controller={CONTROLLER}
          parameters={DECK_PARAMETERS}
          layers={[...stackLayers, ...labelLayers, ...overlayLayers]}
          onHover={sectionMode ? onSectionHover : onHover}
          onClick={sectionMode ? onSectionClick : onClick}
          style={{ background: '#000' }}
        />
      )}
    </div>
  );
}
