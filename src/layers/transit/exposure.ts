/**
 * 公共交通（駅・路線）が、浸水が想定される区域にかかるかどうかの判定と、その描き分け用の色。
 *
 * - 区域 = 浸水の深さが 0.5m 以上のセル。浸水の段（`../flood`）の深さの区分で、「0.5〜3m」以上にあたる。
 * - 想定（洪水と高潮の大きいほう・洪水・高潮）は、画面の選択に従う。「見るもの」（深さ・水が引くまで）には従わず、常に深さで判定する。
 * - 浸水の値は、浸水の段のデータ（`FloodData`）を読み取り専用で使う。座標からセルを得る処理も、浸水の段と同じもの。
 * - 判定は、データと想定の組ごとに1回だけ計算して持つ（視点の操作やマウスの移動では計算しない）。
 */
import type { FloodScenario } from '../../config';
import type { Position } from '../../types';
import { DEPTH_CLASSES, floodScheme } from '../flood/classes';
import { cellIndexAt, positionAt } from '../flood/model';
import type { FloodData } from '../flood/model';
import type { TransitData } from '../transitModel';

type Rgb = [number, number, number];

/** 「浸水が想定される区域」の下限（深さ m）。 */
export const EXPOSED_MIN_DEPTH = 0.5;

/** 浸水の深さの段の位置（1〜）のうち、下限が EXPOSED_MIN_DEPTH 以上になる最初の段。この位置以上のセルが区域。 */
const EXPOSED_POSITION = DEPTH_CLASSES.findIndex((c) => c.min >= EXPOSED_MIN_DEPTH) + 1;

/**
 * 描き分けの色。2種は、色相ではなく明るさの差（相対輝度のコントラスト比で、路線が約 4.0、駅が約 5.4）で見分けられるようにする。
 * 浸水の段の桃色（深さ 3〜10m の淡い桃〜赤）とは違う、公共交通の段の洋紅（マゼンタ）に揃える。
 */
export const TRANSIT_COLORS: {
  railExposed: Rgb;
  railOther: Rgb;
  stationExposed: Rgb;
  stationOther: Rgb;
  stationExposedOutline: Rgb;
  stationOtherOutline: Rgb;
} = {
  railExposed: [255, 96, 240],
  railOther: [84, 54, 80],
  stationExposed: [255, 242, 252],
  stationOther: [120, 92, 114],
  stationExposedOutline: [176, 0, 128],
  stationOtherOutline: [34, 22, 32],
};

/** 凡例に出す名前。 */
export const EXPOSED_LABEL = '浸水が想定される区域の駅・区間（深さ 0.5m 以上）';
export const OTHER_LABEL = 'それ以外';

/** 浸水が想定される区域かどうかの、セルごとの印（1 = 区域）。想定ごとに、格子につき1回だけ作る。 */
const masks = new WeakMap<FloodData, Map<FloodScenario, Uint8Array>>();

export function exposedMask(flood: FloodData, scenario: FloodScenario): Uint8Array {
  let byScenario = masks.get(flood);
  if (!byScenario) masks.set(flood, (byScenario = new Map()));
  let mask = byScenario.get(scenario);
  if (!mask) {
    const scheme = floodScheme(scenario, 'depth'); // 想定には従うが、見るものにかかわらず深さで判定する
    const n = flood.width * flood.height;
    mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = positionAt(flood, scheme, i);
      if (p !== null && p >= EXPOSED_POSITION) mask[i] = 1;
    }
    byScenario.set(scenario, mask);
  }
  return mask;
}

/** 地点 (x, y) が、浸水が想定される区域か。格子の外・23区の外は false。 */
export function isExposedAt(flood: FloodData, scenario: FloodScenario, x: number, y: number): boolean {
  const i = cellIndexAt(flood, x, y);
  return i !== null && exposedMask(flood, scenario)[i] === 1;
}

export interface TransitExposure {
  /** 駅ごと（`stationPoints` と同じ添字）に、区域内なら 1 */
  stationExposed: Uint8Array;
  /** 区域を通る区間・通らない区間（連続する同じ種類の区間は1本にまとめてある。境目の頂点は両方が持つ） */
  exposedPaths: Position[][];
  otherPaths: Position[][];
  /** 区域内・区域外の駅の位置 */
  exposedStations: Position[];
  otherStations: Position[];
}

/**
 * 線を、浸水の格子のセルの境目で区切り、区域のセルを通る区間とそれ以外に分ける（画面の浸水の段のセルとぴったり同じ区切り）。
 * 区間の種類は、区切った小区間の中点があるセルで決める。
 */
export function splitPath(path: readonly Position[], flood: FloodData, mask: Uint8Array, exposed: Position[][], other: Position[][]): void {
  const { minX, maxY, cellSize, width, height } = flood;
  const classAt = (x: number, y: number): 0 | 1 => {
    const col = Math.floor((x - minX) / cellSize);
    const row = Math.floor((maxY - y) / cellSize);
    return col < 0 || col >= width || row < 0 || row >= height ? 0 : (mask[row * width + col] as 0 | 1);
  };
  const cur: { run: Position[] | null; cls: 0 | 1 } = { run: null, cls: 0 };
  const close = () => {
    if (cur.run && cur.run.length >= 2) (cur.cls === 1 ? exposed : other).push(cur.run);
    cur.run = null;
  };
  for (let s = 0; s + 1 < path.length; s++) {
    const [ax, ay] = path[s];
    const [bx, by] = path[s + 1];
    const dx = bx - ax;
    const dy = by - ay;
    // 線分が格子の線と交わる位置（t は 0〜1）
    const ts: number[] = [0, 1];
    if (dx !== 0) {
      const k0 = Math.max(0, Math.ceil((Math.min(ax, bx) - minX) / cellSize));
      const k1 = Math.min(width, Math.floor((Math.max(ax, bx) - minX) / cellSize));
      for (let k = k0; k <= k1; k++) {
        const t = (minX + k * cellSize - ax) / dx;
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    if (dy !== 0) {
      const k0 = Math.max(0, Math.ceil((maxY - Math.max(ay, by)) / cellSize));
      const k1 = Math.min(height, Math.floor((maxY - Math.min(ay, by)) / cellSize));
      for (let k = k0; k <= k1; k++) {
        const t = (maxY - k * cellSize - ay) / dy;
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    // 幅のある小区間だけを残す。最後の小区間は、線分の終点まで延ばす（頂点を失わない）
    const iv: [number, number][] = [];
    for (let i = 0; i + 1 < ts.length; i++) if (ts[i + 1] - ts[i] > 1e-9) iv.push([ts[i], ts[i + 1]]);
    if (iv.length === 0) continue;
    iv[iv.length - 1][1] = 1;
    iv.forEach(([t0, t1], i) => {
      const last = i === iv.length - 1;
      const c = classAt(ax + dx * ((t0 + t1) / 2), ay + dy * ((t0 + t1) / 2));
      const p0: Position = [ax + dx * t0, ay + dy * t0];
      const p1: Position = last ? [bx, by] : [ax + dx * t1, ay + dy * t1];
      if (cur.run && c === cur.cls) {
        // 同じ種類が続く。途中のセルの境目には頂点を足さず、元の線の頂点（線分の終点）だけを残す
        if (last) cur.run.push(p1);
        return;
      }
      // 種類が変わる（または最初の区間）。前の区間は、境目（この小区間の始まり）で終わり、新しい区間はそこから始まる。
      if (cur.run) {
        // 境目が、直前に足した頂点（前の線分の終点）と同じ位置なら、足さない（長さ 0 の線分を作らない）
        const end = cur.run[cur.run.length - 1];
        if (end[0] !== p0[0] || end[1] !== p0[1]) cur.run.push(p0);
      }
      close();
      cur.run = last ? [p0, p1] : [p0];
      cur.cls = c;
    });
  }
  close();
}

type Cache = Map<FloodScenario, TransitExposure>;
const cache = new WeakMap<TransitData, WeakMap<FloodData, Cache>>();

/**
 * 公共交通のデータと想定に対する、駅と路線の判定。データ（と、それが持つ浸水の格子）と想定の組ごとに、1回だけ計算する。
 * 浸水の格子がない（読み込めなかった）データでは null。
 */
export function transitExposure(data: TransitData, scenario: FloodScenario): TransitExposure | null {
  const flood = data.flood;
  if (!flood) return null;
  let byFlood = cache.get(data);
  if (!byFlood) cache.set(data, (byFlood = new WeakMap()));
  let byScenario = byFlood.get(flood);
  if (!byScenario) byFlood.set(flood, (byScenario = new Map()));
  let out = byScenario.get(scenario);
  if (!out) {
    const mask = exposedMask(flood, scenario);
    const exposedPaths: Position[][] = [];
    const otherPaths: Position[][] = [];
    for (const path of data.railPaths) splitPath(path, flood, mask, exposedPaths, otherPaths);
    const stationExposed = new Uint8Array(data.stationPoints.length);
    const exposedStations: Position[] = [];
    const otherStations: Position[] = [];
    data.stationPoints.forEach((p, i) => {
      if (isExposedAt(flood, scenario, p[0], p[1])) {
        stationExposed[i] = 1;
        exposedStations.push(p);
      } else otherStations.push(p);
    });
    out = { stationExposed, exposedPaths, otherPaths, exposedStations, otherStations };
    byScenario.set(scenario, out);
  }
  return out;
}
