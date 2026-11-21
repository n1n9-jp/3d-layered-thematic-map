/**
 * 断面のとき、右の列のチャートを、全体の地図の対応する段と同じ画面上の高さに置く計算（純粋な計算）。
 * - 揃える（aligned）：各チャートの枠の縦の中心を、その段の平面の中心の高さに置く。枠は5つとも同じ高さ。
 * - 縦並び（stacked）：段どうしが画面上で近すぎる、段が1枚だけ、真上の視点などでは、上から順に同じ高さの枠を並べる。
 * 座標は、チャートを置く領域（region）の上端を 0 とする px。
 */
import type { LayerId } from '../config';

/** 枠の上に取る、要約（最大2行）の高さ（px）。 */
export const SUMMARY_H = 30;
/** 揃えるときに許す、枠の高さの下限（px）。これより低くなるなら縦並びにする。 */
export const MIN_FRAME_H = 46;
/** 枠の高さの上限（px）。 */
export const MAX_FRAME_H = 72;
/** 隣のチャートとの、最低限の隙間（px）。 */
export const GAP = 8;
/** 縦並びから揃えるへ戻るとき、下限にさらに要る余裕（px）。境目で行き来しないための幅。 */
export const HYSTERESIS = 8;
/** 縦並びのときの枠の高さの範囲（px）。 */
export const STACKED_FRAME_H = { min: 40, max: 64 } as const;

export type AlignMode = 'aligned' | 'stacked';

/** 表示中の段。上の段から順に（チャートもこの順に並べる）。 */
export interface Tier {
  id: LayerId;
  /** 平面の中心の、いまの画面上の高さ（アニメーション中の補間した高さ）。 */
  y: number;
  /**
   * 平面の中心の、落ち着いたあとの高さ（段の高さのアニメーションも、視点の追従も終わったあと）。
   * 揃えるか縦並びか、枠の高さは、こちらで決める（途中の揺れで切り替わらないように）。
   */
  goalY: number;
}

export interface Region {
  /** チャートを置ける範囲の上端と下端（枠と要約を含む。横軸は含まない）。 */
  top: number;
  bottom: number;
}

export interface ChartSlot {
  id: LayerId;
  /** 枠の縦の中心。 */
  center: number;
}

export interface Placement {
  mode: AlignMode;
  /** 枠（グラフの部分）の高さ。全チャート共通。 */
  frameH: number;
  /** 上の段から順。 */
  slots: ChartSlot[];
}

/**
 * 上から順に並べた値 ys を、隣と gap 以上離し、全体を [lo, hi] に収める。順番は変えない。
 * 動かす距離の二乗和が最小になる配置（隣り合って詰まるものは、まとめて中心を保つ）。
 */
export function placeInOrder(ys: readonly number[], gap: number, lo: number, hi: number): number[] {
  const n = ys.length;
  if (n === 0) return [];
  // 位置から k·gap を引くと「隣と gap 以上」が「単調に増える」になる。単調回帰（プールして平均する）で解く。
  const blocks: { sum: number; n: number }[] = [];
  ys.forEach((y, k) => {
    blocks.push({ sum: y - k * gap, n: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.n <= last.sum / last.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: prev.sum + last.sum, n: prev.n + last.n });
    }
  });
  // 範囲の制約は、単調回帰の結果を切り詰めれば最適になる（上端は先頭、下端は末尾が決める）。
  const dLo = lo;
  const dHi = hi - (n - 1) * gap;
  const out: number[] = [];
  let k = 0;
  for (const b of blocks) {
    const d = Math.min(Math.max(b.sum / b.n, dLo), Math.max(dLo, dHi));
    for (let i = 0; i < b.n; i++, k++) out.push(d + k * gap);
  }
  return out;
}

/** 縦並びの枠の高さ。n 枚が region に収まる高さ（STACKED_FRAME_H の範囲）。 */
export function stackedFrameH(n: number, regionH: number): number {
  if (n <= 0) return STACKED_FRAME_H.max;
  const fit = Math.floor((regionH - (n - 1) * GAP) / n - SUMMARY_H);
  return Math.max(STACKED_FRAME_H.min, Math.min(STACKED_FRAME_H.max, fit));
}

/** 縦並び：上から順に、同じ高さの枠を並べる。 */
export function stackedPlacement(tiers: readonly Tier[], region: Region): Placement {
  const frameH = stackedFrameH(tiers.length, region.bottom - region.top);
  const pitch = SUMMARY_H + frameH + GAP;
  return {
    mode: 'stacked',
    frameH,
    slots: tiers.map((t, i) => ({ id: t.id, center: region.top + i * pitch + SUMMARY_H + frameH / 2 })),
  };
}

/** 段どうしの、画面上の最小の間隔（目標の高さで測る。上の段から並んでいること）。1枚以下なら Infinity。 */
export function minPitch(tiers: readonly Tier[]): number {
  let p = Infinity;
  for (let i = 1; i < tiers.length; i++) p = Math.min(p, tiers[i].goalY - tiers[i - 1].goalY);
  return p;
}

/**
 * チャートの置き方を決める。
 * - 段が2枚以上あり、隣の段との間隔（目標の高さ）に、要約と隙間を除いた枠が MIN_FRAME_H 以上入るとき、揃える。
 *   縦並びから戻るときは、さらに HYSTERESIS だけ余裕を見る（prev は、前の置き方）。
 * - 枠の高さは、間隔・上限・領域の上下の余白に収まる高さ（5つとも同じ）。領域の外にはみ出す段のチャートは、領域の中へ寄せる。
 * - 領域に全チャートが収まらないときも、縦並び。
 */
export function placeCharts(opts: { tiers: readonly Tier[]; region: Region; prev: AlignMode }): Placement {
  const { tiers, region, prev } = opts;
  const n = tiers.length;
  const regionH = region.bottom - region.top;
  if (n < 2 || !(regionH > 0)) return stackedPlacement(tiers, region);

  const pitch = minPitch(tiers);
  if (!Number.isFinite(pitch)) return stackedPlacement(tiers, region);
  const fromPitch = Math.min(MAX_FRAME_H, pitch - SUMMARY_H - GAP);
  const need = prev === 'aligned' ? MIN_FRAME_H : MIN_FRAME_H + HYSTERESIS;
  if (!(fromPitch >= need)) return stackedPlacement(tiers, region);

  // 領域に全部収まる高さ。
  const fromRegion = Math.floor((regionH - (n - 1) * GAP) / n - SUMMARY_H);
  // 段が領域の端に近いとき、その段のチャートが領域から出ない高さ（ただし下限までは縮めない。それ以上は寄せて収める）。
  const first = tiers[0].goalY;
  const last = tiers[n - 1].goalY;
  const fromEdges = Math.min(2 * (first - SUMMARY_H - region.top), 2 * (region.bottom - last));
  const frameH = Math.floor(Math.max(MIN_FRAME_H, Math.min(fromPitch, fromRegion, fromEdges)));
  if (frameH > fromRegion) return stackedPlacement(tiers, region);

  const centers = placeInOrder(
    tiers.map((t) => t.y),
    SUMMARY_H + frameH + GAP,
    region.top + SUMMARY_H + frameH / 2,
    region.bottom - frameH / 2,
  );
  return { mode: 'aligned', frameH, slots: tiers.map((t, i) => ({ id: t.id, center: centers[i] })) };
}
