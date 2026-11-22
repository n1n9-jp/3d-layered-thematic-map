import { describe, expect, it } from 'vitest';
import {
  HAZARD_KEYS,
  hazardFlag,
  latestUpdate,
  parseShelterCsv,
  parseUpdateHistory,
  shelterProperties,
  sortShelters,
  summarizeWards,
  wardCodeFromCommonId,
} from './shelters.mjs';

const HEADER =
  'NO,共通ID,施設・場所名,住所,洪水,"崖崩れ、土石流及び地滑り",高潮,地震,津波,大規模な火事,内水氾濫,火山現象,指定避難所との住所同一,緯度,経度,備考';
const csv = (...lines) => `﻿${HEADER}\r\n${lines.join('\r\n')}\r\n`;

describe('hazardFlag', () => {
  it('"1" は true、空は false', () => {
    expect(hazardFlag('1')).toBe(true);
    expect(hazardFlag('')).toBe(false);
    expect(hazardFlag(' 1 ')).toBe(true);
    expect(hazardFlag(undefined)).toBe(false);
  });
  it('それ以外の値は例外', () => {
    expect(() => hazardFlag('0')).toThrow();
    expect(() => hazardFlag('あり')).toThrow();
  });
});

describe('wardCodeFromCommonId', () => {
  it('2〜6文字目が市区町村コード', () => {
    expect(wardCodeFromCommonId('E1310100005201')).toBe('13101');
    expect(wardCodeFromCommonId('E1322800001201')).toBe('13228');
  });
  it('形式が違えば null', () => {
    expect(wardCodeFromCommonId('')).toBeNull();
    expect(wardCodeFromCommonId('13101')).toBeNull();
    expect(wardCodeFromCommonId(undefined)).toBeNull();
  });
});

describe('parseShelterCsv', () => {
  const rows = parseShelterCsv(
    csv(
      '1,E1310100005201,千代田区役所,東京都千代田区九段南1-2-1,1,,1,1,,1,1,,1,35.69,139.75,',
      '2,E1310400098201,"迎賓館一帯, 赤坂",東京都新宿区,,,,1,,1,,,,35.678,139.727,"荒川が氾濫するおそれがある場合は、開設しない"',
      '3,E1311900001201,崖の上の広場,東京都板橋区,,1,,,,,,,,,,',
    ),
  );

  it('BOM と、引用符つきの列名（読点を含む）を読み、1行1件にする', () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      commonId: 'E1310100005201',
      codeInId: '13101',
      name: '千代田区役所',
      address: '東京都千代田区九段南1-2-1',
      lat: 35.69,
      lon: 139.75,
      note: null,
    });
  });

  it('災害種別の印を、列名どおりの項目に割り当てる', () => {
    expect(rows[0]).toMatchObject({ flood: true, landslide: false, tide: true, quake: true, tsunami: false, fire: true, inland: true });
    expect(rows[2]).toMatchObject({ flood: false, landslide: true, tide: false, quake: false });
  });

  it('名称の中のカンマ（引用符つき）と、備考を読む', () => {
    expect(rows[1].name).toBe('迎賓館一帯, 赤坂');
    expect(rows[1].note).toBe('荒川が氾濫するおそれがある場合は、開設しない');
  });

  it('座標が空なら null', () => {
    expect(rows[2].lat).toBeNull();
    expect(rows[2].lon).toBeNull();
  });

  it('必要な列がなければ例外', () => {
    expect(() => parseShelterCsv('NO,共通ID\n1,E1\n')).toThrow('列がありません');
  });
});

describe('sortShelters / shelterProperties', () => {
  const mk = (id, flood, tide) => ({ id, flood, tide });
  const list = [mk('a', false, false), mk('b', true, false), mk('c', false, false), mk('d', false, true)];

  it('洪水か高潮で使える場所を先に、それぞれの中は元の並びのまま。元の配列は変えない', () => {
    expect(sortShelters(list).map((s) => s.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(list.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('properties は仕様の項目だけを、決めた順で持つ', () => {
    const p = shelterProperties(
      { name: 'X', address: 'Y', note: null, commonId: 'E1', lat: 1, lon: 2, flood: true, tide: false, inland: false, quake: true, fire: false, tsunami: false, landslide: false },
      '千代田区',
    );
    expect(Object.keys(p)).toEqual(['name', 'address', 'ward', ...HAZARD_KEYS, 'note']);
    expect(p).toMatchObject({ name: 'X', address: 'Y', ward: '千代田区', flood: true, quake: true, note: null });
  });
});

describe('parseUpdateHistory / latestUpdate', () => {
  const history = parseUpdateHistory(
    ['13101,東京都千代田区,2023-01-01,2025-03-10,,', '13107,東京都墨田区,2023-01-01,2025-01-23,12,指定避難所データのみ公開', '', 'x,不正な行,,,,'].join('\n'),
  );
  it('コードごとの更新日と備考を読む（見出しなし。コードが数字5桁でない行は読み飛ばす）', () => {
    expect([...history.keys()]).toEqual(['13101', '13107']);
    expect(history.get('13101')).toMatchObject({ name: '東京都千代田区', published: '2023-01-01', updated: '2025-03-10' });
    expect(history.get('13107').note).toBe('指定避難所データのみ公開');
  });
  it('最も新しい更新日を返す。日付がなければ null', () => {
    expect(latestUpdate([{ updated: '2025-03-10' }, { updated: '2026-01-02' }, {}])).toBe('2026-01-02');
    expect(latestUpdate([{}])).toBeNull();
  });
});

describe('summarizeWards', () => {
  const wards = [
    { code: '13102', name: 'B区' },
    { code: '13101', name: 'A区' },
    { code: '13103', name: 'C区（未公開）' },
  ];
  const shelters = [
    { ward: 'A区', flood: true, tide: true },
    { ward: 'A区', flood: true, tide: false },
    { ward: 'A区', flood: false, tide: false },
    { ward: 'B区', flood: false, tide: true },
    { ward: null, flood: true, tide: true }, // 区の外は、どの区にも数えない
  ];
  const history = new Map([['13101', { updated: '2025-03-10' }]]);
  const out = summarizeWards(wards, shelters, history);

  it('全区を、コードの昇順で返す', () => {
    expect(out.map((w) => w.code)).toEqual(['13101', '13102', '13103']);
  });
  it('区ごとの総数・洪水・高潮を数える', () => {
    expect(out[0]).toMatchObject({ name: 'A区', total: 3, flood: 2, tide: 1 });
    expect(out[1]).toMatchObject({ name: 'B区', total: 1, flood: 0, tide: 1 });
  });
  it('0件の区は published: false、1件以上は true', () => {
    expect(out[2]).toMatchObject({ total: 0, flood: 0, tide: 0, published: false });
    expect(out[0].published).toBe(true);
  });
  it('更新日があれば区ごとに入れ、なければ項目を作らない', () => {
    expect(out[0].updated).toBe('2025-03-10');
    expect('updated' in out[1]).toBe(false);
  });
});
