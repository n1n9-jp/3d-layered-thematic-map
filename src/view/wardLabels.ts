/**
 * 全体の地図の避難の段に出す、区名の札。
 *
 * 洪水・高潮用の避難場所が区内に確認できない8区（指定なし：江戸川・足立・新宿・文京、未公開：葛飾・墨田・江東・渋谷）に、「区名／指定なし」「区名／未公開」の札を出す。
 * 東部の5区（足立・葛飾・墨田・江東・江戸川）は隣り合っていて、全体の地図では小さく映る。区の重心に札を重ねると、札どうしが重なって読めない。
 * そこで、札は区の外へ出し、区の重心と短い線（引き出し線）でつなぐ。
 *
 * 札の置き場所は、画面（px）の上で決める（`calloutPlacement.ts`）。視点（回転・傾き・拡大・位置）、画面の大きさ、段の高さ（レイヤー間隔）が変わると、
 * 札が占める画面上の位置も、避けるものの位置も変わるので、そのたびに決め直す。計算するのは札の数（高々数枚）の候補だけで、
 * 描画するレイヤーのデータ（区の輪郭、避難場所の点）には触れない。マウスの移動（探針）では、視点も段の高さも変わらないので、決め直さない。
 *
 * 避けるもの（札が重ならないようにする）：
 *   題と切り替えの帯、右の列（描画領域の右端）、レイヤー名、ほかの表示中の段のデータのある範囲（その段の高さでの、23区を囲む多角形）。
 *   同じ段のデータのある範囲は、なるべく避ける（区や避難場所の点の上に札が乗らないように）。
 * 収まらないときは、札を段階的に小さく・短くする（2行 → 小さな2行 → 区名だけ → 「区」を省く）。それでも置けない札は出さない。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { DATA_OUTLINE } from '../config';
import { HATCH_COLOR, NONE_COLOR } from '../layers/shelters/model';
import type { WardLabel } from '../layers/shelters/model';
import { asModelMatrix, translationMatrix } from '../stack';
import type { ViewState } from '../store';
import { makeProjector } from './camera';
import type { Size } from './camera';
import { placeCallouts } from './calloutPlacement';
import type { CalloutItem } from './calloutPlacement';
import { bandRect } from './layout';
import type { Pt, Rect } from './layout';

type View4 = Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;

/** 札の大きさの段階。先に試すほど大きい。 */
export const LABEL_LEVELS = [
  { fontPx: 15, twoLines: true, short: false },
  { fontPx: 13, twoLines: true, short: false },
  { fontPx: 14, twoLines: false, short: false },
  { fontPx: 12, twoLines: false, short: true },
] as const;
type Level = (typeof LABEL_LEVELS)[number];

/** 札の余白と枠（px）。deck.gl の TextLayer の行の高さは文字の大きさの 1 倍。 */
const PAD_X = 5;
const PAD_Y = 3;
const BORDER = 2;
/** 札が収まる領域の、描画領域の端からの隙間（px）。 */
const EDGE = 4;
/** いちばん大きい札で、引き出し線がどれもこの長さ（px）以下なら、ほかの段階は試さずに、それに決める。 */
const SHORT_LEADER = 120;
/** 段階を1つ下げることに払う、引き出し線の長さ（合計 px）相当の費用。 */
const LEVEL_PENALTY = 600;
/** 右の列と札の隙間（px）。 */
const COLUMN_GAP = 8;

const LABEL_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, "WenQuanYi Zen Hei", sans-serif';

type Rgb = readonly [number, number, number];
/** 「指定なし」（データに載っていて 0 件）は明るい青灰の文字と太い縁（輪郭の枠と同じ）、「未公開」（データに載っていない）は灰の文字と細い灰の縁（網掛けと同じ）。 */
const STYLE: Record<WardLabel['kind'], { text: Rgb; line: Rgb }> = {
  none: { text: [236, 240, 250], line: NONE_COLOR },
  unpublished: { text: [200, 206, 222], line: HATCH_COLOR },
};

export interface PlacedWardLabel {
  label: WardLabel;
  /** 札に出す文字（段階によって、2行か、区名だけか、「区」を省いたもの） */
  text: string;
  /** 札の長方形（画面の px） */
  rect: Rect;
  /** 区の目印と、引き出し線の札の側の端（画面の px） */
  anchor: Pt;
  attach: Pt;
}

export interface WardLabelLayout {
  /** 使った札の段階（`LABEL_LEVELS` の添字） */
  level: number;
  placed: PlacedWardLabel[];
  /** 置けなくて出さなかった区 */
  omitted: string[];
  /** 札を置いた段の高さ（m） */
  z: number;
  /** 札が避けたレイヤー名の長方形（画面の px。確認用） */
  layerNames: Rect[];
  /** 札の中心、引き出し線の札の側の端（その段の平面の上の座標、m） */
  world: { center: Pt; attach: Pt }[];
}

function textOf(l: WardLabel, level: Level): string {
  if (level.twoLines) return l.text;
  return level.short ? l.name.replace(/区$/, '') : l.name;
}

function sizeOf(text: string, level: Level): { w: number; h: number } {
  const lines = text.split('\n');
  const chars = Math.max(...lines.map((t) => t.length));
  return {
    w: chars * level.fontPx + 2 * PAD_X + 2 * BORDER,
    h: lines.length * level.fontPx + 2 * PAD_Y + 2 * BORDER,
  };
}

/** 優先して出す順（指定なしの区が先）。置けないものを減らすとき、後ろから外す。 */
const priority = (l: WardLabel) => (l.kind === 'none' ? 0 : 1);

export interface WardLabelInput {
  labels: readonly WardLabel[];
  viewState: View4;
  size: Size | null;
  /** 札を置く段（避難の段）の高さ */
  z: number;
  /** ほかの表示中の段の高さ */
  otherZs: readonly number[];
  /** 右の列の幅（px）。描画領域の右端に重なっている */
  columnWidth: number;
  /** レイヤー名（全段）が占める長方形（画面の px） */
  layerNameRects: readonly Rect[];
}

declare global {
  interface Window {
    /** 札の置き場所を決めた回数（確認用）。視点・画面の大きさ・段の高さが変わったときだけ増える（マウスの移動では増えない） */
    __wardLabelLayouts: number;
    /** いま画面に出している札の配置（確認用） */
    __wardLabels: WardLabelLayout | null;
  }
}

/** 札の置き場所を決める。描画領域に大きさがない、または出す札がないときは null。 */
export function layoutWardLabels(input: WardLabelInput): WardLabelLayout | null {
  const { labels, viewState, size, z, otherZs, columnWidth, layerNameRects } = input;
  if (typeof window !== 'undefined') window.__wardLabelLayouts = (window.__wardLabelLayouts ?? 0) + 1;
  if (!size || size.width < 1 || size.height < 1 || labels.length === 0) return null;
  const pr = makeProjector(viewState, size);
  const bounds: Rect = { left: EDGE, top: EDGE, right: Math.max(EDGE + 1, size.width - columnWidth - COLUMN_GAP), bottom: size.height - EDGE };
  // 画面の外にある区には、札を出さない
  const visible = labels
    .map((l) => ({ l, anchor: pr.project([l.position[0], l.position[1], z]) as Pt }))
    .filter(({ anchor: a }) => a[0] >= bounds.left && a[0] <= bounds.right && a[1] >= bounds.top && a[1] <= bounds.bottom)
    .sort((a, b) => priority(a.l) - priority(b.l));
  if (visible.length === 0) return null;

  const hull = (zz: number) => DATA_OUTLINE.map(([x, y]) => pr.project([x, y, zz]) as Pt);
  const hullZs = [...new Set(otherZs.map((v) => Math.round(v)))];
  const obstacles = {
    bounds,
    rects: [bandRect(size.width), ...layerNameRects],
    polys: hullZs.map(hull),
    soft: [hull(z)],
    // 引き出し線は、別の高さの段の上を通らないほうがよい（同じ高さの段は、札を置く段と同じ場所にあるので、通ってよい）
    leaderAvoid: hullZs.filter((zz) => Math.abs(zz - z) > 1).map(hull),
  };

  const attempt = (level: Level, subset: typeof visible) => {
    const items: CalloutItem[] = subset.map(({ l, anchor }) => ({ id: l.name, anchor, ...sizeOf(textOf(l, level), level) }));
    return { items, result: placeCallouts(items, obstacles) };
  };

  type Chosen = { level: number; subset: typeof visible; placed: ReturnType<typeof placeCallouts>['placed'] };
  const leaderOf = (p: Chosen['placed'][number]) => Math.hypot(p.attach[0] - p.anchor[0], p.attach[1] - p.anchor[1]);
  // 大きい段階から試す。全部が置けて、引き出し線がどれも短ければ、そこで決める。そうでなければ、置けた段階のうち、
  // 引き出し線の長さの合計（段階を下げるごとに割り増し）が最小のものを採る（札を小さくして線が大きく短くなるなら、小さくする）。
  let chosen: Chosen | null = null;
  let best = Infinity;
  for (let k = 0; k < LABEL_LEVELS.length; k++) {
    const { result } = attempt(LABEL_LEVELS[k], visible);
    if (result.conflict || result.missing.length > 0) continue;
    const lens = result.placed.map(leaderOf);
    const total = lens.reduce((a, b) => a + b, 0) + LEVEL_PENALTY * k;
    if (total < best) {
      best = total;
      chosen = { level: k, subset: visible, placed: result.placed };
    }
    if (k === 0 && Math.max(...lens) <= SHORT_LEADER) break;
  }
  if (!chosen) {
    // どの段階でも全部は置けない。いちばん小さい段階で、置けないもの・重なるものを、優先度の低いほうから外す
    const k = LABEL_LEVELS.length - 1;
    let subset = [...visible];
    for (;;) {
      const { result } = attempt(LABEL_LEVELS[k], subset);
      const missing = new Set(result.missing);
      if (!result.conflict && missing.size === 0) {
        chosen = { level: k, subset, placed: result.placed };
        break;
      }
      const drop = subset.filter(({ l }) => missing.has(l.name))[0] ?? subset[subset.length - 1];
      subset = subset.filter((s) => s !== drop);
      if (subset.length === 0) {
        chosen = { level: k, subset, placed: [] };
        break;
      }
    }
  }

  const level = LABEL_LEVELS[chosen.level];
  const byName = new Map(chosen.subset.map((s) => [s.l.name, s.l]));
  const placed: PlacedWardLabel[] = chosen.placed.map((p) => {
    const label = byName.get(p.id) as WardLabel;
    return { label, text: textOf(label, level), rect: p.rect, anchor: p.anchor, attach: p.attach };
  });
  const shown = new Set(placed.map((p) => p.label.name));
  return {
    level: chosen.level,
    placed,
    omitted: labels.filter((l) => !shown.has(l.name)).map((l) => l.name),
    z,
    layerNames: [...layerNameRects],
    world: placed.map((p) => ({
      center: pr.unplane([(p.rect.left + p.rect.right) / 2, (p.rect.top + p.rect.bottom) / 2], z),
      attach: pr.unplane(p.attach, z),
    })),
  };
}

/** 札と引き出し線のレイヤー（避難の段の高さ z の平面の上）。 */
export function wardLabelLayers(layout: WardLabelLayout): Layer[] {
  const { placed, world, z } = layout;
  if (placed.length === 0) return [];
  const level = LABEL_LEVELS[layout.level];
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    pickable: false,
  } as const;
  type Row = { p: PlacedWardLabel; w: (typeof world)[number] };
  const rows: Row[] = placed.map((p, i) => ({ p, w: world[i] }));
  const color = (r: Row, a: number): [number, number, number, number] => [...STYLE[r.p.label.kind].line, a] as [number, number, number, number];
  return [
    // 引き出し線は、区の網掛けや避難場所の点の上でも見えるよう、暗い縁取りを下に敷く
    new PathLayer<Row>({
      ...common,
      id: 'ward-callout-leader-halo',
      data: rows,
      getPath: (r) => [[r.p.label.position[0], r.p.label.position[1], 0], [r.w.attach[0], r.w.attach[1], 0]],
      getColor: [8, 10, 16, 235],
      getWidth: 5,
      widthUnits: 'pixels',
      billboard: true,
      capRounded: true,
    }),
    new PathLayer<Row>({
      ...common,
      id: 'ward-callout-leader',
      data: rows,
      getPath: (r) => [[r.p.label.position[0], r.p.label.position[1], 0], [r.w.attach[0], r.w.attach[1], 0]],
      getColor: (r) => color(r, 255),
      getWidth: 2,
      widthUnits: 'pixels',
      billboard: true,
      capRounded: true,
    }),
    new ScatterplotLayer<Row>({
      ...common,
      id: 'ward-callout-dot',
      data: rows,
      getPosition: (r) => [r.p.label.position[0], r.p.label.position[1], 0],
      getFillColor: (r) => color(r, 255),
      getLineColor: [8, 10, 16, 255],
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      radiusUnits: 'pixels',
      getRadius: 5,
      billboard: true,
    }),
    new TextLayer<Row>({
      ...common,
      id: 'ward-callout-text',
      data: rows,
      getPosition: (r) => [r.w.center[0], r.w.center[1], 0],
      getText: (r) => r.p.text,
      getSize: level.fontPx,
      sizeUnits: 'pixels',
      getColor: (r) => [...STYLE[r.p.label.kind].text, 255] as [number, number, number, number],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      background: true,
      getBackgroundColor: [8, 10, 16, 240],
      backgroundPadding: [PAD_X, PAD_Y],
      backgroundBorderRadius: 3,
      getBorderColor: (r) => color(r, 255),
      getBorderWidth: (r) => (r.p.label.kind === 'none' ? BORDER : 1.5),
      fontFamily: LABEL_FONT,
      characterSet: 'auto',
      fontSettings: { sdf: false, fontSize: 64 },
      fontWeight: 700,
    }),
  ];
}
