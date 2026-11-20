import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DeckGL from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { EXTENT, LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import { onClick, onHover, probeLayers } from '../probe/controller';
import { asModelMatrix, layerZ, translationMatrix } from '../stack';
import { useMapStore, viewQuery } from '../store';
import type { MapState, ViewState } from '../store';
import type { BoundaryData } from '../types';
import { boundaryLayer, boundaryPaths } from './boundaryLines';
import { DEFAULT_ANGLES, LIMITS, SOLO_ANGLES, VIEW, clamp, fitView, hasSize, labelAnchors, nearestAngle, projectPoint, spreadLabels } from './camera';
import type { Size } from './camera';
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
const LABEL_COLOR: [number, number, number, number] = [225, 230, 240, 255];
type LabelDatum = { id: LayerId; text: string };
type HaloDatum = LabelDatum & { dx: number; dy: number };
const LABEL_HALO_COLOR: [number, number, number, number] = [0, 0, 0, 255];
/** 文字の縁取りに使う、黒い文字を重ねる方向（px）。 */
const HALO_OFFSETS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
const LABEL_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, "WenQuanYi Zen Hei", sans-serif';

/** 視点を切り替えるアニメーションの長さ（ms）。 */
const TRANSITION_MS = 700;
/**
 * アニメーションの終了を deck.gl が知らせてこないときのための、遅い側の保険（ms）。
 * 描画が遅い環境（1フレーム約2秒の実データ）でも、アニメーションの最後のフレームが来る前に打ち切らないよう、長めにとる。
 * 通常は、終了の知らせ（onViewStateChange）か利用者の操作で、これより早く終わる。
 */
const TRANSITION_FAILSAFE_MS = TRANSITION_MS + 4000;
/** レイヤー名どうしの縦の最小間隔（px）。 */
const LABEL_GAP = 20;
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

function topOf(zs: ZMap): number {
  let top = 0;
  for (const id of LAYER_IDS) top = Math.max(top, zs[id] ?? 0);
  return top;
}

/** layer の modelMatrix が `from` の高さの平行移動なら、`to` の高さに差し替えたレイヤーを返す。 */
function withHeight(layer: Layer, from: number, to: number): Layer {
  if (from === to) return layer;
  const m = layer.props.modelMatrix as unknown as ArrayLike<number> | null | undefined;
  const expect = translationMatrix(from);
  if (!m || m.length !== 16 || !expect.every((v, i) => v === m[i])) return layer;
  return layer.clone({ modelMatrix: asModelMatrix(translationMatrix(to)) });
}

interface Saved {
  view: ViewState;
  auto: boolean;
}

export default function StackView() {
  const state = useMapStore();
  const { order, visible, solo, spacing, data, status, viewState } = state;

  /* ---------- 画面の大きさ ---------- */
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // 幅か高さが 1px に満たない間は「まだ大きさがない」として扱う（視点の計算も投影もしない）。
      const next = hasSize(r) ? { width: r.width, height: r.height } : null;
      setSize((s) => (s === next || (s && next && s.width === next.width && s.height === next.height) ? s : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- 各レイヤーの高さ（目標値と表示用） ---------- */
  const targets = useMemo(
    () => Object.fromEntries(LAYER_IDS.map((id) => [id, layerZ({ order, visible, solo, spacing }, id)])) as ZMap,
    [order, visible, solo, spacing],
  );
  const sliderActive = useSyncExternalStore(subscribeSliderActive, getSliderActive);
  const shown = useDisplayedZ(targets, sliderActive);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

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

    const view3D = { rotationX, rotationOrbit, ...fitView({ rotationX, rotationOrbit, top: topOf(targets), size }) };
    if (zoom !== null) view3D.zoom = zoom;
    setAutoFit(zoom === null);

    if (solo !== null) {
      saved.current = { view: view3D, auto: autoFit.current };
      setAutoFit(true);
      set({ ...SOLO_ANGLES, ...fitView({ ...SOLO_ANGLES, top: 0, size }) });
    } else {
      set(view3D);
    }
    prevSolo.current = solo;
    setReady(true);
  }, [ready, size, solo, targets, setAutoFit]);

  // 画面の大きさや積層の高さが変わったら、収まるように追従する（アニメーション中は行わない）。
  const top = topOf(shown);
  useEffect(() => {
    if (!ready || !size || !autoFit.current || transition) return;
    const vs = useMapStore.getState().viewState;
    const fit = fitView({ rotationX: vs.rotationX, rotationOrbit: vs.rotationOrbit, top, size });
    const next = { ...vs, ...fit };
    if (!sameView(vs, next)) useMapStore.getState().setViewState(next);
  }, [ready, size, top, transition]);

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
        ...fitView({ ...SOLO_ANGLES, top: 0, size }),
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
              ...fitView({ rotationX: prev.view.rotationX, rotationOrbit, top: topOf(targetsRef.current), size }),
            }
          : { ...prev.view, rotationOrbit },
      );
    }
  }, [ready, size, solo, startTransition, setAutoFit]);

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
        startTransition({ ...angles, ...fitView({ ...angles, top: topOf(targetsRef.current), size: sz }) });
      }),
    [startTransition, setAutoFit],
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
      const target: P3 = is.inTransition
        ? [t[0], t[1], t[2]]
        : [clamp(t[0], minX, maxX), clamp(t[1], minY, maxY), clamp(t[2], 0, topOf(targetsRef.current))];
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

  const paths = useMemo(() => (status.boundary === 'ready' ? boundaryPaths(data.boundary as BoundaryData) : null), [status.boundary, data.boundary]);

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
    if (paths && !(next && Math.abs(next.z - z) <= 1)) stackLayers.push(boundaryLayer(paths, id, z));
  }

  const labels = useMemo(() => LAYER_IDS.map((id) => ({ id, text: registry[id].label })), []);
  const anchors = labelAnchors(viewState.rotationX, viewState.rotationOrbit, visibleIds.map((v) => v.z));
  const anchorById = new Map(visibleIds.map((v, i) => [v.id, anchors[i]]));
  // 平面が近づいて名前が重なるときは、画面上で縦に押し広げて読めるようにする。
  const screenY = size ? anchors.map((a) => projectPoint(viewState, size, a)[1]) : anchors.map(() => 0);
  const spread = spreadLabels(screenY, LABEL_GAP);
  const offsetById = new Map(visibleIds.map((v, i) => [v.id, spread[i] - screenY[i]]));
  // 日本語の画数の多い字（「標」など）は、SDF 方式だと14px の大きさでつぶれて読めない。
  // そのため SDF は使わず、通常の文字テクスチャで描く。縁取りの代わりに、黒い同じ文字を8方向に1px ずらして
  // 後ろに重ねる（明るい標高の面や区境界線の上でも読めるようにする）。
  const labelData = labels.filter((l) => anchorById.has(l.id));
  const labelProps = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getText: (d: LabelDatum) => d.text,
    getSize: 14,
    sizeUnits: 'pixels',
    getTextAnchor: 'start',
    getAlignmentBaseline: 'center',
    fontFamily: LABEL_FONT,
    characterSet: 'auto',
    fontSettings: { sdf: false, fontSize: 64 },
    pickable: false,
  } as const;
  const labelUpdateTriggers = {
    getPosition: [visibleIds.map((v) => `${v.id}:${v.z.toFixed(2)}`).join(), viewState.rotationX, viewState.rotationOrbit],
    getPixelOffset: [visibleIds.map((v) => `${v.id}:${(offsetById.get(v.id) ?? 0).toFixed(1)}`).join()],
  };
  const labelBaseOffset = (d: LabelDatum): [number, number] => [10, offsetById.get(d.id) ?? 0];
  const haloData: HaloDatum[] = HALO_OFFSETS.flatMap(([dx, dy]) => labelData.map((l) => ({ ...l, dx, dy })));
  const labelHaloLayer = new TextLayer<HaloDatum>({
    ...labelProps,
    id: 'stack-labels-halo',
    data: haloData,
    getPosition: (d) => anchorById.get(d.id) as P3,
    getColor: LABEL_HALO_COLOR,
    getPixelOffset: (d) => {
      const [x, y] = labelBaseOffset(d);
      return [x + d.dx, y + d.dy];
    },
    updateTriggers: labelUpdateTriggers,
  });
  const labelLayer = new TextLayer<LabelDatum>({
    ...labelProps,
    id: 'stack-labels',
    data: labelData,
    getPosition: (d) => anchorById.get(d.id) as P3,
    getColor: LABEL_COLOR,
    getPixelOffset: labelBaseOffset,
    updateTriggers: labelUpdateTriggers,
  });

  return (
    // 右上のパネルの左までを描画領域にする（積層はこの領域の中心に置く）。
    <div ref={box} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: RIGHT_PANEL_W, background: '#000' }}>
      {ready && (
        <DeckGL
          views={VIEW}
          viewState={deckViewState}
          onViewStateChange={onViewStateChange as never}
          controller={CONTROLLER}
          parameters={DECK_PARAMETERS}
          layers={[...stackLayers, labelHaloLayer, labelLayer, ...probeLayers(state as MapState)]}
          onHover={onHover}
          onClick={onClick}
          style={{ background: '#000' }}
        />
      )}
    </div>
  );
}
