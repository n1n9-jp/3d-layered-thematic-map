import { create } from 'zustand';
import { CLOSEUP_RADII, DEFAULT_ANGLES, DEFAULT_CLOSEUP_RADIUS, EXTENT, LAYER_IDS, SPACING, VIEW_LIMITS } from './config';
import type { CloseupRadius, LayerId } from './config';

export type LayerStatus = 'idle' | 'loading' | 'ready' | 'error';
export type DataKey = LayerId | 'boundary';

export interface ViewState {
  target: [number, number, number];
  rotationOrbit: number;
  rotationX: number;
  zoom: number;
}

export interface MapState {
  /** 下→上 */
  order: LayerId[];
  visible: Record<LayerId, boolean>;
  /** null 以外なら単独表示 */
  solo: LayerId | null;
  /** レイヤー間隔（m） */
  spacing: number;
  viewState: ViewState;
  /** true の間は、画面の大きさや積層の高さに合わせて視点を自動で収め直す（利用者が視点を動かすと false）。 */
  autoFit: boolean;
  /** ローカル座標（m） */
  probe: { x: number; y: number } | null;
  probePinned: boolean;
  /** クローズアップの半径（m）。探針が固定されているあいだ、その地点を中心にこの半径の円の範囲を拡大して見せる。 */
  closeupRadius: CloseupRadius;
  data: Partial<Record<DataKey, unknown>>;
  status: Record<DataKey, LayerStatus>;
  setSpacing(v: number): void;
  moveLayer(id: LayerId, toIndex: number): void;
  setVisible(id: LayerId, v: boolean): void;
  setSolo(id: LayerId | null): void;
  setViewState(v: MapState['viewState']): void;
  setAutoFit(v: boolean): void;
  setProbe(p: MapState['probe']): void;
  setProbePinned(v: boolean): void;
  setCloseupRadius(r: CloseupRadius): void;
}

declare global {
  interface Window {
    __store: typeof useMapStore;
    /** 全レイヤーと区境界の読み込みが成功か失敗に落ち着いたら true */
    __ready: boolean;
  }
}

const DEFAULT_VIEW: ViewState = {
  target: [(EXTENT.minX + EXTENT.maxX) / 2, (EXTENT.minY + EXTENT.maxY) / 2, 2 * SPACING.default], // z は既定の積層（5段）の中央
  rotationX: DEFAULT_ANGLES.rotationX,
  rotationOrbit: DEFAULT_ANGLES.rotationOrbit,
  // 正射影では zoom 0 で 1 ユニット = 1px。36km が 480px 前後に収まる値。
  zoom: Math.log2(480 / (EXTENT.maxX - EXTENT.minX)),
};

type InitialState = Pick<MapState, 'order' | 'visible' | 'solo' | 'spacing' | 'viewState' | 'probe' | 'probePinned' | 'closeupRadius'>;

function isLayerId(s: string): s is LayerId {
  return (LAYER_IDS as readonly string[]).includes(s);
}

function num(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const clampSpacing = (v: number) => Math.min(SPACING.max, Math.max(SPACING.min, v));
const clampRange = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * URL クエリの `rx`、`ro`、`zoom`。視点の上下限に収め、指定がない・数値でないものは null。
 * （`ro` に上下限はなく、有限の値をそのまま返す。）
 */
export function viewQuery(search: string): { rx: number | null; ro: number | null; zoom: number | null } {
  const q = new URLSearchParams(search);
  const rx = num(q.get('rx'));
  const zoom = num(q.get('zoom'));
  return {
    rx: rx === null ? null : clampRange(rx, VIEW_LIMITS.minRotationX, VIEW_LIMITS.maxRotationX),
    ro: num(q.get('ro')),
    zoom: zoom === null ? null : clampRange(zoom, VIEW_LIMITS.minZoom, VIEW_LIMITS.maxZoom),
  };
}

/** URL クエリの `radius`。1000 / 2000 / 5000 のどれかならその値、それ以外（数値でない値や、ほかの数値）と未指定は既定の 2000。 */
export function radiusQuery(search: string): CloseupRadius {
  const n = num(new URLSearchParams(search).get('radius'));
  return CLOSEUP_RADII.find((r) => r === n) ?? DEFAULT_CLOSEUP_RADIUS;
}

function ids(v: string | null): LayerId[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(isLayerId);
}

/**
 * URL クエリから初期状態を作る。
 * `spacing=<m>`, `order=<id,id,...>`, `hidden=<id,id>`, `solo=<id>`, `probe=<x>,<y>`,
 * `rx=<rotationX>`, `ro=<rotationOrbit>`, `zoom=<zoom>`, `radius=<m>`（1000 / 2000 / 5000）。不正な値は無視して既定値を使い、範囲のあるものは上下限に収める。
 */
export function initialStateFromQuery(search: string): InitialState {
  const q = new URLSearchParams(search);

  const spacingQ = num(q.get('spacing'));
  const spacing = spacingQ === null ? SPACING.default : clampSpacing(spacingQ);

  // order に書かれたものを先に、書かれなかったレイヤーは既定の順で後ろへ。
  const given = [...new Set(ids(q.get('order')))];
  const order = [...given, ...LAYER_IDS.filter((id) => !given.includes(id))];

  const visible = Object.fromEntries(LAYER_IDS.map((id) => [id, true])) as Record<LayerId, boolean>;
  for (const id of ids(q.get('hidden'))) visible[id] = false;

  const soloQ = q.get('solo');
  const solo = soloQ !== null && isLayerId(soloQ) ? soloQ : null;

  let probe: MapState['probe'] = null;
  const probeQ = q.get('probe')?.split(',');
  if (probeQ && probeQ.length === 2) {
    const x = num(probeQ[0]);
    const y = num(probeQ[1]);
    if (x !== null && y !== null) probe = { x, y };
  }

  const { rx, ro, zoom } = viewQuery(search);
  const viewState: ViewState = {
    ...DEFAULT_VIEW,
    ...(rx !== null && { rotationX: rx }),
    ...(ro !== null && { rotationOrbit: ro }),
    ...(zoom !== null && { zoom }),
  };

  return { order, visible, solo, spacing, viewState, probe, probePinned: probe !== null, closeupRadius: radiusQuery(search) };
}

const DATA_KEYS: DataKey[] = ['boundary', ...LAYER_IDS];

export const useMapStore = create<MapState>()((set) => ({
  ...initialStateFromQuery(typeof location === 'undefined' ? '' : location.search),
  autoFit: true,
  data: {},
  status: Object.fromEntries(DATA_KEYS.map((k) => [k, 'idle'])) as Record<DataKey, LayerStatus>,

  setSpacing: (v) => {
    if (Number.isFinite(v)) set({ spacing: clampSpacing(v) });
  },
  moveLayer: (id, toIndex) =>
    set((s) => {
      const rest = s.order.filter((x) => x !== id);
      const i = Math.min(rest.length, Math.max(0, toIndex));
      rest.splice(i, 0, id);
      return { order: rest };
    }),
  setVisible: (id, v) => set((s) => ({ visible: { ...s.visible, [id]: v } })),
  setSolo: (id) => set({ solo: id }),
  setViewState: (v) => set({ viewState: v }),
  setAutoFit: (v) => set({ autoFit: v }),
  setProbe: (p) => set({ probe: p }),
  setProbePinned: (v) => set({ probePinned: v }),
  setCloseupRadius: (r) => set({ closeupRadius: r }),
}));

if (typeof window !== 'undefined') {
  window.__store = useMapStore;
  window.__ready = false;
}
