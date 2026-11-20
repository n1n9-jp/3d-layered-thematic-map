/**
 * 範囲の柱：固定した円を、表示中の最下段から最上段まで貫く半透明の円柱。
 * 側面は小さな縦長の四角形の輪にして、カメラへ向く度合い（facing）で透明度を変える。
 * 全体の地図とクローズアップで同じ見た目を使う。
 *
 * 形と色の計算は純粋関数（このファイルの上半分）。レイヤーを作るのは下半分。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { asModelMatrix } from '../stack';
import { towardCamera } from '../view/camera';

/** 円の中心と半径（m）。 */
export interface PillarCircle {
  x: number;
  y: number;
  r: number;
}

/** 側面の1枚。高さは 0〜1 の単位で持つ（実際の高さは modelMatrix の拡大で与える）。 */
export interface Wall {
  /** 下の2点、上の2点の順（始点側の下 → 終点側の下 → 終点側の上 → 始点側の上） */
  polygon: [number, number, number][];
  /** 外向きの法線（水平、単位ベクトル） */
  normal: [number, number];
}

/** 側面の分割数。 */
export const PILLAR_STEPS = 96;

/** 円柱の側面。steps 枚の縦長の四角形が、円を一周する。 */
export function pillarWalls(c: PillarCircle, steps = PILLAR_STEPS): Wall[] {
  const walls: Wall[] = [];
  for (let k = 0; k < steps; k++) {
    const t0 = (2 * Math.PI * k) / steps;
    const t1 = (2 * Math.PI * (k + 1)) / steps;
    const x0 = c.x + c.r * Math.cos(t0);
    const y0 = c.y + c.r * Math.sin(t0);
    const x1 = c.x + c.r * Math.cos(t1);
    const y1 = c.y + c.r * Math.sin(t1);
    const tm = (t0 + t1) / 2;
    walls.push({
      polygon: [
        [x0, y0, 0],
        [x1, y1, 0],
        [x1, y1, 1],
        [x0, y0, 1],
      ],
      normal: [Math.cos(tm), Math.sin(tm)],
    });
  }
  return walls;
}

/**
 * 面がカメラへ向く度合い（-1〜1）。1 は真正面（手前の壁の中央）、-1 は真後ろ（奥の壁の中央）、0 は輪郭（縁）。
 * toward はカメラのほうへ向かう水平の単位ベクトル。
 */
export function facing(normal: readonly [number, number], toward: readonly [number, number]): number {
  return Math.max(-1, Math.min(1, normal[0] * toward[0] + normal[1] * toward[1]));
}

/** 柱の色（橙。探針の固定中の色と同系で、円の縁とつながって見える）。 */
export const PILLAR_RGB: [number, number, number] = [255, 190, 70];

/**
 * 側面の透明度（0〜255）。輪郭（facing 0）に近いほど濃く、真正面・真後ろの中央ほど薄い。
 * データの上に重なるので、中央は非常に薄くする。奥の壁は、手前の壁より少し濃くして、奥行きを出す。
 */
export function wallAlpha(f: number): number {
  const edge = (1 - Math.abs(f)) ** 2;
  return f >= 0 ? 5 + 40 * edge : 14 + 60 * edge;
}

export function wallColor(f: number): [number, number, number, number] {
  return [PILLAR_RGB[0], PILLAR_RGB[1], PILLAR_RGB[2], Math.round(wallAlpha(f))];
}

/**
 * 輪郭の2本の縦線の水平位置。カメラへ向かう向き toward に垂直な、円の左右の端。
 */
export function silhouettePoints(c: PillarCircle, toward: readonly [number, number]): [number, number][] {
  const nx = -toward[1];
  const ny = toward[0];
  return [
    [c.x + c.r * nx, c.y + c.r * ny],
    [c.x - c.r * nx, c.y - c.r * ny],
  ];
}

/** 柱を描く高さの範囲。段が2枚以上あり、離れているときだけ。 */
export function pillarSpan(zs: readonly number[]): { zMin: number; zMax: number } | null {
  if (zs.length < 2) return null;
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  return zMax - zMin > 1 ? { zMin, zMax } : null;
}

/** [0,0,zMin] への平行移動と、z 方向の拡大（高さ 0〜1 の側面を zMin〜zMax にする）。列優先の16要素。 */
export function pillarMatrix(zMin: number, zMax: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, zMax - zMin, 0, 0, 0, zMin, 1];
}

/* ---------- レイヤー ---------- */

// 同じ円なら配列の参照を使い回す（高さや視点が変わっても属性を作り直さない）。
let cached: { key: string; walls: Wall[] } | null = null;
function wallsOf(c: PillarCircle): Wall[] {
  const key = `${c.x},${c.y},${c.r}`;
  if (cached?.key !== key) cached = { key, walls: pillarWalls(c) };
  return cached.walls;
}

const getPolygon = (d: Wall) => d.polygon;
const common = {
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  pickable: false,
  // 全体の地図と同じく、深度テストを切って配列の順だけで重ねる。
  parameters: { depthCompare: 'always', depthWriteEnabled: false },
} as const;

/** 輪郭の縦線の色。円の縁（橙）と同じ色で、少し透かす。 */
const SILHOUETTE_COLOR: [number, number, number, number] = [255, 176, 0, 150];

/**
 * 範囲の柱のレイヤー。zs は表示中の各段の高さ。柱を描かない条件（段が1枚、間隔 0）のときは空。
 * idPrefix は、同じ画面に複数の積層を描くときの ID の接頭辞。
 */
export function pillarLayers(opts: {
  circle: PillarCircle;
  zs: readonly number[];
  rotationOrbit: number;
  idPrefix: string;
}): Layer[] {
  const { circle, zs, rotationOrbit, idPrefix } = opts;
  const span = pillarSpan(zs);
  if (!span) return [];
  const toward = towardCamera(rotationOrbit);
  const wallLayer = new SolidPolygonLayer<Wall>({
    ...common,
    id: `${idPrefix}-pillar-wall`,
    data: wallsOf(circle),
    modelMatrix: asModelMatrix(pillarMatrix(span.zMin, span.zMax)),
    _full3d: true,
    getPolygon,
    getFillColor: (d: Wall) => wallColor(facing(d.normal, toward)),
    updateTriggers: { getFillColor: [toward[0], toward[1]] },
    extruded: false,
    filled: true,
  });
  const edges = silhouettePoints(circle, toward).map(([x, y]) => ({
    path: [[x, y, span.zMin], [x, y, span.zMax]] as [number, number, number][],
  }));
  const edgeLayer = new PathLayer<(typeof edges)[number]>({
    ...common,
    id: `${idPrefix}-pillar-edge`,
    data: edges,
    getPath: (d) => d.path,
    getColor: SILHOUETTE_COLOR,
    getWidth: 1.2,
    widthUnits: 'pixels',
    billboard: true, // 縦線は幅を画面に向けて広げる
    capRounded: true,
  });
  return [wallLayer, edgeLayer];
}
