/**
 * 全体の地図に描く、断面の deck.gl レイヤー。
 * - 切り口の線と両端の印（各段）。始点 A は塗りの丸、終点 B は輪
 * - 切り口に沿って垂直に立てるグラフ（各段）：系列は面グラフの帯、交差や近くの地物は柱
 * - 両端を全段に貫く垂直線と、A・B の札、カーソルの位置を示す垂直線と印
 *
 * 描く順は、StackView が「その段の平面の後、1つ上の段の平面の前」に挿す。
 * 段ごとのレイヤーは、段の目標の高さ（z）の平行移動を modelMatrix に持つ。立てるグラフの高さは z から測った値で、
 * 段の高さが補間で動くときは、StackView が `withHeight` で modelMatrix だけ差し替える。
 */
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import type { LayerId } from '../config';
import { pointAt } from '../lib/section';
import { probeMarkLayers } from '../probe/controller';
import { RING_RADIUS_PX } from '../probe/markDrag';
import { asModelMatrix, translationMatrix } from '../stack';
import type { SectionLine, SectionTrack } from '../types';
import { bandQuads, edgePath, edgeRuns, postsOf, wallPolygon } from './model';

type P3 = [number, number, number];
type RGBA = [number, number, number, number];

/** 切り口の線の色。探針の水色・橙、道路や鉄道の配色と、どのレイヤーの値の色とも重ならない白。 */
const LINE_COLOR: RGBA = [255, 255, 255, 255];
const HALO: RGBA = [0, 0, 0, 220];
/** 立てた帯の塗りの不透明度（0〜255）。奥の段が読める程度に透かす。 */
export const WALL_ALPHA = 150;
/** 切り口の面（立てられる高さの全体）の薄い背景。 */
const CURTAIN_COLOR: RGBA = [255, 255, 255, 14];
/** 立てた柱の高さの、立てられる高さに対する割合。 */
const POST_RATIO = 0.55;
/** 縦軸の上端を超えた区間の縁の色。 */
const CAP_COLOR: RGBA = [255, 255, 255, 255];

const common = {
  coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
  pickable: false,
} as const;

const tierMatrix = (z: number) => asModelMatrix(translationMatrix(z));

/** 段の高さ z に、切り口の線と両端の印を描く。draft は、始点を置いた後の、カーソルまでの下書き（細く、端の印は始点だけ）。 */
export function sectionLineLayers(id: string, line: SectionLine, z: number, draft = false): Layer[] {
  const path = [{ path: [[line.ax, line.ay, 0], [line.bx, line.by, 0]] as P3[] }];
  const m = tierMatrix(z);
  const lineProps = {
    ...common,
    data: path,
    modelMatrix: m,
    getPath: (d: (typeof path)[number]) => d.path,
    widthUnits: 'pixels',
    billboard: true,
    capRounded: true,
  } as const;
  const ends = draft
    ? [{ at: [line.ax, line.ay, 0] as P3, kind: 'a' as const }]
    : [
        { at: [line.ax, line.ay, 0] as P3, kind: 'a' as const },
        { at: [line.bx, line.by, 0] as P3, kind: 'b' as const },
      ];
  return [
    new PathLayer({ ...lineProps, id: `${id}-line-halo`, getColor: HALO, getWidth: draft ? 3 : 4.5 }),
    new PathLayer({ ...lineProps, id: `${id}-line`, getColor: draft ? [255, 255, 255, 235] : LINE_COLOR, getWidth: draft ? 1.8 : 2.2 }),
    new ScatterplotLayer({
      ...common,
      id: `${id}-ends`,
      data: ends,
      modelMatrix: m,
      getPosition: (d: (typeof ends)[number]) => d.at,
      radiusUnits: 'pixels',
      billboard: false,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getRadius: 6,
      getLineWidth: 2,
      getLineColor: LINE_COLOR,
      // 始点 A は塗りの丸、終点 B は中が抜けた輪
      getFillColor: (d: (typeof ends)[number]) => (d.kind === 'a' ? LINE_COLOR : ([0, 0, 0, 120] as RGBA)),
    }),
  ];
}

/**
 * 段の高さ z に立てる、そのレイヤーのトラック。h は立てられる高さ（m）。h が 0 なら何も立てない。
 * 系列（標高、人口密度）は、色が値に応じて変わる帯と、その上の縁。縁のうち、縦軸の上端を超えた区間は白。
 * 交差（道路、鉄道）は、線の上に立つ柱。線から離れた地物（駅、学校、病院）は、その地物の地点に立つ柱と、線の上の同じ距離の地点から地物までを平面上で結ぶ線。
 */
export function sectionStandLayers(id: LayerId, line: SectionLine, tracks: readonly SectionTrack[], z: number, h: number): Layer[] {
  if (!(h > 0)) return [];
  const m = tierMatrix(z);
  const layers: Layer[] = [];
  const prefix = `section-${id}`;

  for (const t of tracks) {
    if (t.kind !== 'series') continue;
    const quads = bandQuads(t).filter((q) => q.t0 > 0 || q.t1 > 0);
    layers.push(
      new SolidPolygonLayer({
        ...common,
        id: `${prefix}-wall`,
        data: quads,
        modelMatrix: m,
        _full3d: true,
        getPolygon: (q: (typeof quads)[number]) => wallPolygon(line, q, h),
        getFillColor: (q: (typeof quads)[number]) => [q.color[0], q.color[1], q.color[2], WALL_ALPHA] as RGBA,
        extruded: false,
      }),
    );
    const runs = edgeRuns(t);
    const edges = runs.map((r) => ({ path: edgePath(line, r, h), color: [255, 255, 255, 235] as RGBA, run: r }));
    layers.push(
      new PathLayer({
        ...common,
        id: `${prefix}-edge`,
        data: edges,
        modelMatrix: m,
        getPath: (d: (typeof edges)[number]) => d.path,
        getColor: (d: (typeof edges)[number]) => d.color,
        getWidth: 1.5,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: true,
      }),
    );
    // 縦軸の上端を超えて切り詰めた区間は、上端に白い太い線を引き、頭打ちだと分かるようにする。
    const caps = runs.flatMap((r) => {
      const out: { path: P3[] }[] = [];
      let cur: P3[] | null = null;
      for (const p of r.points) {
        if (p.capped) {
          const { x, y } = pointAt(line, p.d);
          (cur ??= []).push([x, y, h]);
        } else if (cur) {
          out.push({ path: cur });
          cur = null;
        }
      }
      if (cur) out.push({ path: cur });
      return out.filter((c) => c.path.length >= 2);
    });
    if (caps.length > 0)
      layers.push(
        new PathLayer({
          ...common,
          id: `${prefix}-cap`,
          data: caps,
          modelMatrix: m,
          getPath: (d: (typeof caps)[number]) => d.path,
          getColor: CAP_COLOR,
          getWidth: 3.5,
          widthUnits: 'pixels',
          billboard: true,
        }),
      );
  }

  const posts = postsOf(line, tracks);
  if (posts.length > 0) {
    const hp = h * POST_RATIO;
    const near = posts.filter((p) => p.near);
    layers.push(
      new PathLayer({
        ...common,
        id: `${prefix}-posts`,
        data: posts,
        modelMatrix: m,
        getPath: (p: (typeof posts)[number]) => [[p.at.x, p.at.y, 0], [p.at.x, p.at.y, hp]] as P3[],
        getColor: (p: (typeof posts)[number]) => [...p.mark.color, 225] as RGBA,
        getWidth: 2.5,
        widthUnits: 'pixels',
        billboard: true,
      }),
    );
    if (near.length > 0)
      layers.push(
        new PathLayer({
          ...common,
          id: `${prefix}-links`,
          data: near,
          modelMatrix: m,
          getPath: (p: (typeof near)[number]) => [[p.foot.x, p.foot.y, 0], [p.at.x, p.at.y, 0]] as P3[],
          getColor: (p: (typeof near)[number]) => [...p.mark.color, 190] as RGBA,
          getWidth: 1.3,
          widthUnits: 'pixels',
          billboard: true,
        }),
        new ScatterplotLayer({
          ...common,
          id: `${prefix}-dots`,
          data: near,
          modelMatrix: m,
          getPosition: (p: (typeof near)[number]) => [p.at.x, p.at.y, hp] as P3,
          radiusUnits: 'pixels',
          billboard: false,
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          getRadius: 4,
          getLineWidth: 1,
          getLineColor: [0, 0, 0, 200],
          getFillColor: (p: (typeof near)[number]) => [...p.mark.color, 255] as RGBA,
        }),
      );
  }
  return layers;
}

/** 立てられる高さの全体を示す、切り口の面の薄い背景（段の高さ z、高さ h）。帯の頭打ちの位置（縦軸の上端）が読めるようにする。 */
export function sectionCurtainLayer(id: LayerId, line: SectionLine, z: number, h: number): Layer[] {
  if (!(h > 0)) return [];
  const poly = wallPolygon(line, { d0: 0, d1: Math.hypot(line.bx - line.ax, line.by - line.ay), t0: 1, t1: 1 }, h);
  return [
    new SolidPolygonLayer({
      ...common,
      id: `section-${id}-curtain`,
      data: [poly],
      modelMatrix: tierMatrix(z),
      _full3d: true,
      getPolygon: (d: P3[]) => d,
      getFillColor: CURTAIN_COLOR,
      extruded: false,
    }),
  ];
}

/** 両端を全段に貫く垂直線（細い白）と、いちばん上の段の上に出す始点 A・終点 B の札。zs は表示中の段の高さ。 */
export function sectionPoleLayers(line: SectionLine, zs: readonly number[]): Layer[] {
  if (zs.length === 0) return [];
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const poles = [
    { path: [[line.ax, line.ay, zMin], [line.ax, line.ay, zMax]] as P3[] },
    { path: [[line.bx, line.by, zMin], [line.bx, line.by, zMax]] as P3[] },
  ];
  const labels = [
    { text: 'A', at: [line.ax, line.ay, zMax] as P3 },
    { text: 'B', at: [line.bx, line.by, zMax] as P3 },
  ];
  const layers: Layer[] = [];
  if (zMax > zMin)
    layers.push(
      new PathLayer({
        ...common,
        id: 'section-poles',
        data: poles,
        getPath: (d: (typeof poles)[number]) => d.path,
        getColor: [255, 255, 255, 150],
        getWidth: 1.2,
        widthUnits: 'pixels',
        billboard: true,
        parameters: { depthCompare: 'always' },
      }),
    );
  layers.push(
    new TextLayer({
      ...common,
      id: 'section-ends-labels',
      data: labels,
      getPosition: (d: (typeof labels)[number]) => d.at,
      getText: (d: (typeof labels)[number]) => d.text,
      getSize: 13,
      sizeUnits: 'pixels',
      getColor: [10, 10, 10, 255],
      fontWeight: 700,
      fontFamily: 'sans-serif',
      characterSet: ['A', 'B'],
      fontSettings: { sdf: false, fontSize: 48 },
      background: true,
      getBackgroundColor: [255, 255, 255, 240],
      backgroundPadding: [5, 2, 5, 2],
      getPixelOffset: [0, -(RING_RADIUS_PX + 8)],
      parameters: { depthCompare: 'always' },
    }),
  );
  return layers;
}

/** 線に沿った距離 d の地点を、全段に貫く垂直線と印（探針と同じ見た目）。右のグラフのカーソルと連動する。 */
export function sectionCursorLayers(line: SectionLine, d: number, zs: readonly number[]): Layer[] {
  const p = pointAt(line, d);
  return probeMarkLayers(p, false, [...zs]);
}
