import { SolidPolygonLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { memoLoad } from '../lib/memoLoad';
import { fetchJson } from '../lib/fetch';
import { pointInCircle } from '../lib/circleClip';
import type { Circle } from '../lib/circleClip';
import { createBoxIndex, isUsableLine, lineInsideCircle, lineInsideRing, lineLength, lineTouchesBox } from '../lib/section';
import type { BoxIndex } from '../lib/section';
import { createPolygonIndex } from '../lib/spatialIndex';
import type { PolygonIndex } from '../lib/spatialIndex';
import { asModelMatrix } from '../stack';
import type { LayerOptions, PopulationView } from '../config';
import type { LayerModule, Position, PopulationCollection, ProbeValue, SectionLine, SectionSeries } from '../types';
import { densityColor, densityLegend, elderlyColor, elderlyLegend } from './population/classes';

/** 描画用に整形したメッシュ1個。 */
interface Cell {
  polygon: Position[];
  color: [number, number, number, number];
  population: number;
  density: number;
  /** 65歳以上人口。秘匿されたメッシュは null */
  elderly: number | null;
  /** 周辺の秘匿メッシュの分を含むか */
  elderlyMerged: boolean;
  /** 65歳以上の人口密度（人/km²）。elderly が null なら null */
  elderlyDensity: number | null;
  /** 65歳以上の人口密度の色 */
  elderlyColor: [number, number, number, number];
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
const getElderlyColor = (d: Cell) => d.elderlyColor;

export function buildPopulationData(fc: PopulationCollection): PopulationData {
  const features = fc.features.filter((f) => f.geometry?.type === 'Polygon');
  const cells: Cell[] = features.map((f) => {
    const { population, density, elderly, elderlyMerged } = f.properties;
    const [r, g, b] = densityColor(density);
    const polygon = f.geometry.coordinates[0];
    const area = ringArea(polygon);
    const elderlyDensity = typeof elderly === 'number' && area > 0 ? elderly / (area / 1e6) : null;
    const [er, eg, eb] = elderlyColor(elderlyDensity);
    return {
      polygon,
      color: [r, g, b, 255],
      population,
      density,
      elderly: typeof elderly === 'number' ? elderly : null,
      elderlyMerged: elderlyMerged === true,
      elderlyDensity,
      elderlyColor: [er, eg, eb, 255],
      center: ringCenter(polygon),
      area,
    };
  });
  const index = createPolygonIndex(features.map((f) => f.geometry.coordinates));
  return { cells, index };
}

/** 断面の縦軸の範囲の目安（人/km²）。配色は 30,000 以上が最上段なので、その上に少し余白を取る。 */
export const POPULATION_SECTION_DOMAIN: [number, number] = [0, 40000];
/** 65歳以上の断面の縦軸の範囲（人/km²）。配色の最上段は 6,500 以上で、実データの 99% 点が約 9,800。 */
export const ELDERLY_SECTION_DOMAIN: [number, number] = [0, 12000];
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
export function sectionPopulation(data: PopulationData, line: SectionLine, view: PopulationView = 'total'): SectionSeries {
  const elderly = view === 'elderly';
  const series: SectionSeries = {
    kind: 'series',
    label: elderly ? '65歳以上の人口密度' : '人口密度',
    unit: '人/km²',
    points: [],
    domain: elderly ? ELDERLY_SECTION_DOMAIN : POPULATION_SECTION_DOMAIN,
    color: elderly ? elderlyColor : densityColor,
  };
  const idx = populationSectionIndex(data);
  if (!isUsableLine(line) || !idx.bounds || !lineTouchesBox(line, idx.bounds)) return series;
  const len = lineLength(line);
  // 値を出してよい区間（subset の結果では、切り出した円の中）
  const [lo, hi] = data.clip ? (lineInsideCircle(line, data.clip.cx, data.clip.cy, data.clip.r) ?? [0, 0]) : [0, len];

  const spans: { a: number; b: number; v: number | null }[] = [];
  idx.near(line, 0, (i) => {
    const c = data.cells[i];
    const raw = elderly ? c.elderlyDensity : c.density;
    const v = raw !== null && Number.isFinite(raw) ? raw : null; // 65歳以上が不明（秘匿）のメッシュは、値なし
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

const noPopulation = (): ProbeValue[] => [
  { label: '人口', value: null },
  { label: '65歳以上', value: null },
];

/** 65歳以上の表示。秘匿されたメッシュは「不明」、合算先のメッシュは、周辺の秘匿分を含むことを添える。 */
export function elderlyProbe(c: Pick<Cell, 'elderly' | 'elderlyMerged'>): ProbeValue {
  if (c.elderly === null) return { label: '65歳以上', value: '不明（秘匿）' };
  if (c.elderlyMerged) return { label: '65歳以上', value: `${c.elderly.toLocaleString('ja-JP')} 人（周辺の秘匿分を含む）` };
  return { label: '65歳以上', value: c.elderly, unit: '人' };
}

const population: LayerModule<PopulationData> = {
  id: 'population',
  label: '人口',
  load: memoLoad(async (base) => {
    const data = buildPopulationData(await fetchJson<PopulationCollection>(`${base}population.geojson`));
    populationSectionIndex(data); // 断面の索引は、利用者の操作の前に作っておく
    return data;
  }),
  render: (data, ctx) => [
    new SolidPolygonLayer<Cell>({
      id: 'population-fill',
      data: data.cells,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      modelMatrix: asModelMatrix(ctx.modelMatrix),
      getPolygon,
      getFillColor: ctx.options.populationView === 'elderly' ? getElderlyColor : getFillColor,
      updateTriggers: { getFillColor: ctx.options.populationView },
      opacity: ctx.opacity,
      filled: true,
      extruded: false,
      pickable: false,
    }),
  ],
  section: (data, line, options) => [sectionPopulation(data, line, options.populationView)],
  subset(data, cx, cy, radius) {
    const cells = data.cells.filter((c) => pointInCircle(c.center[0], c.center[1], cx, cy, radius));
    return { ...makeData(cells), clip: { cx, cy, r: radius } };
  },
  summarize(data) {
    let total = 0;
    let area = 0;
    let elderly = 0;
    let unknownCells = 0;
    let unknownPeople = 0;
    for (const c of data.cells) {
      if (Number.isFinite(c.population)) total += c.population;
      area += c.area;
      if (c.elderly === null) {
        unknownCells++;
        if (Number.isFinite(c.population)) unknownPeople += c.population;
      } else elderly += c.elderly;
    }
    const out: ProbeValue[] = [
      { label: '人口', value: total, unit: '人' },
      { label: '65歳以上', value: elderly, unit: '人' },
    ];
    if (unknownCells > 0) out.push({ label: '65歳以上が不明', value: `${unknownCells} メッシュ（総人口 ${unknownPeople.toLocaleString('ja-JP')} 人）` });
    out.push(
      area > 0
        ? { label: '人口密度', value: Math.round(total / (area / 1e6)), unit: '人/km²' }
        : { label: '人口密度', value: null },
    );
    return out;
  },
  sample(data, x, y) {
    if (data.clip && !pointInCircle(x, y, data.clip.cx, data.clip.cy, data.clip.r)) return noPopulation();
    const [i] = data.index.containing(x, y);
    if (i === undefined) return noPopulation();
    const c = data.cells[i];
    return [
      { label: '人口', value: c.population, unit: '人' },
      elderlyProbe(c),
      { label: '人口密度', value: c.density, unit: '人/km²' },
    ];
  },
  legend: (options: LayerOptions) => (options.populationView === 'elderly' ? elderlyLegend() : densityLegend()),
  controls: [
    {
      key: 'populationView',
      label: '見るもの',
      choices: [
        { value: 'total', label: '総人口' },
        { value: 'elderly', label: '65歳以上', title: '65歳以上人口 ÷ メッシュの面積（人口密度）で塗る' },
      ],
    },
  ],
  notes: () => ['250m メッシュ（令和2年国勢調査）。65歳以上は、秘匿されたメッシュ（灰色）を含みません。'],
};

export default population;
