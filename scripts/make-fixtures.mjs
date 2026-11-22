// 仮データを public/data-fixture/ に書き出す。使い方: node scripts/make-fixtures.mjs
// 種を固定しているため、何度実行しても同じ出力になる。仕様の確認は
//   node scripts/validate-data.mjs public/data-fixture --require-all
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFixtures } from './lib/fixtures.mjs';
import { ROOT_DIR } from './lib/paths.mjs';

// 実行したディレクトリではなく、リポジトリのルート基準で書き出す。
const OUT_DIR = path.join(ROOT_DIR, 'public', 'data-fixture');

const { geojson, shelterSummary, elevation } = generateFixtures();
await mkdir(OUT_DIR, { recursive: true });

const written = [];
for (const [name, fc] of Object.entries(geojson)) {
  const body = JSON.stringify(fc);
  await writeFile(path.join(OUT_DIR, name), body);
  written.push([name, Buffer.byteLength(body), fc.features.length]);
}
const summaryBody = JSON.stringify(shelterSummary);
await writeFile(path.join(OUT_DIR, 'shelters.json'), summaryBody);
written.push(['shelters.json', Buffer.byteLength(summaryBody), null]);
await writeFile(path.join(OUT_DIR, 'elevation.json'), JSON.stringify(elevation.meta));
await writeFile(path.join(OUT_DIR, 'elevation.bin'), elevation.bin);
written.push(['elevation.json', Buffer.byteLength(JSON.stringify(elevation.meta)), null]);
written.push(['elevation.bin', elevation.bin.length, null]);

for (const [name, size, count] of written) {
  console.log(`${name}: ${size} bytes${count === null ? '' : `, ${count} features`}`);
}
console.log(`出力先: ${OUT_DIR}`);
