/**
 * 断面の例の線。「断面」に切り替えて、まだ線を引いていないときに、1クリックで引ける。
 * 実データ（標高・浸水想定・避難場所）で、この地図の主題（低地の浸水、人口、避難場所の空白）がよく出る線を選んだ。
 * 座標はローカルのメートル座標（x が東、y が北。`scripts/lib/projection.mjs` の `toLocal` で、経緯度から求めた）。
 */
import type { SectionLine } from '../types';

export interface ExampleLine {
  id: string;
  /** ボタンの名前 */
  title: string;
  /** 何が見えるか（ボタンの説明） */
  note: string;
  line: SectionLine;
}

export const EXAMPLE_LINES: readonly ExampleLine[] = [
  {
    id: 'plateau-to-lowland',
    title: '台地から低地へ（新宿 → 江戸川区役所）',
    note: '東西 15 km。台地（標高 20m 以上）から、海面より低い江戸川区へ。',
    line: { ax: -4471, ay: 1066, bx: 10706, by: 2969 },
  },
  {
    id: 'arakawa',
    title: '荒川を横切る（北区 → 北千住 → 足立・葛飾）',
    note: '東西 16 km。荒川と隅田川を越えて、海面より低い土地が続く。',
    line: { ax: -4500, ay: 7740, bx: 11760, by: 7740 },
  },
  {
    id: 'north-south',
    title: '低地を南北に（足立 → 荒川 → 墨田 → 江東）',
    note: '南北 15.5 km。ずっと浸水が想定される低地を、避難場所のデータ未公開の区を通って、東京湾へ。',
    line: { ax: 4968, ay: 11100, bx: 4968, by: -4440 },
  },
];
