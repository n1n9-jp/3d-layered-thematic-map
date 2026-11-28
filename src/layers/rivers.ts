/**
 * 川（水域の面）。標高の段と浸水の段に重ねて描く。段（レイヤー）ではなく、区境界線と同じ「重ね描き」のデータ。
 * データは `rivers.geojson`（水域のポリゴン）と `river-labels.json`（川の名前の位置と、断面で川の名前を引くための標本）。
 * 作り方と出典は README の「川」を参照。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { LayerId } from '../config';
import { fetchJson } from '../lib/fetch';
import { simplifyPath } from './simplify';
import { clipPolylineToCircle } from '../lib/circleClip';
import { asModelMatrix, translationMatrix } from '../stack';
import type { FeatureCollection, PolygonGeometry, Position } from '../types';

/** 川を重ねて描く段。 */
export const RIVER_TIERS: readonly LayerId[] = ['elevation', 'flood'];

/** 川の水色（塗りと細い川の線）。浸水の桃色・標高の緑〜黄〜白・0m 未満の紫の、どの上でも見分けられる明るい水色。 */
export const RIVER_COLOR: [number, number, number] = [64, 214, 255];
/** 細い川にも見える水色の線の太さ（px）。広い川は、実際の幅のまま塗りで見える。 */
export const RIVER_LINE_PX = 1.7;
/**
 * 線を重ねる面の、幅（2 × 面積 ÷ 周長。m）の上限。これより広い面は、塗りだけで線の太さ以上に見える（初期表示で 1 px が約 70 m）。
 * 線の頂点数に描画時間がほぼ比例するので、線は細い面だけに引き、間引く（`PATH_TOLERANCE`）。
 */
export const THIN_WIDTH_M = 100;
/** 全体の地図の線の間引きの許容誤差（m）。拡大の上限（1 px が約 2 m）でも 5 px 以内で、塗りは間引かない。 */
export const PATH_TOLERANCE = 10;

/** 川の名前の標本の点：x, y（m）と、名前の番号（`names` の添字。-1 は、対象外の川）。 */
export type RiverSample = readonly [number, number, number];

export interface RiverAnchor {
  name: string;
  /** 幹となる川（地図に名前の札を出す） */
  trunk: boolean;
  x: number;
  y: number;
}

/** 描画する形。全体の地図ではデータ全体、クローズアップでは円で切ったもの。 */
export interface RiverShapes {
  /** 水域の面（外周と穴のリング）。 */
  polygons: Position[][][];
  /** 面の縁の線（リングごと。全体の地図では、細い面だけを間引いたもの。円で切ったときは、円の縁の部分を含まない）。 */
  paths: Position[][];
}

export interface RiverData extends RiverShapes {
  /** 名前を付ける川（`river-labels.json` の `names`）。 */
  names: string[];
  /** 幹となる川の名前 */
  trunk: string[];
  /** 川ごとに1点、地図に名前の札を置く根元の位置 */
  anchors: RiverAnchor[];
  /** 名前の標本（x, y, 名前の番号）。断面が川を横切る位置の名前を、いちばん近い標本から引く。 */
  samples: RiverSample[];
  /** 面ごとの外接矩形 [minX, minY, maxX, maxY]（切り出しと断面の判定を速くする） */
  boxes: [number, number, number, number][];
}

interface RiverLabelFile {
  names: string[];
  trunk: string[];
  anchors: RiverAnchor[];
  samples: [number, number, number][];
}

type RiverCollection = FeatureCollection<PolygonGeometry, Record<string, never>>;

const boxOf = (rings: Position[][]): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of rings[0]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

/** 面の幅の目安（2 × 面積 ÷ 周長。m）。細長い面なら川幅にほぼ等しい。 */
export function polygonWidth(rings: readonly (readonly Position[])[]): number {
  let area = 0;
  let perimeter = 0;
  rings.forEach((ring, k) => {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      perimeter += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
    }
    area += (k === 0 ? 1 : -1) * Math.abs(a) / 2;
  });
  return perimeter > 0 ? (2 * area) / perimeter : 0;
}

/** `rivers.geojson` と `river-labels.json` を読む。 */
export async function loadRivers(base: string): Promise<RiverData> {
  const [fc, labels] = await Promise.all([
    fetchJson<RiverCollection>(`${base}rivers.geojson`),
    fetchJson<RiverLabelFile>(`${base}river-labels.json`),
  ]);
  const polygons = fc.features.map((f) => f.geometry.coordinates);
  const paths: Position[][] = [];
  for (const rings of polygons) {
    if (polygonWidth(rings) >= THIN_WIDTH_M) continue;
    for (const ring of rings) paths.push(simplifyPath(ring, PATH_TOLERANCE));
  }
  return {
    polygons,
    paths,
    boxes: polygons.map(boxOf),
    names: labels.names,
    trunk: labels.trunk,
    anchors: labels.anchors,
    samples: labels.samples,
  };
}

/** 円（中心 cx, cy・半径 r）の、頂点が 96 個の多角形。凸なので、Sutherland–Hodgman 法の切り抜きに使える。 */
const CIRCLE_STEPS = 96;
function circlePolygon(cx: number, cy: number, r: number): Position[] {
  const out: Position[] = [];
  for (let k = 0; k < CIRCLE_STEPS; k++) {
    const t = (2 * Math.PI * k) / CIRCLE_STEPS;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** リング（閉じている）を、凸多角形 clip（反時計回り）で切り抜く。結果が 3 頂点未満なら null。 */
function clipRingToConvex(ring: readonly Position[], clip: readonly Position[]): Position[] | null {
  let pts: Position[] = ring.slice(0, -1) as Position[];
  for (let i = 0; i < clip.length; i++) {
    if (pts.length === 0) return null;
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Position) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cut = (p: Position, q: Position): Position => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const t = (ex * (a[1] - p[1]) - ey * (a[0] - p[0])) / (ex * dy - ey * dx);
      return [p[0] + t * dx, p[1] + t * dy];
    };
    const next: Position[] = [];
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % pts.length];
      const pi = inside(p);
      const qi = inside(q);
      if (pi && qi) next.push(q);
      else if (pi && !qi) next.push(cut(p, q));
      else if (!pi && qi) next.push(cut(p, q), q);
    }
    pts = next;
  }
  return pts.length < 3 ? null : [...pts, pts[0]];
}

/**
 * 川を、中心 (cx, cy)・半径 r（m）の円で切り出す（クローズアップ用）。面は円で切り、縁の線は円の中の部分だけ（円の縁には線を引かない）。
 * 円と重ならない面は除く。入力は変更しない。
 */
export function clipRivers(rivers: Pick<RiverData, 'polygons' | 'boxes'>, cx: number, cy: number, r: number): RiverShapes {
  const clip = circlePolygon(cx, cy, r);
  const polygons: Position[][][] = [];
  const paths: Position[][] = [];
  rivers.polygons.forEach((rings, i) => {
    const [x0, y0, x1, y1] = rivers.boxes[i];
    if (x1 < cx - r || x0 > cx + r || y1 < cy - r || y0 > cy + r) return;
    const outer = clipRingToConvex(rings[0], clip);
    if (!outer) return;
    const kept: Position[][] = [outer];
    for (const hole of rings.slice(1)) {
      const h = clipRingToConvex(hole, clip);
      if (h) kept.push(h);
    }
    polygons.push(kept);
    for (const ring of rings) for (const piece of clipPolylineToCircle(ring, cx, cy, r)) paths.push(piece);
  });
  return { polygons, paths };
}

// アクセサは参照を固定する（段の高さが変わっても属性を再計算させない）。
const getPolygon = (d: Position[][]) => d;
const getPath = (d: Position[]) => d;

/**
 * 高さ z の段に重ねる川のレイヤー（縁取り、塗り、細い川にも見える水色の線）。
 * データとアクセサの参照は固定で、高さは modelMatrix だけで与える。`tier` は、レイヤーの ID の区別に使う。
 */
export function riverLayers(shapes: RiverShapes, tier: string, z: number): Layer[] {
  if (shapes.polygons.length === 0) return [];
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    modelMatrix: asModelMatrix(translationMatrix(z)),
    pickable: false,
  } as const;
  const line = {
    ...common,
    data: shapes.paths,
    getPath,
    positionFormat: 'XY',
    widthUnits: 'pixels',
    billboard: true,
    // 線は細いので、端と継ぎ目は丸めない（頂点ごとの描画の量が減る）
    capRounded: false,
    jointRounded: false,
  } as const;
  return [
    new SolidPolygonLayer<Position[][]>({
      ...common,
      id: `rivers-fill-${tier}`,
      data: shapes.polygons,
      getPolygon,
      positionFormat: 'XY',
      getFillColor: RIVER_COLOR,
    }),
    // 細い川（実際の幅が線より細い）だけ、細い線を重ねる。広い川は、塗りで実際の幅のまま見える。
    new PathLayer<Position[]>({ ...line, id: `rivers-line-${tier}`, getColor: [...RIVER_COLOR, 255], getWidth: RIVER_LINE_PX }),
  ];
}
