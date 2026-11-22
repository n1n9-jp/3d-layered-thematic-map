#!/usr/bin/env node
// 避難の段の区の分類（指定なし・未公開）と、区名の札を、画面とは別の方法で求め直し、画面の値と照合する。
//   node scripts/verify-wards.mjs [--data public/data] [--no-browser] [--url http://127.0.0.1:5173/]
// 別の方法：public/data/shelters.json と shelters.geojson を Node で直接読み（画面のコードは使わない）、区ごとに
//   未公開（データに載っていない。published が false）、指定なし（データに載っていて、洪水・高潮で使える避難場所が 0 件）、指定あり（null）に分ける。
//   浸水の深さは使わない（浸水の深さは浸水の段が示す）。
// 画面の値：Playwright で開いて、window.__store の避難のデータ（区ごとの分類、輪郭の枠、網掛け、札）と、いま出している札の配置
//   （window.__wardLabels）、凡例、折りたたみの注記を読んで照合する。
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

/* ---------- 求め直し（Node） ---------- */
const boundary = readJson('boundary.geojson');
const shelters = readJson('shelters.geojson');
const summary = readJson('shelters.json');
const usable = new Map();
const total = new Map();
for (const f of shelters.features) {
  total.set(f.properties.ward, (total.get(f.properties.ward) ?? 0) + 1);
  if (f.properties.flood || f.properties.tide) usable.set(f.properties.ward, (usable.get(f.properties.ward) ?? 0) + 1);
}
const published = new Map(summary.wards.map((w) => [w.name, w.published]));
const rows = boundary.features.map((f) => {
  const name = f.properties.name;
  const u = usable.get(name) ?? 0;
  const pub = published.get(name) !== false;
  const cls = !pub ? 'unpublished' : u > 0 ? null : 'none';
  return { name, published: pub, usable: u, other: (total.get(name) ?? 0) - u, cls };
});
console.log('\n[求め直し] 区ごと');
console.log('区       公開 洪水・高潮用 それ以外  分類');
for (const r of rows) console.log(`${r.name.padEnd(5, '　')} ${r.published ? 'Y' : 'N'}   ${String(r.usable).padStart(5)} ${String(r.other).padStart(8)}  ${r.cls ?? '—（指定あり）'}`);
const names = (c) => rows.filter((r) => r.cls === c).map((r) => r.name);
console.log(`\n指定なし：${names('none').join('・')}\n未公開：${names('unpublished').join('・')}`);
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
await sleep(2500);
console.log('\n[画面の値と照合]');
const screen = await page.evaluate(() => {
  const d = window.__store.getState().data.shelters;
  return {
    wards: d.wards.map((w) => ({ name: w.name, gap: w.gap, published: w.published, usable: w.usable })),
    labels: d.labels.map((l) => ({ name: l.name, text: l.text, kind: l.kind })),
    frame: d.frame.length,
    hatch: d.hatch.length,
    gapPolygons: d.gapPolygons.length,
    placed: window.__wardLabels ? window.__wardLabels.placed.map((p) => ({ name: p.label.name, kind: p.label.kind })) : null,
    omitted: window.__wardLabels ? window.__wardLabels.omitted : null,
  };
});
check(screen.wards.length === rows.length, `区の数 ${rows.length}（画面 ${screen.wards.length}）`);
for (const r of rows) {
  const s = screen.wards.find((w) => w.name === r.name);
  if (!s) {
    check(false, `${r.name} が画面にない`);
    continue;
  }
  check(s.gap === r.cls && s.usable === r.usable && s.published === r.published, `${r.name}：分類 ${r.cls ?? '指定あり'}・洪水高潮用 ${r.usable}（画面 ${s.gap ?? '指定あり'}・${s.usable}）`);
}
// 札：指定なしと未公開の全区に、「区名／指定なし」「区名／未公開」
const expectLabels = rows.filter((r) => r.cls).map((r) => ({ name: r.name, text: `${r.name}\n${r.cls === 'none' ? '指定なし' : '未公開'}`, kind: r.cls }));
check(screen.labels.length === expectLabels.length && screen.labels.length === 8, `札は ${expectLabels.length} 区すべて（画面 ${screen.labels.length}）`);
for (const e of expectLabels) {
  const l = screen.labels.find((x) => x.name === e.name);
  check(!!l && l.text === e.text && l.kind === e.kind, `${e.name}：札「${e.text.replace('\n', '／')}」（画面 ${l ? l.text.replace('\n', '／') : 'なし'}）`);
}
check(screen.placed !== null && screen.placed.length === 8 && screen.omitted.length === 0, `1400×1000 の初期表示で、8枚の札がすべて地図に出ている（${screen.placed?.length} 枚、出さなかった区 ${screen.omitted?.join('・') || 'なし'}）`);
check(screen.frame > 0 && screen.hatch > 0 && screen.gapPolygons > 0, `指定なしの区の枠（${screen.frame} 本）と、未公開の区の網掛け（${screen.hatch} 本）の両方がある`);
// 凡例（避難の段）
const legend = await page.$$eval('[data-testid=legend-shelters] li', (els) => els.map((e) => e.textContent.trim()));
const want = ['洪水・高潮で使える避難場所', 'それ以外の避難場所', '病院', '指定なし：洪水・高潮用の指定が 0 件の区', '未公開：データに載っていない区（ないとは限らない）'];
check(legend.length === want.length && want.every((w, i) => legend[i] === w), `凡例は5行（${legend.join(' / ')}）`);
// 折りたたみの注記：指定なしと未公開が区別して読める
await page.click('[data-testid=overall-notes-toggle]');
const notes = await page.textContent('[data-testid=overall-notes-body]');
const noneSentence = notes.slice(notes.indexOf('指定なしは'), notes.indexOf('未公開は'));
const unpubSentence = notes.slice(notes.indexOf('未公開は'));
for (const n of names('none')) check(noneSentence.includes(n) && !unpubSentence.slice(0, 60).includes(n), `注記の「指定なし」に ${n} が出ている`);
for (const n of names('unpublished')) check(unpubSentence.includes(n) && !noneSentence.includes(n), `注記の「未公開」に ${n} が出ている`);
check(!/浸水が深い|琥珀/.test(notes + legend.join('')), '注記と凡例に、浸水の深さによる区の書き分けが残っていない');
await browser.close();
if (failures.length) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
process.exit(0);
