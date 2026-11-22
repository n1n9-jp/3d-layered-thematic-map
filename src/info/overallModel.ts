/**
 * 何も選んでいないときの、23区全体の集計の「大きく見せる数字」と文言を決める計算。純粋関数（React・deck.gl に依存しない）。
 * 集計そのものは `src/aggregate/exposure.ts`、区ごとの分類は `src/aggregate/wardExposure.ts`。
 */
import type { Exposure } from '../aggregate/exposure';
import { approxPeople, shareLabel } from '../aggregate/wardExposure';
import type { WardGapSummary } from '../layers/shelters/model';
import { peopleText } from '../aggregate/exposure';

export interface BigNumber {
  /** 大きく見せる概数（例：「約242万人」） */
  approx: string;
  /** 正確な値（例：「2,415,153 人」）。表と、マウスを置いたときの表示に使う */
  exact: string;
}

const big = (n: number): BigNumber => ({ approx: approxPeople(n), exact: `${peopleText(n)} 人` });

export interface OverallHeadline {
  /** 深さ 3m 以上の区域に住む人と、うち65歳以上 */
  severe: { people: BigNumber; elderly: BigNumber };
  /** 浸水が想定される区域（0.5m 未満を含む）に住む人 */
  flooded: BigNumber;
  /** 標高 0m 未満の土地に住む人。標高が読めていなければ null */
  belowSea: BigNumber | null;
}

export function overallHeadline(e: Exposure): OverallHeadline {
  return {
    severe: { people: big(e.severe.people), elderly: big(e.severe.elderly) },
    flooded: big(e.flooded.people),
    belowSea: e.belowSea ? big(e.belowSea.people) : null,
  };
}

/** 「足立区 60%・江戸川区 75%」のように、区と、深さ 3m 以上の区域に住む人の割合を並べる。割合が求められていない区は名前だけ。 */
export function wardSharesText(wards: readonly WardGapSummary[]): string {
  return wards.map((w) => (w.severeShare === null ? w.name : `${w.name} ${shareLabel(w.severeShare)}`)).join('・');
}

/** 区名を「・」でつなぐ。なければ「なし」。 */
export const namesText = (names: readonly string[]): string => (names.length > 0 ? names.join('・') : 'なし');
