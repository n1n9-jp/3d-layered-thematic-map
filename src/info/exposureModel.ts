/**
 * 「浸水が想定される区域に住む人」の表の、中身の計算（文字列と行）。純粋関数。
 * 集計そのものは `src/aggregate/exposure.ts`。
 */
import { SCENARIO_LABEL, floodScheme } from '../layers/flood/classes';
import type { Exposure } from '../aggregate/exposure';
import { peopleText } from '../aggregate/exposure';
import { SEVERE_DEPTH_POSITION } from '../layers/flood/classes';
import type { RGB } from '../layers/flood/classes';

export interface ExposureRow {
  key: string;
  label: string;
  color: RGB;
  /** 人口（人）の表示 */
  people: string;
  /** 65歳以上人口（人）の表示 */
  elderly: string;
  /** 人口の割合の表示（集計の対象の人口に対する割合） */
  share: string;
  /** その区分の人口（強調の判定などに使う） */
  peopleValue: number;
}

export interface ExposureTable {
  /** 想定の名前（例：「洪水と高潮の大きいほう」） */
  scenario: string;
  /** 深い区分から、浸水なしまで */
  rows: ExposureRow[];
  /** 見出しの一言：浸水が想定される区域、3m 以上の区域の人口 */
  headline: { flooded: string; severe: string };
  /** 標高 0m 未満の土地の人口と65歳以上人口の表示。標高が読めていなければ null */
  belowSea: { people: string; elderly: string } | null;
  /** 画面に小さく添える注記（数え方、65歳以上が不明のメッシュ、数えなかったメッシュ） */
  notes: string[];
  total: { people: string; elderly: string };
}

/** 割合の表示（小数1桁）。 */
export function shareText(part: number, whole: number): string {
  if (!(whole > 0)) return '—';
  const p = (100 * part) / whole;
  if (part > 0 && p < 0.05) return '0.1% 未満';
  return `${p.toFixed(1)}%`;
}

export function exposureTable(e: Exposure): ExposureTable {
  const scheme = floodScheme(e.scenario, 'depth');
  const whole = e.total.people;
  const rows: ExposureRow[] = [...e.classes]
    .sort((a, b) => (a.position === 0 ? 1 : b.position === 0 ? -1 : b.position - a.position))
    .filter((c) => c.position === 0 || c.position < scheme.classes.length + 1)
    .map((c) => ({
      key: String(c.position),
      label: c.label,
      color: c.position === 0 ? scheme.none.color : scheme.classes[c.position - 1].color,
      people: peopleText(c.people),
      elderly: peopleText(c.elderly),
      share: shareText(c.people, whole),
      peopleValue: c.people,
    }));
  const notes = [
    '数え方：人口の250mメッシュの中心を含む浸水想定のセル（50m）の深さで、メッシュの人口を丸ごと数えます。面積での按分はしていません。',
  ];
  if (e.elderlyUnknown.meshes > 0)
    notes.push(
      `65歳以上が不明（秘匿）の ${e.elderlyUnknown.meshes.toLocaleString('ja-JP')} メッシュ（総人口 ${peopleText(e.elderlyUnknown.people)} 人）は、65歳以上の合計に入っていません。`,
    );
  if (e.outside.meshes > 0)
    notes.push(`中心が23区の外にある ${e.outside.meshes.toLocaleString('ja-JP')} メッシュ（${peopleText(e.outside.people)} 人）は、数えていません。`);
  return {
    scenario: SCENARIO_LABEL[e.scenario],
    rows,
    headline: {
      flooded: `${peopleText(e.flooded.people)} 人（うち65歳以上 ${peopleText(e.flooded.elderly)} 人）`,
      severe: `${peopleText(e.severe.people)} 人（うち65歳以上 ${peopleText(e.severe.elderly)} 人）`,
    },
    belowSea: e.belowSea ? { people: peopleText(e.belowSea.people), elderly: peopleText(e.belowSea.elderly) } : null,
    notes,
    total: { people: peopleText(e.total.people), elderly: peopleText(e.total.elderly) },
  };
}

export { SEVERE_DEPTH_POSITION };
