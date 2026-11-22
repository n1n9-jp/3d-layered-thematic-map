/**
 * 何も選んでいないときの、23区全体の集計の「大きく見せる数字」を決める計算。純粋関数（React・deck.gl に依存しない）。
 * 集計そのものは `src/aggregate/exposure.ts`。
 */
import type { Exposure } from '../aggregate/exposure';
import { approxPeople, peopleText } from '../aggregate/exposure';

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
}

export function overallHeadline(e: Exposure): OverallHeadline {
  return { severe: { people: big(e.severe.people), elderly: big(e.severe.elderly) } };
}
