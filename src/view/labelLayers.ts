import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { TextLayer } from '@deck.gl/layers';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import { registry } from '../layers';
import type { ViewState } from '../store';
import { DATA_BOX, labelAnchors, projectPoint, spreadLabels } from './camera';
import type { PlaneBox, Size } from './camera';
import type { Rect } from './layout';

type P3 = [number, number, number];
type LabelDatum = { id: LayerId; text: string };
type HaloDatum = LabelDatum & { dx: number; dy: number };

const LABEL_COLOR: [number, number, number, number] = [225, 230, 240, 255];
const LABEL_HALO_COLOR: [number, number, number, number] = [0, 0, 0, 255];
/** 文字の縁取りに使う、黒い文字を重ねる方向（px）。 */
const HALO_OFFSETS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
];
const LABEL_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, "WenQuanYi Zen Hei", sans-serif';
/** レイヤー名どうしの縦の最小間隔（px）。 */
const LABEL_GAP = 20;
/** レイヤー名の文字の大きさ（px）と、段の右脇の位置からの右へのずれ（px）。 */
const LABEL_FONT_PX = 14;
const LABEL_BASE_OFFSET_X = 10;

const LABELS: LabelDatum[] = LAYER_IDS.map((id) => ({ id, text: registry[id].label }));

/** 各段のレイヤー名の、右脇の位置（世界座標）と、重なるときに画面の縦へ押し広げる量（px）。 */
function stackLabelPlacement(opts: {
  tiers: { id: LayerId; z: number }[];
  viewState: Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;
  size: Size | null;
  box?: PlaneBox;
}) {
  const { tiers, viewState, size, box = DATA_BOX } = opts;
  const anchors = labelAnchors(viewState.rotationX, viewState.rotationOrbit, tiers.map((t) => t.z), box);
  const anchorById = new Map(tiers.map((t, i) => [t.id, anchors[i]]));
  // 平面が近づいて名前が重なるときは、画面上で縦に押し広げて読めるようにする。
  const screenY = size ? anchors.map((a) => projectPoint(viewState, size, a)[1]) : anchors.map(() => 0);
  const spread = spreadLabels(screenY, LABEL_GAP);
  const offsetById = new Map(tiers.map((t, i) => [t.id, spread[i] - screenY[i]]));
  return { anchors, anchorById, offsetById };
}

/**
 * 各段のレイヤー名が占める長方形（画面の px）。区名の札を、レイヤー名に重ねずに置くために使う。
 * 文字は 14 px。名前の左端は、段の右脇の位置から 10 px 右。
 */
export function stackLabelRects(opts: {
  tiers: { id: LayerId; z: number }[];
  viewState: Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;
  size: Size;
  box?: PlaneBox;
}): Rect[] {
  const { tiers, viewState, size } = opts;
  const { anchors, offsetById } = stackLabelPlacement(opts);
  return tiers.map((t, i) => {
    const [x, y] = projectPoint(viewState, size, anchors[i]);
    const left = x + LABEL_BASE_OFFSET_X - 1;
    const cy = y + (offsetById.get(t.id) ?? 0);
    return { left, right: left + registry[t.id].label.length * LABEL_FONT_PX + 4, top: cy - LABEL_FONT_PX / 2 - 2, bottom: cy + LABEL_FONT_PX / 2 + 2 };
  });
}

/**
 * 各段の右脇に出すレイヤー名。`tiers` は表示中の段（id と高さ）。
 * box は平面の位置と大きさ（既定は全体の積層の、23区のデータのある範囲、クローズアップでは切り出した円）。
 * `prefix` は、同じ画面に複数の積層を描くときのレイヤー ID の接頭辞。
 */
export function stackLabelLayers(opts: {
  tiers: { id: LayerId; z: number }[];
  viewState: Pick<ViewState, 'target' | 'rotationX' | 'rotationOrbit' | 'zoom'>;
  size: Size | null;
  box?: PlaneBox;
  prefix?: string;
}): Layer[] {
  const { tiers, viewState, size, box = DATA_BOX, prefix = 'stack' } = opts;
  const { anchorById, offsetById } = stackLabelPlacement({ tiers, viewState, size, box });
  // 日本語の画数の多い字（「標」など）は、SDF 方式だと14px の大きさでつぶれて読めない。
  // そのため SDF は使わず、通常の文字テクスチャで描く。縁取りの代わりに、黒い同じ文字を8方向に1px ずらして
  // 後ろに重ねる（明るい標高の面や区境界線の上でも読めるようにする）。
  const labelData = LABELS.filter((l) => anchorById.has(l.id));
  const labelProps = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getText: (d: LabelDatum) => d.text,
    getSize: LABEL_FONT_PX,
    sizeUnits: 'pixels',
    getTextAnchor: 'start',
    getAlignmentBaseline: 'center',
    fontFamily: LABEL_FONT,
    characterSet: 'auto',
    fontSettings: { sdf: false, fontSize: 64 },
    pickable: false,
  } as const;
  const labelUpdateTriggers = {
    getPosition: [
      tiers.map((t) => `${t.id}:${t.z.toFixed(2)}`).join(),
      viewState.rotationX,
      viewState.rotationOrbit,
      box.cx,
      box.cy,
      box.half,
    ],
    getPixelOffset: [tiers.map((t) => `${t.id}:${(offsetById.get(t.id) ?? 0).toFixed(1)}`).join()],
  };
  const labelBaseOffset = (d: LabelDatum): [number, number] => [LABEL_BASE_OFFSET_X, offsetById.get(d.id) ?? 0];
  const haloData: HaloDatum[] = HALO_OFFSETS.flatMap(([dx, dy]) => labelData.map((l) => ({ ...l, dx, dy })));
  return [
    new TextLayer<HaloDatum>({
      ...labelProps,
      id: `${prefix}-labels-halo`,
      data: haloData,
      getPosition: (d) => anchorById.get(d.id) as P3,
      getColor: LABEL_HALO_COLOR,
      getPixelOffset: (d) => {
        const [x, y] = labelBaseOffset(d);
        return [x + d.dx, y + d.dy];
      },
      updateTriggers: labelUpdateTriggers,
    }),
    new TextLayer<LabelDatum>({
      ...labelProps,
      id: `${prefix}-labels`,
      data: labelData,
      getPosition: (d) => anchorById.get(d.id) as P3,
      getColor: LABEL_COLOR,
      getPixelOffset: labelBaseOffset,
      updateTriggers: labelUpdateTriggers,
    }),
  ];
}
