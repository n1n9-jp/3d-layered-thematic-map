import type { Layer, PickingInfo } from '@deck.gl/core';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { MapState } from '../store';
import { pickProbePoint } from './ray';
import type { Plane } from './ray';

type StackInput = Pick<MapState, 'order' | 'visible' | 'solo' | 'spacing'>;

/** 表示中の平面。上の段が先頭。 */
export function visiblePlanes(state: StackInput): Plane[] {
  const planes: Plane[] = [];
  for (const id of state.order) {
    const z = layerZ(state, id);
    if (z !== null) planes.push({ id, z });
  }
  return planes.reverse();
}

function pickFromInfo(info: PickingInfo) {
  const { viewport } = info;
  if (!viewport || info.x < 0 || info.y < 0) return null;
  return pickProbePoint(viewport, info.x, info.y, visiblePlanes(useMapStore.getState()));
}

export function onHover(info: PickingInfo): void {
  const s = useMapStore.getState();
  if (s.probePinned) return;
  const hit = pickFromInfo(info);
  if (hit === null) {
    if (s.probe !== null) s.setProbe(null);
    return;
  }
  if (s.probe?.x !== hit.x || s.probe?.y !== hit.y) s.setProbe({ x: hit.x, y: hit.y });
}

/** 固定を解除し、探針を消す（次のホバーで再び現れる）。 */
export function releaseProbe(): void {
  const s = useMapStore.getState();
  s.setProbePinned(false);
  s.setProbe(null);
}

export function onClick(info: PickingInfo): void {
  const s = useMapStore.getState();
  const hit = pickFromInfo(info);
  if (hit !== null) {
    s.setProbe({ x: hit.x, y: hit.y });
    s.setProbePinned(true);
  } else if (s.probePinned) {
    releaseProbe();
  }
}

/** Esc キーで固定を解除する。解除関数を返す。 */
export function installProbeKeys(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const handler = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape' && useMapStore.getState().probePinned) releaseProbe();
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}

const HOVER_COLOR: [number, number, number, number] = [90, 220, 255, 255];
const PINNED_COLOR: [number, number, number, number] = [255, 176, 0, 255];
const HALO: [number, number, number, number] = [0, 0, 0, 230];
const RING_RADIUS_PX = 11;

/** 探針の描画：表示中の最下段から最上段を貫く垂直線と、各段との交点の輪。StackView が layers の末尾に足す。 */
export function probeLayers(state: MapState): Layer[] {
  const { probe, probePinned } = state;
  if (!probe) return [];
  const planes = visiblePlanes(state);
  if (planes.length === 0) return [];

  const zs = planes.map((p) => p.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const color = probePinned ? PINNED_COLOR : HOVER_COLOR;
  const lineWidth = probePinned ? 3 : 2;
  // 深度テストを切り、配列の順（halo → 本線 → 輪 → 点）だけで重なりを決める。
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    pickable: false,
    parameters: { depthCompare: 'always' },
  } as const;

  const layers: Layer[] = [];
  if (zMax > zMin) {
    const path = [{ path: [[probe.x, probe.y, zMin], [probe.x, probe.y, zMax]] as [number, number, number][] }];
    layers.push(
      new PathLayer({
        ...common,
        id: 'probe-line-halo',
        data: path,
        getPath: (d: (typeof path)[number]) => d.path,
        getColor: HALO,
        getWidth: lineWidth + 3,
        widthUnits: 'pixels',
        capRounded: true,
        billboard: true, // 垂直線は幅を画面に向けて広げる（既定だと幅が0になる）
      }),
      new PathLayer({
        ...common,
        id: 'probe-line',
        data: path,
        getPath: (d: (typeof path)[number]) => d.path,
        getColor: color,
        getWidth: lineWidth,
        widthUnits: 'pixels',
        capRounded: true,
        billboard: true, // 垂直線は幅を画面に向けて広げる（既定だと幅が0になる）
      }),
    );
  }

  const marks = planes.map((p) => ({ position: [probe.x, probe.y, p.z] as [number, number, number] }));
  const ringCommon = {
    ...common,
    data: marks,
    getPosition: (d: (typeof marks)[number]) => d.position,
    radiusUnits: 'pixels',
    billboard: false, // 平面に張りつけ、斜めから見ると楕円になる
    stroked: true,
    filled: false,
    lineWidthUnits: 'pixels',
  } as const;
  layers.push(
    new ScatterplotLayer({ ...ringCommon, id: 'probe-ring-halo', getRadius: RING_RADIUS_PX, getLineColor: HALO, getLineWidth: lineWidth + 3 }),
    new ScatterplotLayer({ ...ringCommon, id: 'probe-ring', getRadius: RING_RADIUS_PX, getLineColor: color, getLineWidth: lineWidth }),
    // 中心の点。固定中は塗りつぶしで区別する
    new ScatterplotLayer({
      ...common,
      id: 'probe-dot',
      data: marks,
      getPosition: (d: (typeof marks)[number]) => d.position,
      radiusUnits: 'pixels',
      billboard: false,
      stroked: false,
      filled: true,
      getRadius: probePinned ? 4 : 2,
      getFillColor: color,
    }),
  );
  return layers;
}

