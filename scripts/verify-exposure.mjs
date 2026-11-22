#!/usr/bin/env node
// 「浸水が想定される区域に住む人」の、23区全体の集計を、画面とは別の方法で求め直して、画面の値と照合する。
//   node scripts/verify-exposure.mjs [--data public/data] [--no-browser] [--url http://127.0.0.1:5173/]
// 別の方法：public/data/ のファイル（population.geojson、flood-*.bin、elevation.bin、shelters.*）を Node で直接読み、
// 人口のメッシュごとに、メッシュの中心を含む浸水想定のセルのランクを引いて、区分ごとに人口と65歳以上人口を合計する（画面のコードは使わない）。
// 画面の値は、Playwright で開いて、右の列の表（`data-testid=overall-exposure-*`）から読む。想定は大きいほう・洪水・高潮のすべて。
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

/* ---------- 求め直し（Node） ---------- */
const meta = readJson('flood.json');
const { width: W, height: H, cellSize: C, minX, maxY } = meta;
const river = readBin(meta.files.riverDepth);
const tide = readBin(meta.files.tideDepth);
const elevBuf = readFileSync(resolve(DIR, 'elevation.bin'));
const elev = new Float32Array(elevBuf.buffer.slice(elevBuf.byteOffset, elevBuf.byteOffset + elevBuf.byteLength));
const pop = readJson('population.geojson');
const shelters = readJson('shelters.geojson');
const summary = readJson('shelters.json');

const cellOf = (x, y) => {
  const col = Math.floor((x - minX) / C);
  const row = Math.floor((maxY - y) / C);
  return col < 0 || col >= W || row < 0 || row >= H ? -1 : row * W + col;
};

function recompute() {
  const out = {};
  for (const sc of ['max', 'river', 'tide']) {
    const people = Array(7).fill(0);
    const elderly = Array(7).fill(0);
    let below = { people: 0, elderly: 0 };
    let unknown = { meshes: 0, people: 0 };
    let outside = { meshes: 0, people: 0 };
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
      const { population, elderly: e } = f.properties;
      const i = cellOf(cx, cy);
      const r = i < 0 ? 255 : river[i];
      const t = i < 0 ? 255 : tide[i];
      if (r === 255 || t === 255) {
        outside.meshes++;
        outside.people += population;
        continue;
      }
      const p = sc === 'river' ? r : sc === 'tide' ? t : Math.max(r, t);
      people[p] += population;
      elderly[p] += e ?? 0;
      if (e === null) {
        unknown.meshes++;
        unknown.people += population;
      }
      if (elev[i] < 0) {
        below.people += population;
        below.elderly += e ?? 0;
      }
    }
    out[sc] = { people, elderly, below, unknown, outside, total: people.reduce((a, b) => a + b, 0), totalElderly: elderly.reduce((a, b) => a + b, 0) };
  }
  const usable = shelters.features.filter((f) => f.properties.flood || f.properties.tide).length;
  const unpublished = summary.wards.filter((w) => !w.published).map((w) => w.name);
  const perWardUsable = new Map();
  for (const f of shelters.features) if (f.properties.flood || f.properties.tide) perWardUsable.set(f.properties.ward, (perWardUsable.get(f.properties.ward) ?? 0) + 1);
  const zero = summary.wards.filter((w) => w.published && !perWardUsable.get(w.name)).map((w) => w.name);
  return { byScenario: out, usable, unpublished, zero };
}

const exp = recompute();
const fmt = (n) => n.toLocaleString('ja-JP');
const LABELS = ['浸水なし', '0.5m 未満', '0.5〜3m', '3〜5m', '5〜10m', '10〜20m', '20m 以上'];
for (const sc of ['max', 'river', 'tide']) {
  const e = exp.byScenario[sc];
  console.log(`\n[求め直し] 想定 ${sc}`);
  for (let p = 6; p >= 0; p--) console.log(`  ${LABELS[p].padEnd(10)} 人口 ${fmt(e.people[p]).padStart(10)}  65歳以上 ${fmt(e.elderly[p]).padStart(9)}`);
  console.log(`  合計 ${fmt(e.total)}（65歳以上 ${fmt(e.totalElderly)}）、標高 0m 未満 ${fmt(e.below.people)}（65歳以上 ${fmt(e.below.elderly)}）`);
  console.log(`  65歳以上が不明 ${e.unknown.meshes} メッシュ（${fmt(e.unknown.people)} 人）、23区の外 ${e.outside.meshes} メッシュ（${fmt(e.outside.people)} 人）`);
}
console.log(`\n[求め直し] 洪水・高潮で使える避難場所 ${exp.usable} か所。データ未公開の区：${exp.unpublished.join('・')}。洪水・高潮用が 0 件の区：${exp.zero.join('・')}`);
if (values['no-browser']) process.exit(0);

/* ---------- 画面の値（Playwright） ---------- */
const { chromium } = require_playwright();
function require_playwright() {
  return createRequire(import.meta.url)('playwright');
}
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
const num = (s) => Number(String(s).replace(/[^\d]/g, ''));

const base = await baseUrl();
const browser = await chromium.launch(process.env.SHOT_CHROMIUM_ARGS ? { args: process.env.SHOT_CHROMIUM_ARGS.split(/\s+/) } : {});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const q = values.data.includes('fixture') ? '?data=fixture' : '';
await page.goto(base + q);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
console.log('\n[画面の値と照合]');
for (const sc of ['max', 'river', 'tide']) {
  await page.evaluate((s) => window.__store.getState().setOption('floodScenario', s), sc);
  await page.waitForFunction((s) => document.querySelector('[data-testid=overall-exposure]')?.getAttribute('data-scenario') === s, sc, { timeout: 30000 });
  const rows = await page.$$eval('[data-testid=overall-exposure-row]', (els) =>
    els.map((el) => ({ rank: Number(el.getAttribute('data-rank')), cells: [...el.querySelectorAll('td')].map((td) => td.textContent) })),
  );
  const e = exp.byScenario[sc];
  for (const r of rows) {
    check(num(r.cells[0].split(' ')[0]) === e.people[r.rank] && num(r.cells[1]) === e.elderly[r.rank], `${sc}：${LABELS[r.rank]} 人口 ${fmt(e.people[r.rank])}・65歳以上 ${fmt(e.elderly[r.rank])}（画面 ${r.cells[0].split(' ')[0]} / ${r.cells[1]}）`);
  }
  check(rows.length === 7, `${sc}：区分が7行（${rows.length}）`);
  const total = await page.$$eval('[data-testid=overall-exposure-total] td', (els) => els.map((e) => e.textContent));
  check(num(total[0]) === e.total && num(total[1]) === e.totalElderly, `${sc}：合計 ${fmt(e.total)}・${fmt(e.totalElderly)}（画面 ${total.join(' / ')}）`);
  const below = await page.$$eval('[data-testid=overall-exposure-below] td', (els) => els.map((e) => e.textContent));
  check(num(below[0]) === e.below.people && num(below[1]) === e.below.elderly, `${sc}：標高 0m 未満 ${fmt(e.below.people)}・${fmt(e.below.elderly)}（画面 ${below.join(' / ')}）`);
}
const usable = await page.textContent('[data-testid=overall-usable]');
check(num(usable) === exp.usable, `洪水・高潮で使える避難場所 ${exp.usable}（画面 ${usable}）`);
const shelterText = await page.textContent('[data-testid=overall-shelters]');
for (const n of exp.unpublished) check(shelterText.includes(n), `データ未公開の区に ${n} が出ている`);
const zeroText = await page.textContent('[data-testid=overall-zero]');
for (const n of exp.zero) check(zeroText.includes(n), `洪水・高潮用が 0 件の区に ${n} が出ている`);
await browser.close();
if (failures.length) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
