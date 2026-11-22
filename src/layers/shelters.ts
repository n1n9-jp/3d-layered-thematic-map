import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { computeWardExposure } from '../aggregate/wardExposure';
import type { WardExposure } from '../aggregate/wardExposure';
import { fetchJson } from '../lib/fetch';
import type { PolygonRings } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { BoundaryData, FacilityCollection, LayerModule, Position, ShelterCollection, ShelterSummary } from '../types';
import floodLayer from './flood';
import populationLayer from './population';
import {
  DEEP_NONE_COLOR,
  HATCH_COLOR,
  SHALLOW_NONE_COLOR,
  SHELTER_COLORS,
  buildShelterData,
  sampleShelters,
  sectionShelters,
  shelterOverview,
  shelterSectionIndex,
  subsetShelters,
  summarizeShelters,
} from './shelters/model';
import { shareLabel } from '../aggregate/wardExposure';
import type { ShelterData, ShelterKind } from './shelters/model';

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
    // 洪水・高潮用が 0 件の区を、その区の浸水の想定（深さ 3m 以上の区域に住む人の割合）で分けるために、人口と浸水想定を使う。
    // 読み込みに失敗したときは、区ごとの浸水の想定なしで進む（その区は「指定 0 件」とだけ出す）。
    let exposure: Map<string, WardExposure> | undefined;
    try {
      const [pop, flood] = await Promise.all([populationLayer.load(base), floodLayer.load(base)]);
      exposure = computeWardExposure(pop, flood, boundary);
    } catch (e) {
      console.error('[shelters] 区ごとの浸水の想定を求められません', e);
    }
    const data = buildShelterData(sh, summary, facilities, boundary, exposure);
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
      // 浸水が小さく、洪水・高潮用の指定がない区：ごく薄い塗りだけ（問題を示すものではないので、目立たせない）
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-shallow-fill',
        data: data.shallow,
        getPolygon: getRings,
        getFillColor: [...SHALLOW_NONE_COLOR, 64],
        filled: true,
        extruded: false,
      }),
      // データ未公開の区（浸水が深い・小さいの両方）：薄い塗りと、斜めの網掛け（0 件の区ではなく、データがない区であることを示す）
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-gap-fill',
        data: data.gapPolygons,
        getPolygon: getRings,
        getFillColor: [...HATCH_COLOR, 34],
        filled: true,
        extruded: false,
      }),
      // データ未公開で、浸水が深い区：網掛け（データがない）の上に、琥珀の薄い塗りと縁（浸水が深い）を重ねる
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-unpub-deep-fill',
        data: data.unpubDeep.polygons,
        getPolygon: getRings,
        getFillColor: [...DEEP_NONE_COLOR, 70],
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
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-unpub-deep-outline',
        data: data.unpubDeep.outline,
        getPath: getSegment,
        getColor: [...DEEP_NONE_COLOR, 255],
        getWidth: 2.4,
        widthUnits: 'pixels',
        billboard: true,
        capRounded: true,
        jointRounded: true,
      }),
      // 浸水が深いのに、洪水・高潮用の指定がない区：この地図の主題。琥珀色の塗り・太めの斜線・太い縁と、区名のラベルで見落とされないようにする
      new SolidPolygonLayer<PolygonRings>({
        ...common,
        id: 'shelters-deep-fill',
        data: data.deep.polygons,
        getPolygon: getRings,
        getFillColor: [...DEEP_NONE_COLOR, 56],
        filled: true,
        extruded: false,
      }),
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-deep-hatch',
        data: data.deep.hatch,
        getPath: getSegment,
        getColor: [...DEEP_NONE_COLOR, 210],
        getWidth: 1.6,
        widthUnits: 'pixels',
        billboard: true,
      }),
      new PathLayer<Position[]>({
        ...common,
        id: 'shelters-deep-outline',
        data: data.deep.outline,
        getPath: getSegment,
        getColor: [...DEEP_NONE_COLOR, 255],
        getWidth: 2.6,
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
      new TextLayer<{ position: Position; text: string }>({
        ...common,
        id: 'shelters-deep-label',
        data: [...data.deep.labels, ...data.unpubDeep.labels],
        getPosition: (d) => [d.position[0], d.position[1], 0],
        getText: (d) => d.text,
        // 平面の拡縮に合わせて大きさを変える（小さい画面で、積層を覆わないように）。読める大きさ（9〜14 px）には収める
        getSize: 800,
        sizeUnits: 'meters',
        sizeMinPixels: 9,
        sizeMaxPixels: 14,
        getColor: [...DEEP_NONE_COLOR, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        background: true,
        getBackgroundColor: [8, 10, 16, 215],
        backgroundPadding: [4, 2],
        fontFamily: LABEL_FONT,
        characterSet: 'auto',
        fontSettings: { sdf: false, fontSize: 64 },
        fontWeight: 700,
      }),
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
    { color: DEEP_NONE_COLOR, label: '琥珀の斜線と縁：浸水が深いのに、洪水・高潮用の指定がない区', swatch: 'alert' },
    { color: DEEP_NONE_COLOR, label: '灰の網掛けに琥珀の縁：データ未公開で、浸水が深い区', swatch: 'hatch-deep' },
    { color: HATCH_COLOR, label: '灰の網掛け：データ未公開で、浸水が小さい区', swatch: 'hatch' },
    { color: SHALLOW_NONE_COLOR, label: 'ごく薄い塗り：浸水が小さく、洪水・高潮用の指定がない区', swatch: 'faint' },
  ],
  notes: (data) => {
    const notes = [
      '指定緊急避難場所は、災害の種別ごとに指定されています。データが最新でない場合や、未掲載の場合があります。収容人数は含みません。',
    ];
    if (data) {
      const o = shelterOverview(data);
      const shares = (ws: { severeShare: number | null }[]) => ws.map((w) => shareLabel(w.severeShare ?? 0)).join('・');
      if (o.deepNone.length > 0)
        notes.push(
          `琥珀の斜線の区（${o.deepNone.map((w) => w.name).join('・')}）は、このデータに洪水・高潮で使える指定緊急避難場所が載っていません。区の人口の ${shares(o.deepNone)}（順に）が、深さ 3m 以上の浸水想定の区域に住んでいます。「指定がない」ことは「避難できない」ことではありません。各区の避難の計画は、このデータからは分かりません。`,
        );
      if (o.unpublishedDeep.length > 0)
        notes.push(
          `灰の網掛けに琥珀の縁の区（${o.unpublishedDeep.map((w) => w.name).join('・')}）は、このデータに指定緊急避難場所が載っていません（0 件は「ない」ではなく「データがない」です）。一方、区の人口の ${shares(o.unpublishedDeep)}（順に）が、深さ 3m 以上の浸水想定の区域に住んでいます。洪水・高潮用の避難場所があるかどうかは、このデータからは分かりません。`,
        );
      if (o.unpublishedShallow.length > 0)
        notes.push(
          `灰の網掛けだけの区（${o.unpublishedShallow.map((w) => w.name).join('・')}）も、このデータに指定緊急避難場所が載っていません（0 件は「ない」ではなく「データがない」です）。浸水の想定は小さい区です${o.unpublishedShallow.every((w) => w.severeShare !== null) ? `（深さ 3m 以上の区域に住む人は、区の人口の ${shares(o.unpublishedShallow)}（順に））` : ''}。`,
        );
      if (o.shallowNone.length > 0)
        notes.push(
          `ごく薄い区（${o.shallowNone.map((w) => w.name).join('・')}）も、洪水・高潮用の指定は載っていませんが、浸水の想定は小さい区です（深さ 3m 以上の区域に住む人は、区の人口の ${shares(o.shallowNone)}（順に））。`,
        );
    }
    return notes;
  },
};

export default shelters;
