import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import type { PolygonRings } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { BoundaryData, FacilityCollection, LayerModule, Position, ShelterCollection, ShelterSummary } from '../types';
import {
  HATCH_COLOR,
  NONE_COLOR,
  SHELTER_COLORS,
  buildShelterData,
  sampleShelters,
  sectionShelters,
  shelterOverview,
  shelterSectionIndex,
  subsetShelters,
  summarizeShelters,
  wardLabelsOf,
} from './shelters/model';
import type { ShelterData, ShelterKind, WardLabel } from './shelters/model';

export type { ShelterData };

type Rgb = [number, number, number];

/** 洪水・高潮で使えるものは大きく鮮やか。それ以外は小さく控えめ。病院は赤で、白い縁を付けて見分ける。 */
const STYLE: Record<ShelterKind, { radius: number; minPx: number; maxPx: number; outline: Rgb; lineWidth: number }> = {
  other: { radius: 70, minPx: 2, maxPx: 4.5, outline: [0, 0, 0], lineWidth: 0.4 },
  hospital: { radius: 120, minPx: 4, maxPx: 10, outline: [255, 255, 255], lineWidth: 1.4 },
  usable: { radius: 170, minPx: 5, maxPx: 13, outline: [255, 255, 255], lineWidth: 1.2 },
};
/** 描く順（下から）：控えめなものを先に、目立たせたいものを後に。 */
const DRAW_ORDER: ShelterKind[] = ['other', 'hospital', 'usable'];

const LABEL_FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, "WenQuanYi Zen Hei", sans-serif';

const getPosition = (d: Position) => d;
const getRings = (d: PolygonRings) => d as never;
const getSegment = (d: Position[]) => d;

/** クローズアップの円の中の区名の札。目印（区の重心）の位置に、2行で出す。 */
function closeupLabelLayer(
  data: ShelterData,
  common: { coordinateSystem: typeof COORDINATE_SYSTEM.CARTESIAN; modelMatrix: ReturnType<typeof asModelMatrix>; opacity: number; pickable: false },
) {
  return new TextLayer<WardLabel>({
    ...common,
    id: 'shelters-deep-label',
    data: wardLabelsOf(data),
    getPosition: (d) => [d.position[0], d.position[1], 0],
    getText: (d) => d.text,
    // 平面の拡縮に合わせて大きさを変える（小さい画面で、積層を覆わないように）。読める大きさ（9〜14 px）には収める
    getSize: 800,
    sizeUnits: 'meters',
    sizeMinPixels: 9,
    sizeMaxPixels: 14,
    getColor: (d) => [...(d.kind === 'none' ? NONE_COLOR : HATCH_COLOR), 255],
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    background: true,
    getBackgroundColor: [8, 10, 16, 215],
    backgroundPadding: [4, 2],
    fontFamily: LABEL_FONT,
    characterSet: 'auto',
    fontSettings: { sdf: false, fontSize: 64 },
    fontWeight: 700,
  });
}

const shelters: LayerModule<ShelterData> = {
  id: 'shelters',
  label: '避難',
  async load(base) {
    const [sh, summary, facilities, boundary] = await Promise.all([
      fetchJson<ShelterCollection>(`${base}shelters.geojson`),
      fetchJson<ShelterSummary>(`${base}shelters.json`),
      fetchJson<FacilityCollection>(`${base}facilities.geojson`),
      fetchJson<BoundaryData>(`${base}boundary.geojson`),
    ]);
    const data = buildShelterData(sh, summary, facilities, boundary);
    shelterSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
  },
  render(data, ctx) {
    const common = {
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      opacity: ctx.opacity,
      pickable: false,
    } as const;
    return [
      // 未公開の区（データに載っていない。0 件の区ではなく、データがない区）：薄い塗りと、斜めの灰の網掛け
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-gap-fill',
        data: data.gapPolygons,
        getPolygon: getRings,
        getFillColor: [...HATCH_COLOR, 34],
        filled: true,
        extruded: false,
      }),
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-gap-hatch',
        data: data.hatch,
        getPath: getSegment,
        getColor: [...HATCH_COLOR, 150],
        getWidth: 1,
        widthUnits: 'pixels',
        billboard: true,
      }),
      // 指定なしの区（データに載っていて、洪水・高潮用の指定が 0 件）：輪郭の枠だけ。塗りも網掛けもしない
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-none-frame',
        data: data.frame,
        getPath: getSegment,
        getColor: [...NONE_COLOR, 235],
        getWidth: 2.2,
        widthUnits: 'pixels',
        billboard: true,
        capRounded: true,
        jointRounded: true,
      }),
      ...DRAW_ORDER.map((kind) => {
        const s = STYLE[kind];
        return new ScatterplotLayer<Position>({
          ...common,
          id: `shelters-${kind}`,
          data: data.points[kind],
          getPosition,
          getFillColor: SHELTER_COLORS[kind],
          getLineColor: s.outline,
          getRadius: s.radius,
          radiusUnits: 'meters',
          radiusMinPixels: s.minPx,
          radiusMaxPixels: s.maxPx,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: s.lineWidth,
          billboard: false,
        });
      }),
      // 区名の札は、全体の地図では、視点に合わせて目印から離して置く（`src/view/wardLabels.ts`）。クローズアップ（円で切り出したデータ）では、円が小さいので、目印の位置にそのまま出す
      ...(data.clip ? [closeupLabelLayer(data, common)] : []),
    ];
  },
  sample: sampleShelters,
  section: (data, line) => [sectionShelters(data, line)],
  subset: subsetShelters,
  summarize: summarizeShelters,
  legend: () => [
    { color: SHELTER_COLORS.usable, label: '洪水・高潮で使える避難場所' },
    { color: SHELTER_COLORS.other, label: 'それ以外の避難場所' },
    { color: SHELTER_COLORS.hospital, label: '病院' },
    { color: NONE_COLOR, label: '指定なし：洪水・高潮用の指定が 0 件の区', swatch: 'frame' },
    { color: HATCH_COLOR, label: '未公開：データに載っていない区（ないとは限らない）', swatch: 'hatch' },
  ],
  notes: (data) => {
    const notes = [
      '指定緊急避難場所は、災害の種別ごとに指定されています。データが最新でない場合や、未掲載の場合があります。収容人数は含みません。',
    ];
    if (data) {
      const o = shelterOverview(data);
      if (o.none.length > 0)
        notes.push(
          `指定なし（${o.none.map((w) => w.name).join('・')}）は、このデータに洪水・高潮で使える指定緊急避難場所が載っていません。「指定がない」ことは「避難できない」ことではありません。各区の避難の計画は、このデータからは分かりません。`,
        );
      if (o.unpublished.length > 0)
        notes.push(
          `未公開（${o.unpublished.join('・')}）は、このデータに指定緊急避難場所が載っていません（0 件は「ない」ではなく「データがない」です）。洪水・高潮用の避難場所があるかどうかは、このデータからは分かりません。`,
        );
    }
    return notes;
  },
};

export default shelters;
