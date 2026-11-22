// 避難場所（public/data/shelters.geojson, shelters.json）を作る。使い方: node scripts/build-shelters.mjs
// 元データ：国土地理院「指定緊急避難場所データ」（東京都分の CSV）と、区ごとの更新日の一覧。
//   出典：「『指定緊急避難場所データ』（国土地理院）（https://www.gsi.go.jp/bousaichiri/hinanbasho.html）を加工して作成」
// 前提：区境界（public/data/boundary.geojson）が先にできていること（23区内かどうかの判定に使う）。
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import { toLocal } from './lib/projection.mjs';
import {
  HAZARD_KEYS,
  latestUpdate,
  parseShelterCsv,
  parseUpdateHistory,
  shelterProperties,
  sortShelters,
  summarizeWards,
  usableForFloodOrTide,
} from './lib/shelters.mjs';
import { loadWards } from './lib/wards.mjs';

const CSV_URL = 'https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/csv/13000_2.csv';
const HISTORY_URL = 'https://hinanmap.gsi.go.jp/hinanjocp/defaultFtpData/publicHistoryCSV/publicHistoryListData.csv';

console.log(`取得: ${CSV_URL}`);
const rows = parseShelterCsv((await fetchCached(CSV_URL)).toString('utf8'));
console.log(`取得: ${HISTORY_URL}`);
const history = parseUpdateHistory((await fetchCached(HISTORY_URL)).toString('utf8'));

const wards = loadWards();
const wardList = wards.features.map((f) => ({ code: f.properties.code, name: f.properties.name }));

// 23区内（座標で判定）だけを残す
const inside = [];
let noCoordinate = 0;
let outside = 0;
let outsideIn23Code = 0; // 共通ID の区コードは23区なのに、座標が区の外だったもの
let mismatched = 0; // 共通ID の区コードと、座標から求めた区が食い違うもの
const mismatchExamples = [];
for (const row of rows) {
  if (row.lat === null || row.lon === null) {
    noCoordinate++;
    continue;
  }
  const [x, y] = toLocal(row.lon, row.lat);
  const ward = wards.wardAt(x, y);
  if (!ward) {
    outside++;
    if (row.codeInId && wardList.some((w) => w.code === row.codeInId)) outsideIn23Code++;
    continue;
  }
  if (row.codeInId !== ward.code) {
    mismatched++;
    if (mismatchExamples.length < 10) {
      mismatchExamples.push(`${row.commonId} ${row.name}（共通ID: ${row.codeInId}、座標: ${ward.code} ${ward.name}）`);
    }
  }
  inside.push({ ...row, ward: ward.name, x, y });
}
if (inside.some((s) => s.name === '')) throw new Error('名称が空の避難場所があります');

const sorted = sortShelters(inside);
const features = sorted.map((s) => ({
  type: 'Feature',
  properties: shelterProperties(s, s.ward),
  geometry: { type: 'Point', coordinates: [s.x, s.y] },
}));
const summaries = summarizeWards(wardList, inside, history);
const updated = latestUpdate(summaries);
if (!updated) throw new Error('区ごとの更新日が取れませんでした（更新日の一覧に23区の行がありません）');

const geojsonFile = await writeFeatureCollection('shelters.geojson', features);
const jsonFile = path.join(DATA_DIR, 'shelters.json');
await writeFile(jsonFile, JSON.stringify({ updated, total: inside.length, wards: summaries }));

console.log(`書き出し: ${geojsonFile}`);
console.log(`書き出し: ${jsonFile}`);
console.log(`東京都の行: ${rows.length}、座標なし ${noCoordinate}、23区の外 ${outside}（うち共通ID が23区のもの ${outsideIn23Code}）、採用 ${inside.length}`);
const count = (pred) => inside.filter(pred).length;
console.log(
  `種別: ${HAZARD_KEYS.map((k) => `${k} ${count((s) => s[k])}`).join('、')}、洪水または高潮 ${count(usableForFloodOrTide)}、洪水かつ高潮 ${count((s) => s.flood && s.tide)}`,
);
console.log(`共通ID の区コードと座標から求めた区の食い違い: ${mismatched} 件`);
for (const e of mismatchExamples) console.log(`  - ${e}`);
console.log(`更新日（23区のうち最も新しい）: ${updated}`);
console.log('区ごと（件数 / 洪水 / 高潮 / 更新日）:');
for (const w of summaries) {
  console.log(`  ${w.code} ${w.name}: ${w.total} / ${w.flood} / ${w.tide} / ${w.updated ?? '?'}${w.published ? '' : '（未公開）'}`);
}
