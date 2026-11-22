// 避難場所レイヤー（国土地理院「指定緊急避難場所データ」）の純粋な処理。
// 入出力は scripts/build-shelters.mjs が担当する。
import { parseCsv, parseCsvTable } from './csv.mjs';

/** 災害種別の列名（CSV の列名）→ properties の項目名。この順が properties の並び。 */
export const HAZARD_COLUMNS = [
  ['洪水', 'flood'],
  ['高潮', 'tide'],
  ['内水氾濫', 'inland'],
  ['地震', 'quake'],
  ['大規模な火事', 'fire'],
  ['津波', 'tsunami'],
  ['崖崩れ、土石流及び地滑り', 'landslide'],
];
export const HAZARD_KEYS = HAZARD_COLUMNS.map(([, key]) => key);

const REQUIRED_COLUMNS = ['共通ID', '施設・場所名', '住所', '緯度', '経度', '備考', ...HAZARD_COLUMNS.map(([name]) => name)];

/** 災害種別の印（`"1"` か空）を真偽値にする。それ以外の値は例外（意味を取り違えないため）。 */
export function hazardFlag(value) {
  const v = String(value ?? '').trim();
  if (v === '1') return true;
  if (v === '') return false;
  throw new Error(`災害種別の印が "1" でも空でもありません: ${JSON.stringify(value)}`);
}

/** 共通ID（例 E1310100005201）の2〜6文字目＝市区町村コード。形式が違えば null。 */
export function wardCodeFromCommonId(commonId) {
  const m = /^[A-Za-z](\d{5})\d+$/.exec(String(commonId ?? '').trim());
  return m ? m[1] : null;
}

const toNumberOrNull = (text) => {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * 指定緊急避難場所の CSV（UTF-8、BOM 付きでもよい）を読んで、1行1件の配列にする。
 * @returns {Array<{ commonId: string, codeInId: string|null, name: string, address: string, lat: number|null, lon: number|null,
 *   note: string|null, flood: boolean, tide: boolean, inland: boolean, quake: boolean, fire: boolean, tsunami: boolean, landslide: boolean }>}
 */
export function parseShelterCsv(text) {
  return parseCsvTable(text, REQUIRED_COLUMNS).map((row) => {
    const note = row['備考'].trim();
    const hazards = Object.fromEntries(HAZARD_COLUMNS.map(([column, key]) => [key, hazardFlag(row[column])]));
    return {
      commonId: row['共通ID'].trim(),
      codeInId: wardCodeFromCommonId(row['共通ID']),
      name: row['施設・場所名'].trim(),
      address: row['住所'].trim(),
      lat: toNumberOrNull(row['緯度']),
      lon: toNumberOrNull(row['経度']),
      note: note === '' ? null : note,
      ...hazards,
    };
  });
}

/** 洪水か高潮で使える避難場所か。 */
export const usableForFloodOrTide = (s) => s.flood || s.tide;

/**
 * 並べ替え：洪水か高潮で使える場所を先に。それぞれの中は、元の並びを保つ。
 * 元の配列は変えない。
 */
export function sortShelters(shelters) {
  return [...shelters.filter(usableForFloodOrTide), ...shelters.filter((s) => !usableForFloodOrTide(s))];
}

/** 避難場所 → shelters.geojson の properties。ward は座標から求めた区名。 */
export function shelterProperties(shelter, wardName) {
  const { name, address, note } = shelter;
  const hazards = Object.fromEntries(HAZARD_KEYS.map((k) => [k, shelter[k]]));
  return { name, address, ward: wardName, ...hazards, note };
}

/**
 * 区ごとの更新日の一覧（publicHistoryListData.csv。見出し行なし。
 * 列は 市区町村コード, 名称, 公開日, 最終更新日, 公開区分, 備考）を、コード → { name, published, updated, note } にする。
 */
export function parseUpdateHistory(text) {
  const map = new Map();
  for (const cells of parseCsv(text)) {
    const [code, name, published, updated, , note] = cells.map((s) => s.trim());
    if (!/^\d{5}$/.test(code)) continue;
    map.set(code, { name, published, updated, note: note ?? '' });
  }
  return map;
}

/**
 * 区ごとの集計（shelters.json の wards）。
 * @param {Array<{code: string, name: string}>} wards 区の一覧（順序は問わない。コードの昇順で返す）
 * @param {Array<{ward: string|null, flood: boolean, tide: boolean}>} shelters ward は区名（区の外なら null）
 * @param {Map<string, {updated: string}>} [history] 区ごとの更新日（parseUpdateHistory の戻り値）
 * @returns {Array<{code: string, name: string, total: number, flood: number, tide: number, published: boolean, updated?: string}>}
 */
export function summarizeWards(wards, shelters, history = new Map()) {
  const byName = new Map();
  for (const s of shelters) {
    if (s.ward == null) continue;
    const acc = byName.get(s.ward) ?? { total: 0, flood: 0, tide: 0 };
    acc.total++;
    if (s.flood) acc.flood++;
    if (s.tide) acc.tide++;
    byName.set(s.ward, acc);
  }
  return [...wards]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map(({ code, name }) => {
      const { total, flood, tide } = byName.get(name) ?? { total: 0, flood: 0, tide: 0 };
      const out = { code, name, total, flood, tide, published: total > 0 };
      const updated = history.get(code)?.updated;
      if (updated) out.updated = updated;
      return out;
    });
}

/** 区ごとの更新日のうち最も新しいもの（ISO 形式の日付の文字列。1つもなければ null）。 */
export function latestUpdate(wardSummaries) {
  const dates = wardSummaries.map((w) => w.updated).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length === 0 ? null : dates.reduce((a, b) => (a > b ? a : b));
}
