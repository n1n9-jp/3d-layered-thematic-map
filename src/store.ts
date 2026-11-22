import { create } from 'zustand';
import {
  CLOSEUP_RADII,
  DEFAULT_ANGLES,
  DEFAULT_CLOSEUP_RADIUS,
  DEFAULT_OPTIONS,
  EXTENT,
  FLOOD_SCENARIOS,
  FLOOD_VIEWS,
  LAYER_IDS,
  POPULATION_VIEWS,
  SPACING,
  VIEW_LIMITS,
} from './config';
import type { CloseupRadius, LayerId, LayerOptions } from './config';
import { sectionFromQuery } from './section/interaction';
import type { SectionLine } from './types';

export type LayerStatus = 'idle' | 'loading' | 'ready' | 'error';
export type DataKey = LayerId | 'boundary';

export interface ViewState {
  target: [number, number, number];
  rotationOrbit: number;
  rotationX: number;
  zoom: number;
}

/** 全体の地図と右の列の操作：「地点」（探針とクローズアップ）か、「断面」（2点の線に沿った変化）。 */
export type UiMode = 'point' | 'section';

/** 畳める見出し（アコーディオン）の開閉。初期状態はすべて閉じる。 */
export interface OpenState {
  /** レイヤー一覧で開いている行（同時に開けるのは1つ）。開いているあいだ、避難の行なら区の札を出す。 */
  layer: LayerId | null;
  /** 23区全体の「浸水の深さの区分ごとの人口」の表 */
  table: boolean;
  /** 23区全体の「数え方とデータの注意」 */
  notes: boolean;
  /** 地点の表（探針の値）で開いている行（同時に開けるのは1つ） */
  row: LayerId | null;
  /** 断面の「線に沿った集計」 */
  section: boolean;
}

export const CLOSED: OpenState = { layer: null, table: false, notes: false, row: null, section: false };

export interface SectionFocus {
  id: LayerId;
  from: 'chart' | 'map';
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
  /** レイヤー一覧の行にある切り替え（浸水の想定と見るもの、人口の総数と65歳以上） */
  options: LayerOptions;
  /** ローカル座標（m） */
  probe: { x: number; y: number } | null;
  probePinned: boolean;
  /** クローズアップの半径（m）。探針が固定されているあいだ、その地点を中心にこの半径の円の範囲を拡大して見せる。 */
  closeupRadius: CloseupRadius;
  mode: UiMode;
  /** 断面の線。「地点」へ切り替えても保持する。 */
  section: SectionLine | null;
  /** 断面の始点だけ置いて、終点を待っている地点。 */
  sectionStart: { x: number; y: number } | null;
  /** 始点を置いたあとの、カーソルの下の地点（線の下書き用）。 */
  sectionCursor: { x: number; y: number } | null;
  /** カーソルが指している、断面の線に沿った距離（m）。全体の地図と右のグラフのどちらにカーソルがあっても、この値で連動する。 */
  sectionHover: number | null;
  /**
   * 断面で、目立たせる段。from が 'chart' なら右のチャートにカーソルがあり、全体の地図の対応する段を目立たせる（ほかの段を暗くする）。
   * 'map' なら全体の地図の切り口の近くにカーソルがあり、右の対応するチャートを目立たせる。
   */
  sectionFocus: SectionFocus | null;
  open: OpenState;
  data: Partial<Record<DataKey, unknown>>;
  status: Record<DataKey, LayerStatus>;
  setSpacing(v: number): void;
  moveLayer(id: LayerId, toIndex: number): void;
  setVisible(id: LayerId, v: boolean): void;
  setSolo(id: LayerId | null): void;
  setOption<K extends keyof LayerOptions>(key: K, value: LayerOptions[K]): void;
  setViewState(v: MapState['viewState']): void;
  setAutoFit(v: boolean): void;
  setProbe(p: MapState['probe']): void;
  setProbePinned(v: boolean): void;
  setCloseupRadius(r: CloseupRadius): void;
  setMode(m: UiMode): void;
  setSection(line: SectionLine | null): void;
  setSectionStart(p: MapState['sectionStart']): void;
  setSectionCursor(p: MapState['sectionCursor']): void;
  setSectionHover(d: number | null): void;
  setSectionFocus(f: SectionFocus | null): void;
  /** 見出しを開閉する。layer と row は同時に1つだけ開く（開いている見出しをもう一度押すと閉じる）。 */
  toggleOpen(key: 'layer' | 'row', id: LayerId): void;
  toggleOpen(key: 'table' | 'notes' | 'section'): void;
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

type InitialState = Pick<
  MapState,
  'order' | 'visible' | 'solo' | 'spacing' | 'viewState' | 'probe' | 'probePinned' | 'closeupRadius' | 'mode' | 'section' | 'options' | 'open'
>;

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

function oneOf<T extends string>(choices: readonly T[], v: string | null, fallback: T): T {
  return choices.find((c) => c === v) ?? fallback;
}

/** URL クエリの `flood`（想定）、`floodview`（見るもの）、`pop`（人口で見るもの）。値が合わないものは既定値。 */
export function optionsQuery(search: string): LayerOptions {
  const q = new URLSearchParams(search);
  return {
    floodScenario: oneOf(FLOOD_SCENARIOS, q.get('flood'), DEFAULT_OPTIONS.floodScenario),
    floodView: oneOf(FLOOD_VIEWS, q.get('floodview'), DEFAULT_OPTIONS.floodView),
    populationView: oneOf(POPULATION_VIEWS, q.get('pop'), DEFAULT_OPTIONS.populationView),
  };
}

/**
 * URL クエリの `open`（検査や撮影のために、開いた状態で始める）。カンマ区切りで、次のどれか。
 * レイヤーID = レイヤー一覧のその行、`table` / `notes` = 23区全体の表・注記、`row:<レイヤーID>` = 地点の表のその行、`section` = 断面の集計。
 * 合わないものは無視する。レイヤー一覧の行、地点の表の行は、複数書いても最初の1つだけ。
 */
export function openQuery(search: string): OpenState {
  const out: OpenState = { ...CLOSED };
  for (const raw of (new URLSearchParams(search).get('open') ?? '').split(',')) {
    const t = raw.trim();
    if (t === 'table' || t === 'notes' || t === 'section') out[t] = true;
    else if (isLayerId(t)) out.layer ??= t;
    else if (t.startsWith('row:') && isLayerId(t.slice(4))) out.row ??= t.slice(4) as LayerId;
  }
  return out;
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
 * `rx=<rotationX>`, `ro=<rotationOrbit>`, `zoom=<zoom>`, `radius=<m>`（1000 / 2000 / 5000）,
 * `section=<ax>,<ay>,<bx>,<by>`（断面の線。あれば「断面」に切り替わった状態で開く）,
 * `flood=max|river|tide`（浸水の想定）, `floodview=depth|duration`（浸水で見るもの）, `pop=total|elderly`（人口で見るもの）,
 * `open=<layerId|table|notes|row:<layerId>|section>,...`（開いた状態で始める）。不正な値は無視して既定値を使い、範囲のあるものは上下限に収める。
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

  const section = sectionFromQuery(q.get('section'));

  return {
    order,
    visible,
    solo,
    spacing,
    viewState,
    probe,
    probePinned: probe !== null,
    closeupRadius: radiusQuery(search),
    mode: section ? 'section' : 'point',
    section,
    options: optionsQuery(search),
    open: openQuery(search),
  };
}

const DATA_KEYS: DataKey[] = ['boundary', ...LAYER_IDS];

export const useMapStore = create<MapState>()((set) => ({
  ...initialStateFromQuery(typeof location === 'undefined' ? '' : location.search),
  autoFit: true,
  sectionStart: null,
  sectionCursor: null,
  sectionHover: null,
  sectionFocus: null,
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
  setOption: (key, value) => set((s) => (s.options[key] === value ? {} : { options: { ...s.options, [key]: value } })),
  setViewState: (v) => set({ viewState: v }),
  setAutoFit: (v) => set({ autoFit: v }),
  setProbe: (p) => set({ probe: p }),
  setProbePinned: (v) => set({ probePinned: v }),
  setCloseupRadius: (r) => set({ closeupRadius: r }),
  setMode: (m) =>
    set((s) => {
      if (m === s.mode) return {};
      // 切り替えのたびに、カーソルに付いてくる一時的な表示は消す。固定した探針と、断面の線は残す。
      return { mode: m, sectionCursor: null, sectionHover: null, sectionFocus: null, ...(m === 'section' && !s.probePinned ? { probe: null } : {}) };
    }),
  setSection: (line) => set({ section: line }),
  setSectionStart: (p) => set({ sectionStart: p }),
  setSectionCursor: (p) => set({ sectionCursor: p }),
  setSectionHover: (d) => set((s) => (s.sectionHover === d ? {} : { sectionHover: d })),
  setSectionFocus: (f) =>
    set((s) => (s.sectionFocus?.id === f?.id && s.sectionFocus?.from === f?.from ? {} : { sectionFocus: f })),
  toggleOpen: (key: keyof OpenState, id?: LayerId) =>
    set((s) => {
      const next = key === 'layer' || key === 'row' ? { [key]: s.open[key] === (id ?? null) ? null : (id ?? null) } : { [key]: !s.open[key] };
      return { open: { ...s.open, ...next } };
    }),
}));

if (typeof window !== 'undefined') {
  window.__store = useMapStore;
  window.__ready = false;
}
