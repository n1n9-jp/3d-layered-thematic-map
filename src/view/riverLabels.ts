/**
 * 全体の地図の、標高の段と浸水の段に出す、川の名前の札。
 *
 * 幹となる川（荒川・隅田川・江戸川・中川・多摩川）に、名前の札を出す。レイヤー一覧で「標高」または「浸水」の行を開いているあいだだけ、
 * その行の段に出す（初期状態では出さない。避難の段の区名の札と同じ考え方）。
 * 札の置き場所は、区名の札と同じく、画面（px）の上で決める（`calloutPlacement.ts`）。川の上の根元の点（小さな丸）から短い線で、
 * 札どうし・題と切り替えの帯・右の列・レイヤー名・ほかの段のデータのある範囲に重ならない場所へ引き出す。
 * 視点・画面の大きさ・段の高さが変わったときだけ決め直す（マウスの移動では決め直さない）。置けない札は出さない。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { DATA_OUTLINE } from '../config';
import { RIVER_COLOR } from '../layers/rivers';
import type { RiverAnchor } from '../layers/rivers';
import { asModelMatrix, translationMatrix } from '../stack';
import type { ViewState } from '../store';
import { makeProjector } from './camera';
import type { Size } from './camera';
import { placeCallouts } from './calloutPlacement';
import type { CalloutItem } from './calloutPlacement';
import { bandRect } from './layout';
import type { Pt, Rect } from './layout';

type View4 = Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;

/** 札の文字の大きさの段階（px）。先に試すほど大きい。 */
export const RIVER_LABEL_LEVELS = [15, 13, 12] as const;
const PAD_X = 5;
const PAD_Y = 3;
const BORDER = 1.5;
const EDGE = 4;
const COLUMN_GAP = 8;
const LABEL_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, "WenQuanYi Zen Hei", sans-serif';

export interface PlacedRiverLabel {
  name: string;
  /** 札の長方形（画面の px） */
  rect: Rect;
  /** 川の上の根元の点と、引き出し線の札の側の端（画面の px） */
  anchor: Pt;
  attach: Pt;
  /** 根元の点（川の上の座標、m） */
  position: Pt;
}

export interface RiverLabelLayout {
  /** 使った文字の大きさ（px） */
  fontPx: number;
  placed: PlacedRiverLabel[];
  /** 置けなくて出さなかった川 */
  omitted: string[];
  /** 札を置いた段の高さ（m） */
  z: number;
  /** 札の中心、引き出し線の札の側の端（その段の平面の上の座標、m） */
  world: { center: Pt; attach: Pt }[];
}

export interface RiverLabelInput {
  /** 名前の札を出す川（幹となる川）の根元の位置 */
  anchors: readonly RiverAnchor[];
  viewState: View4;
  size: Size | null;
  /** 札を置く段の高さ */
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
    /** 川の名前の札の置き場所を決めた回数（確認用）。視点・画面の大きさ・段の高さが変わったときだけ増える */
    __riverLabelLayouts: number;
    /** いま画面に出している川の名前の札の配置（確認用） */
    __riverLabels: RiverLabelLayout | null;
  }
}

const sizeOf = (name: string, fontPx: number) => ({
  w: name.length * fontPx + 2 * PAD_X + 2 * BORDER,
  h: fontPx + 2 * PAD_Y + 2 * BORDER,
});

/** 札の置き場所を決める。描画領域に大きさがない、または出す札がないときは null。 */
export function layoutRiverLabels(input: RiverLabelInput): RiverLabelLayout | null {
  const { anchors, viewState, size, z, otherZs, columnWidth, layerNameRects } = input;
  if (typeof window !== 'undefined') window.__riverLabelLayouts = (window.__riverLabelLayouts ?? 0) + 1;
  if (!size || size.width < 1 || size.height < 1 || anchors.length === 0) return null;
  const pr = makeProjector(viewState, size);
  const bounds: Rect = { left: EDGE, top: EDGE, right: Math.max(EDGE + 1, size.width - columnWidth - COLUMN_GAP), bottom: size.height - EDGE };
  // 画面の外にある川には、札を出さない
  const visible = anchors
    .map((a) => ({ a, pt: pr.project([a.x, a.y, z]) as Pt }))
    .filter(({ pt }) => pt[0] >= bounds.left && pt[0] <= bounds.right && pt[1] >= bounds.top && pt[1] <= bounds.bottom);
  if (visible.length === 0) return null;

  const hull = (zz: number) => DATA_OUTLINE.map(([x, y]) => pr.project([x, y, zz]) as Pt);
  const hullZs = [...new Set(otherZs.map((v) => Math.round(v)))];
  const obstacles = {
    bounds,
    rects: [bandRect(size.width), ...layerNameRects],
    polys: hullZs.map(hull),
    soft: [hull(z)],
    leaderAvoid: hullZs.filter((zz) => Math.abs(zz - z) > 1).map(hull),
  };
  const attempt = (fontPx: number, subset: typeof visible) => {
    const items: CalloutItem[] = subset.map(({ a, pt }) => ({ id: a.name, anchor: pt, ...sizeOf(a.name, fontPx) }));
    return placeCallouts(items, obstacles);
  };

  // 大きい文字から試す。全部が置けた最初の大きさに決める。どれも全部は置けなければ、いちばん小さい大きさで、置けないものを外す。
  let chosen: { fontPx: number; subset: typeof visible; placed: ReturnType<typeof placeCallouts>['placed'] } | null = null;
  for (const fontPx of RIVER_LABEL_LEVELS) {
    const r = attempt(fontPx, visible);
    if (!r.conflict && r.missing.length === 0) {
      chosen = { fontPx, subset: visible, placed: r.placed };
      break;
    }
  }
  if (!chosen) {
    const fontPx = RIVER_LABEL_LEVELS[RIVER_LABEL_LEVELS.length - 1];
    let subset = [...visible];
    for (;;) {
      const r = attempt(fontPx, subset);
      const missing = new Set(r.missing);
      if (!r.conflict && missing.size === 0) {
        chosen = { fontPx, subset, placed: r.placed };
        break;
      }
      const drop = subset.filter(({ a }) => missing.has(a.name))[0] ?? subset[subset.length - 1];
      subset = subset.filter((s) => s !== drop);
      if (subset.length === 0) {
        chosen = { fontPx, subset, placed: [] };
        break;
      }
    }
  }

  const byName = new Map(chosen.subset.map((s) => [s.a.name, s.a]));
  const placed: PlacedRiverLabel[] = chosen.placed.map((p) => {
    const a = byName.get(p.id) as RiverAnchor;
    return { name: a.name, rect: p.rect, anchor: p.anchor, attach: p.attach, position: [a.x, a.y] };
  });
  const shown = new Set(placed.map((p) => p.name));
  return {
    fontPx: chosen.fontPx,
    placed,
    omitted: anchors.filter((a) => !shown.has(a.name)).map((a) => a.name),
    z,
    world: placed.map((p) => ({
      center: pr.unplane([(p.rect.left + p.rect.right) / 2, (p.rect.top + p.rect.bottom) / 2], z),
      attach: pr.unplane(p.attach, z),
    })),
  };
}

/** 札と引き出し線のレイヤー（段の高さ z の平面の上）。 */
export function riverLabelLayers(layout: RiverLabelLayout): Layer[] {
  const { placed, world, z, fontPx } = layout;
  if (placed.length === 0) return [];
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    pickable: false,
  } as const;
  type Row = { p: PlacedRiverLabel; w: (typeof world)[number] };
  const rows: Row[] = placed.map((p, i) => ({ p, w: world[i] }));
  const leader = (r: Row) => [[r.p.position[0], r.p.position[1], 0], [r.w.attach[0], r.w.attach[1], 0]] as [number, number, number][];
  return [
    new PathLayer<Row>({
      ...common,
      id: 'river-callout-leader-halo',
      data: rows,
      getPath: leader,
      getColor: [8, 10, 16, 235],
      getWidth: 5,
      widthUnits: 'pixels',
      billboard: true,
      capRounded: true,
    }),
    new PathLayer<Row>({
      ...common,
      id: 'river-callout-leader',
      data: rows,
      getPath: leader,
      getColor: [...RIVER_COLOR, 255],
      getWidth: 2,
      widthUnits: 'pixels',
      billboard: true,
      capRounded: true,
    }),
    new ScatterplotLayer<Row>({
      ...common,
      id: 'river-callout-dot',
      data: rows,
      getPosition: (r) => [r.p.position[0], r.p.position[1], 0],
      getFillColor: [...RIVER_COLOR, 255],
      getLineColor: [8, 10, 16, 255],
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      radiusUnits: 'pixels',
      getRadius: 4.5,
      billboard: true,
    }),
    new TextLayer<Row>({
      ...common,
      id: 'river-callout-text',
      data: rows,
      getPosition: (r) => [r.w.center[0], r.w.center[1], 0],
      getText: (r) => r.p.name,
      getSize: fontPx,
      sizeUnits: 'pixels',
      getColor: [214, 244, 255, 255],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      background: true,
      getBackgroundColor: [8, 10, 16, 240],
      backgroundPadding: [PAD_X, PAD_Y],
      backgroundBorderRadius: 3,
      getBorderColor: [...RIVER_COLOR, 255],
      getBorderWidth: BORDER,
      fontFamily: LABEL_FONT,
      characterSet: 'auto',
      fontSettings: { sdf: false, fontSize: 64 },
      fontWeight: 700,
    }),
  ];
}
