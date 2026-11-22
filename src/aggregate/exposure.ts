/**
 * レイヤーをまたぐ集計：「浸水が想定される区域に住む人」。純粋な計算（deck.gl・React に依存しない）。
 *
 * 数え方：人口の250mメッシュごとに、メッシュの中心を含む浸水想定の格子のセル（50 m）のランクを引き、
 * 区分（浸水の深さ）ごとに、メッシュの人口と65歳以上人口を合計する。メッシュの面積を浸水域で按分することはしない
 * （メッシュの中心がどの区分に入るかで、メッシュ全体を数える）。想定（洪水と高潮の大きいほう・洪水・高潮）に従う。
 * 65歳以上が不明（秘匿）のメッシュは、65歳以上の合計に入れない（総人口には入る）。その数は、別に持つ。
 * 標高 0m 未満の土地の人口は、メッシュの中心を含む標高のセルが 0m 未満のメッシュの人口。標高のないセル（水面）は数えない。
 */
import { gridCell } from '../lib/grid';
import type { FloodScenario } from '../config';
import { floodScheme, labelOf, SEVERE_DEPTH_POSITION } from '../layers/flood/classes';
import { positionAt } from '../layers/flood/model';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
import type { ElevationData } from '../types';

export interface ExposureClass {
  /** 浸水の深さの段の位置（0 = 浸水なし、1〜6） */
  position: number;
  label: string;
  /** メッシュの人口の合計（人） */
  people: number;
  /** 65歳以上人口の合計（人。65歳以上が不明のメッシュは含まない） */
  elderly: number;
}

export interface Exposure {
  scenario: FloodScenario;
  /** 深さの区分ごと。0（浸水なし）から最も深い段まで、すべて並ぶ */
  classes: ExposureClass[];
  /** 浸水想定の格子の内側（23区内）に中心があるメッシュの、人口・65歳以上人口の合計 */
  total: { people: number; elderly: number };
  /** 浸水が想定される（深さが 0.5m 未満を含む、ランク 1 以上）区域の人口・65歳以上人口 */
  flooded: { people: number; elderly: number };
  /** 浸水の深さが 3m 以上（ランク 3 以上）の区域の人口・65歳以上人口 */
  severe: { people: number; elderly: number };
  /** 標高 0m 未満の土地（メッシュの中心を含む標高のセルが 0m 未満）の人口・65歳以上人口。標高を渡さなければ null */
  belowSea: { people: number; elderly: number } | null;
  /** 65歳以上が不明（秘匿）のメッシュの数と、その総人口 */
  elderlyUnknown: { meshes: number; people: number };
  /** 中心が23区の外（浸水想定の格子の外か、23区の外）で、数えなかったメッシュの数と総人口 */
  outside: { meshes: number; people: number };
}

type Cells = Pick<PopulationData, 'cells'>;

/**
 * 人口のメッシュと浸水想定から、深さの区分ごとの人口と65歳以上人口を数える。
 * pop は、全体でも、円で切り出した結果（`subset`）でもよい。flood は、切り出さない全体を渡す。
 */
export function computeExposure(pop: Cells, flood: FloodData, scenario: FloodScenario, elevation?: ElevationData | null): Exposure {
  const scheme = floodScheme(scenario, 'depth');
  const n = scheme.classes.length;
  const people = new Array<number>(n + 1).fill(0);
  const elderly = new Array<number>(n + 1).fill(0);
  const out: Exposure = {
    scenario,
    classes: [],
    total: { people: 0, elderly: 0 },
    flooded: { people: 0, elderly: 0 },
    severe: { people: 0, elderly: 0 },
    belowSea: elevation ? { people: 0, elderly: 0 } : null,
    elderlyUnknown: { meshes: 0, people: 0 },
    outside: { meshes: 0, people: 0 },
  };
  for (const c of pop.cells) {
    const pp = Number.isFinite(c.population) ? c.population : 0;
    const [x, y] = c.center;
    const cell = gridCell(flood, x, y);
    const p = cell ? positionAt(flood, scheme, cell.row * flood.width + cell.col) : null;
    if (p === null) {
      out.outside.meshes++;
      out.outside.people += pp;
      continue;
    }
    const e = c.elderly === null ? 0 : c.elderly;
    if (c.elderly === null) {
      out.elderlyUnknown.meshes++;
      out.elderlyUnknown.people += pp;
    }
    people[p] += pp;
    elderly[p] += e;
    out.total.people += pp;
    out.total.elderly += e;
    if (p >= 1) {
      out.flooded.people += pp;
      out.flooded.elderly += e;
    }
    if (p >= SEVERE_DEPTH_POSITION) {
      out.severe.people += pp;
      out.severe.elderly += e;
    }
    if (elevation && out.belowSea) {
      const ec = gridCell(elevation, x, y);
      const z = ec ? elevation.values[ec.row * elevation.width + ec.col] : NaN;
      if (z < 0) {
        out.belowSea.people += pp;
        out.belowSea.elderly += e;
      }
    }
  }
  out.classes = people.map((pe, position) => ({ position, label: labelOf(scheme, position), people: pe, elderly: elderly[position] }));
  return out;
}

const cache = new WeakMap<object, Map<string, Exposure>>();

/** 23区全体の集計。データごと・想定ごとに1回だけ数える。 */
export function wholeExposure(pop: PopulationData, flood: FloodData, scenario: FloodScenario, elevation: ElevationData | null): Exposure {
  let byScenario = cache.get(pop);
  if (!byScenario) cache.set(pop, (byScenario = new Map()));
  const key = scenario;
  let e = byScenario.get(key);
  if (!e) {
    e = computeExposure(pop, flood, scenario, elevation);
    byScenario.set(key, e);
  }
  return e;
}

/** 人数の表示（桁区切り）。 */
export const peopleText = (n: number): string => Math.round(n).toLocaleString('ja-JP');
