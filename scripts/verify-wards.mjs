#!/usr/bin/env node
// 区ごとの「浸水が想定される区域に住む人の割合」「深さ 3m 以上の区域に住む人の割合」と、洪水・高潮用の指定が 0 件の区の分類を、
// 画面とは別の方法（public/data/ のファイルを Node で直接読む。画面のコードは使わない）で求め直し、画面の値と照合する。
//   node scripts/verify-wards.mjs [--data public/data] [--no-browser] [--url http://127.0.0.1:5173/]
// 別の方法：人口の250mメッシュの中心（4隅の平均）を、区の輪郭（偶奇規則の点の内外判定）で区に振り分け、
//   メッシュの中心を含む浸水想定のセル（50 m。洪水と高潮の大きいほう）のランクで、人口を丸ごと数える。
//   分類：データを公開していて、洪水・高潮用の指定が 0 件の区のうち、深さ 3m 以上（ランク 3 以上）の区域に住む人が区の人口の 10% 以上 → 深い、未満 → 小さい。
// 画面の値は、Playwright で開いて window.__store の避難のデータ（区ごとの分類と割合）と、右の列の 23区全体の集計の文面から読む。
// 1つでも食い違えば、内容を表示して終了コード 1 で終わる。--no-browser なら、求め直した値を表示するだけ。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'public/data' },
    url: { type: 'string' },
    'no-browser': { type: 'boolean', default: false },
  },
});
const DIR = resolve(ROOT, values.data);
const readJson = (n) => JSON.parse(readFileSync(resolve(DIR, n), 'utf8'));
const readBin = (n) => new Uint8Array(readFileSync(resolve(DIR, n)));
const THRESHOLD = 0.1;

/* ---------- 求め直し（Node） ---------- */
const meta = readJson('flood.json');
const river = readBin(meta.files.riverDepth);
const tide = readBin(meta.files.tideDepth);
const pop = readJson('population.geojson');
const boundary = readJson('boundary.geojson');
const shelters = readJson('shelters.geojson');
const summary = readJson('shelters.json');

const inRing = (x, y, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((r) => inRing(x, y, r));
const partsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
const wardOf = (x, y) => boundary.features.find((f) => partsOf(f.geometry).some((p) => inPolygon(x, y, p)))?.properties.name ?? null;

const acc = new Map(boundary.features.map((f) => [f.properties.name, { people: 0, flooded: 0, severe: 0 }]));
for (const f of pop.features) {
  const ring = f.geometry.coordinates[0];
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < ring.length - 1; k++) {
    cx += ring[k][0];
    cy += ring[k][1];
  }
  cx /= ring.length - 1;
  cy /= ring.length - 1;
  const col = Math.floor((cx - meta.minX) / meta.cellSize);
  const row = Math.floor((meta.maxY - cy) / meta.cellSize);
  if (col < 0 || col >= meta.width || row < 0 || row >= meta.height) continue;
  const i = row * meta.width + col;
  if (river[i] === 255 || tide[i] === 255) continue;
  const p = Math.max(river[i], tide[i]);
  const w = wardOf(cx, cy);
  const a = w === null ? undefined : acc.get(w);
  if (!a) continue;
  const n = f.properties.population;
  a.people += n;
  if (p >= 1) a.flooded += n;
  if (p >= 3) a.severe += n;
}
const usable = new Map();
const total = new Map();
for (const f of shelters.features) {
  total.set(f.properties.ward, (total.get(f.properties.ward) ?? 0) + 1);
  if (f.properties.flood || f.properties.tide) usable.set(f.properties.ward, (usable.get(f.properties.ward) ?? 0) + 1);
}
const published = new Map(summary.wards.map((w) => [w.name, w.published]));
const rows = boundary.features.map((f) => {
  const name = f.properties.name;
  const a = acc.get(name);
  const u = usable.get(name) ?? 0;
  const pub = published.get(name) !== false;
  const severeShare = a.people > 0 ? a.severe / a.people : 0;
  const cls = !pub ? 'unpublished' : u > 0 ? null : severeShare >= THRESHOLD ? 'deep-none' : 'shallow-none';
  return { name, people: a.people, flooded: a.flooded, severe: a.severe, floodedShare: a.people > 0 ? a.flooded / a.people : 0, severeShare, usable: u, other: (total.get(name) ?? 0) - u, published: pub, cls };
});
const pct = (v) => `${(100 * v).toFixed(1)}%`;
console.log('\n[求め直し] 区ごと（想定は洪水と高潮の大きいほう）');
console.log('区       公開 洪水・高潮用 それ以外  人口    浸水が想定される区域  深さ3m以上   分類');
for (const r of rows)
  console.log(`${r.name.padEnd(5, '　')} ${r.published ? 'Y' : 'N'}   ${String(r.usable).padStart(5)} ${String(r.other).padStart(8)}  ${String(r.people).padStart(8)}  ${pct(r.floodedShare).padStart(7)}      ${pct(r.severeShare).padStart(7)}     ${r.cls ?? '—（指定あり）'}`);
const names = (c) => rows.filter((r) => r.cls === c).map((r) => r.name);
console.log(`\n未公開：${names('unpublished').join('・')}\n浸水が深いのに指定がない：${names('deep-none').join('・')}\n浸水が小さく指定がない：${names('shallow-none').join('・')}`);
if (values['no-browser']) process.exit(0);

/* ---------- 画面の値（Playwright） ---------- */
const { chromium } = createRequire(import.meta.url)('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}
let vite = null;
async function baseUrl() {
  if (values.url) return values.url;
  const port = await freePort();
  vite = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) return url;
    } catch {
      /* まだ */
    }
    await sleep(150);
  }
  throw new Error('Vite が起動しませんでした');
}
process.on('exit', () => {
  if (vite) {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      /* すでに終了 */
    }
  }
});
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${msg}`);
  if (!ok) failures.push(msg);
};

const base = await baseUrl();
const browser = await chromium.launch(process.env.SHOT_CHROMIUM_ARGS ? { args: process.env.SHOT_CHROMIUM_ARGS.split(/\s+/) } : {});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await page.goto(base + (values.data.includes('fixture') ? '?data=fixture' : ''));
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
console.log('\n[画面の値と照合]');
const screen = await page.evaluate(() =>
  window.__store.getState().data.shelters.wards.map((w) => ({ name: w.name, gap: w.gap, published: w.published, usable: w.usable, exposure: w.exposure ? { people: w.exposure.people, flooded: w.exposure.flooded, severe: w.exposure.severe, floodedShare: w.exposure.floodedShare, severeShare: w.exposure.severeShare } : null })),
);
check(screen.length === rows.length, `区の数 ${rows.length}（画面 ${screen.length}）`);
for (const r of rows) {
  const s = screen.find((w) => w.name === r.name);
  if (!s) {
    check(false, `${r.name} が画面にない`);
    continue;
  }
  const same = s.exposure && s.exposure.people === r.people && s.exposure.flooded === r.flooded && s.exposure.severe === r.severe;
  check(!!same, `${r.name}：人口 ${r.people}・浸水想定 ${pct(r.floodedShare)}・3m以上 ${pct(r.severeShare)}（画面 ${s.exposure ? `${s.exposure.people}・${pct(s.exposure.floodedShare)}・${pct(s.exposure.severeShare)}` : 'なし'}）`);
  check(s.gap === r.cls && s.usable === r.usable, `${r.name}：分類 ${r.cls ?? '指定あり'}・洪水高潮用 ${r.usable}（画面 ${s.gap ?? '指定あり'}・${s.usable}）`);
}
// 23区全体の集計の文面に、分類の区名が入っていること
const has = async (id) => (await page.textContent(`[data-testid=${id}]`).catch(() => '')) ?? '';
const deepText = await has('overall-deep-names');
for (const n of names('deep-none')) check(deepText.includes(n), `「浸水が深いのに指定がない区」に ${n} が出ている`);
for (const n of [...names('shallow-none'), ...names('unpublished'), ...rows.filter((r) => r.usable > 0).map((r) => r.name)])
  check(!deepText.includes(n), `「浸水が深いのに指定がない区」に ${n} は出ていない`);
const shallowText = await has('overall-shallow');
for (const n of names('shallow-none')) check(shallowText.includes(n), `「浸水が小さく指定がない」に ${n} が出ている`);
const unpubText = await has('overall-unpublished');
for (const n of names('unpublished')) check(unpubText.includes(n), `「データ未公開」に ${n} が出ている`);
await browser.close();
if (failures.length) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
process.exit(0);
