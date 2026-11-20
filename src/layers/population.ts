import { SolidPolygonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { fetchJson } from '../lib/fetch';
import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createBoxIndex, isUsableLine, lineInsideCircle, lineInsideRing, lineLength, lineTouchesBox } from '../lib/section';
import type { BoxIndex } from '../lib/section';
import { createPolygonIndex } from '../lib/spatialIndex';
import type { PolygonIndex } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { LayerModule, Position, PopulationCollection, ProbeValue, SectionLine, SectionSeries } from '../types';
import { densityColor, densityLegend } from './population/classes';

/** 描画用に整形したメッシュ1個。 */
interface Cell {
  polygon: Position[];
  color: [number, number, number, number];
  population: number;
  density: number;
  /** 4隅の平均（subset の「セルの中心」） */
  center: Position;
  /** メッシュの面積（m²）。人口密度の集計に使う */
  area: number;
}

export interface PopulationData {
  /** 描画に渡す配列。作り直さず同じ参照を使い続ける */
  cells: Cell[];
  /** sample 用：cells と同じ添字の多角形索引 */
  index: PolygonIndex;
  /** subset の結果のとき、切り出した円。この円の外の地点は sample が値なしにする */
  clip?: Circle;
}

/** リング（始点に戻る閉じた輪郭でも、戻らなくても）の頂点の平均。 */
function ringCenter(ring: Position[]): Position {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const n = closed ? ring.length - 1 : ring.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return n > 0 ? [sx / n, sy / n] : [NaN, NaN];
}

/** リングの面積（m²、靴ひも公式）。 */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

function makeData(cells: Cell[]): PopulationData {
  return { cells, index: createPolygonIndex(cells.map((c) => [c.polygon])) };
}

// アクセサは固定の参照にして、render のたびに属性が再計算されないようにする。
const getPolygon = (d: Cell) => d.polygon;
const getFillColor = (d: Cell) => d.color;

export function buildPopulationData(fc: PopulationCollection): PopulationData {
  const features = fc.features.filter((f) => f.geometry?.type === 'Polygon');
  const cells: Cell[] = features.map((f) => {
    const { population, density } = f.properties;
    const [r, g, b] = densityColor(density);
    const polygon = f.geometry.coordinates[0];
    return {
      polygon,
      color: [r, g, b, 255],
      population,
      density,
      center: ringCenter(polygon),
      area: ringArea(polygon),
    };
  });
  const index = createPolygonIndex(features.map((f) => f.geometry.coordinates));
  return { cells, index };
}

/** 断面の縦軸の範囲の目安（人/km²）。配色は 30,000 以上が最上段なので、その上に少し余白を取る。 */
export const POPULATION_SECTION_DOMAIN: [number, number] = [0, 40000];
/** この距離（m）より短い隙間は、隙間とみなさない（メッシュの辺の計算誤差） */
const SECTION_GAP_EPS = 1e-6;

const sectionIndexes = new WeakMap<PopulationData, BoxIndex>();
/** 断面用の索引（メッシュの bbox の格子）。データごとに1回だけ作る。load が先に作っておく。 */
export function populationSectionIndex(data: PopulationData): BoxIndex {
  let idx = sectionIndexes.get(data);
  if (!idx) {
    const boxes = new Float64Array(data.cells.length * 4);
    data.cells.forEach((c, i) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of c.polygon) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      boxes.set([x0, y0, x1, y1], i * 4);
    });
    idx = createBoxIndex(boxes);
    sectionIndexes.set(data, idx);
  }
  return idx;
}

/**
 * 線が通るメッシュごとの人口密度（人/km²）を、階段状の系列で返す。メッシュに入る点と出る点に同じ値の点を置き、
 * メッシュがない区間は、その区間の両端に null の点を置く。点は線の始点（d = 0）から終点（d = 長さ）まで続く。
 * 線の長さが 0 のとき、線がメッシュの範囲に届かないときは、点のない系列を返す。
 * subset の結果（`clip` つき）では、円の外を null にする（`sample` と同じ）。
 */
export function sectionPopulation(data: PopulationData, line: SectionLine): SectionSeries {
  const series: SectionSeries = {
    kind: 'series',
    label: '人口密度',
    unit: '人/km²',
    points: [],
    domain: POPULATION_SECTION_DOMAIN,
    color: densityColor,
  };
  const idx = populationSectionIndex(data);
  if (!isUsableLine(line) || !idx.bounds || !lineTouchesBox(line, idx.bounds)) return series;
  const len = lineLength(line);
  // 値を出してよい区間（subset の結果では、切り出した円の中）
  const [lo, hi] = data.clip ? (lineInsideCircle(line, data.clip.cx, data.clip.cy, data.clip.r) ?? [0, 0]) : [0, len];

  const spans: { a: number; b: number; v: number | null }[] = [];
  idx.near(line, 0, (i) => {
    const c = data.cells[i];
    const v = Number.isFinite(c.density) ? c.density : null;
    for (const [d0, d1] of lineInsideRing(line, c.polygon)) {
      const a = Math.max(d0, lo);
      const b = Math.min(d1, hi);
      if (b > a) spans.push({ a, b, v });
    }
  });
  spans.sort((p, q) => p.a - q.a || p.b - q.b);

  const pts = series.points;
  let cursor = 0;
  const gapTo = (to: number) => {
    if (to - cursor > SECTION_GAP_EPS) pts.push({ d: cursor, value: null }, { d: to, value: null });
  };
  for (const span of spans) {
    if (span.b <= cursor) continue; // 重なっていて、すでに覆われている
    let a = span.a;
    if (a - cursor > SECTION_GAP_EPS) gapTo(a);
    else a = cursor;
    const last = pts[pts.length - 1];
    if (a === cursor && last && last.d === cursor && last.value === span.v && span.v !== null) {
      last.d = span.b; // 同じ値のメッシュが続くときは、1つの段にまとめる
    } else {
      pts.push({ d: a, value: span.v }, { d: span.b, value: span.v });
    }
    cursor = span.b;
  }
  gapTo(len);
  return series;
}

const noPopulation = (): ProbeValue[] => [{ label: '人口', value: null }];

const population: LayerModule<PopulationData> = {
  id: 'population',
  label: '人口',
  async load(base) {
    const data = buildPopulationData(await fetchJson<PopulationCollection>(`${base}population.geojson`));
    populationSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
  },
  render: (data, ctx) => [
    new SolidPolygonLayer<Cell>({
      id: 'population-fill',
      data: data.cells,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      getPolygon,
      getFillColor,
      opacity: ctx.opacity,
      filled: true,
      extruded: false,
      pickable: false,
    }),
  ],
  section: (data, line) => [sectionPopulation(data, line)],
  subset(data, cx, cy, radius) {
    const cells = data.cells.filter((c) => pointInCircle(c.center[0], c.center[1], cx, cy, radius));
    return { ...makeData(cells), clip: { cx, cy, r: radius } };
  },
  summarize(data) {
    let total = 0;
    let area = 0;
    for (const c of data.cells) {
      if (Number.isFinite(c.population)) total += c.population;
      area += c.area;
    }
    return [
      { label: '人口', value: total, unit: '人' },
      area > 0
        ? { label: '人口密度', value: Math.round(total / (area / 1e6)), unit: '人/km²' }
        : { label: '人口密度', value: null },
    ];
  },
  sample(data, x, y) {
    if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return noPopulation();
    const [i] = data.index.containing(x, y);
    if (i === undefined) return noPopulation();
    const { population: pop, density } = data.cells[i];
    return [
      { label: '人口', value: pop, unit: '人' },
      { label: '人口密度', value: density, unit: '人/km²' },
    ];
  },
  legend: densityLegend(),
};

export default population;
