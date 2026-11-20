/**
 * 対応の線の描画。全体の地図とクローズアップで同じものを使う。
 * 線は、段をまたぐ3次元の線分。深度テストを切って、段のレイヤーより後ろに重ね描きする。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { LayerId } from '../config';
import { FACILITY_COLOR } from '../layers/facilitiesModel';
import type { LinkSet } from './compute';
import { linkHeights, linkStyle } from './linksModel';
import type { LinkKind } from './linksModel';

type P3 = [number, number, number];
type Rgba = [number, number, number, number];
export interface Segment {
  from: P3;
  to: P3;
  color: Rgba;
}

const common = {
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  pickable: false,
  parameters: { depthCompare: 'always', depthWriteEnabled: false },
} as const;

/** 駅 → 直下の人口の線の下に敷く縁取り（淡い色）。暗い背景でも、凡例の暗い色の線が見えるようにする。 */
const CASING_RGB: [number, number, number] = [226, 232, 245];
/** 縁取りの、本体の線に対する透明度の比。 */
const CASING_ALPHA = 0.6;
/** 縁取りが本体の線より太い分（px）。 */
const CASING_EXTRA = 1.6;

/* ---------- 線分 ---------- */

// 同じ関係・同じ高さなら配列の参照を使い回す（視点が変わるだけの再描画で、位置の属性を作り直させない）。
const segmentCache = new WeakMap<LinkSet, Map<string, Segment[]>>();

/** 描く線分。段の高さ zs のうち、関係に必要な2つがそろっていなければ空。 */
export function linkSegments(
  kind: LinkKind,
  links: LinkSet,
  zs: Readonly<Partial<Record<LayerId, number | null>>>,
): Segment[] {
  const h = linkHeights(kind, zs);
  if (!h) return [];
  let byKey = segmentCache.get(links);
  if (!byKey) segmentCache.set(links, (byKey = new Map()));
  const key = `${kind}|${h[0]}|${h[1]}`;
  let segments = byKey.get(key);
  if (!segments) {
    if (byKey.size > 16) byKey.clear(); // 間隔のアニメーション中に、高さごとの結果がたまらないように
    byKey.set(key, (segments = buildSegments(kind, links, h)));
  }
  return segments;
}

function buildSegments(kind: LinkKind, links: LinkSet, [z0, z1]: [number, number]): Segment[] {
  if (kind === 'facility-station') {
    const r = links.facilityStation;
    if (!r) return [];
    const { alpha } = linkStyle(r.links.length);
    return r.links.map((l) => {
      const [cr, cg, cb] = FACILITY_COLOR[l.kind];
      return { from: [l.from[0], l.from[1], z0], to: [l.to[0], l.to[1], z1], color: [cr, cg, cb, alpha] };
    });
  }
  const r = links.stationPopulation;
  if (!r) return [];
  const { alpha } = linkStyle(r.links.length);
  return r.links.map((l) => ({
    from: [l.at[0], l.at[1], z0],
    to: [l.at[0], l.at[1], z1],
    color: [l.color[0], l.color[1], l.color[2], alpha],
  }));
}

const casingCache = new WeakMap<Segment[], Segment[]>();
function casingOf(data: Segment[]): Segment[] {
  let c = casingCache.get(data);
  if (!c)
    casingCache.set(
      data,
      (c = data.map((d) => ({ from: d.from, to: d.to, color: [CASING_RGB[0], CASING_RGB[1], CASING_RGB[2], Math.round(d.color[3] * CASING_ALPHA)] }))),
    );
  return c;
}

/* ---------- レイヤー ---------- */

const getSource = (d: Segment) => d.from;
const getTarget = (d: Segment) => d.to;
const getColor = (d: Segment) => d.color;
const getFoot = (d: Segment) => d.to;
const getFootFill = (d: Segment): Rgba => [d.color[0], d.color[1], d.color[2], 255];

/**
 * 対応の線のレイヤー。on はオンにしている関係。2つの段のどちらかが表示されていない関係は描かない。
 * idPrefix は、同じ画面に複数の積層を描くときの ID の接頭辞。
 */
export function linkLayers(opts: {
  links: LinkSet;
  on: Readonly<Record<LinkKind, boolean>>;
  zs: Readonly<Partial<Record<LayerId, number | null>>>;
  idPrefix: string;
}): Layer[] {
  const { links, on, zs, idPrefix } = opts;
  const layers: Layer[] = [];
  for (const kind of ['facility-station', 'station-population'] as const) {
    if (!on[kind]) continue;
    const data = linkSegments(kind, links, zs);
    if (data.length === 0) continue;
    const { width } = linkStyle(data.length);
    const line = (id: string, segments: Segment[], w: number) =>
      new LineLayer<Segment>({
        ...common,
        id: `${idPrefix}-link-${id}`,
        data: segments,
        getSourcePosition: getSource,
        getTargetPosition: getTarget,
        getColor,
        getWidth: w,
        widthUnits: 'pixels',
      });
    if (kind === 'station-population') {
      layers.push(line(`${kind}-casing`, casingOf(data), width + CASING_EXTRA), line(kind, data, width));
      // 人口の段に着く足元の点。色は人口密度の段階（線が暗くても、どの段階かが読める）。
      layers.push(
        new ScatterplotLayer<Segment>({
          ...common,
          id: `${idPrefix}-link-${kind}-foot`,
          data,
          getPosition: getFoot,
          getFillColor: getFootFill,
          getLineColor: [CASING_RGB[0], CASING_RGB[1], CASING_RGB[2], 220],
          getRadius: 2 + width,
          radiusUnits: 'pixels',
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1,
          billboard: false,
        }),
      );
    } else {
      layers.push(line(kind, data, width));
    }
  }
  return layers;
}
