// 施設データ（public/data/facilities.geojson）を作る。使い方: node scripts/build-facilities.mjs
// 学校：国土数値情報 学校データ（P29）2023年度版、東京都。
//   出典：「国土数値情報（学校データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P29-2023.html）を加工して作成
// 病院：国土数値情報 医療機関データ（P04）2020年度版、東京都。
//   出典：「国土数値情報（医療機関データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P04-2020.html）を加工して作成
import { unzipSync } from 'fflate';
import { hospitalProperties, schoolProperties, findEntry } from './lib/facilities.mjs';
import { fetchCached } from './lib/fetch-cache.mjs';
import { writeFeatureCollection } from './lib/geojson.mjs';
import { toLocal } from './lib/projection.mjs';
import { loadWards } from './lib/wards.mjs';

const SCHOOL_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/P29/P29-23/P29-23_13_GML.zip';
const SCHOOL_ENTRY = 'P29-23_13.geojson';
const HOSPITAL_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/P04/P04-20/P04-20_13_GML.zip';
const HOSPITAL_ENTRY = 'P04-20_13.geojson';

/** ZIP を取得して、名前の末尾が entry のファイルを GeoJSON として読む。 */
async function loadGeoJson(url, entry) {
  console.log(`取得: ${url}`);
  const zip = await fetchCached(url);
  const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name.endsWith(entry) });
  return JSON.parse(new TextDecoder('utf-8').decode(findEntry(files, entry)));
}

const wards = loadWards();

/** source の Point を properties 変換 → 23区内だけ残して、ローカル座標の Feature にする。 */
function convert(source, toProperties) {
  const features = [];
  let total = 0;
  let skipped = 0;
  let outside = 0;
  for (const f of source.features) {
    total++;
    const properties = toProperties(f.properties);
    if (!properties) {
      skipped++;
      continue;
    }
    if (f.geometry?.type !== 'Point') throw new Error(`Point ではありません: ${f.geometry?.type}`);
    const [lon, lat] = f.geometry.coordinates;
    const [x, y] = toLocal(lon, lat);
    if (!wards.contains(x, y)) {
      outside++;
      continue;
    }
    features.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [x, y] } });
  }
  return { features, total, skipped, outside };
}

const schools = convert(await loadGeoJson(SCHOOL_URL, SCHOOL_ENTRY), schoolProperties);
const hospitals = convert(await loadGeoJson(HOSPITAL_URL, HOSPITAL_ENTRY), hospitalProperties);

const count = (features) => {
  const m = new Map();
  for (const f of features) m.set(f.properties.subtype, (m.get(f.properties.subtype) ?? 0) + 1);
  return [...m].map(([k, v]) => `${k} ${v}`).join('、');
};
console.log(`学校: 元 ${schools.total} 件 → 対象外 ${schools.skipped}、23区外 ${schools.outside}、採用 ${schools.features.length}（${count(schools.features)}）`);
console.log(`病院: 元 ${hospitals.total} 件 → 対象外 ${hospitals.skipped}、23区外 ${hospitals.outside}、採用 ${hospitals.features.length}`);

const file = await writeFeatureCollection('facilities.geojson', [...schools.features, ...hospitals.features]);
console.log(`書き出し: ${file}`);
