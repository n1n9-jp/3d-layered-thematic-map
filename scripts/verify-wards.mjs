#!/usr/bin/env node
// 避難の段の区の分類（指定なし・未公開）と、区名の札を、画面とは別の方法で求め直し、画面の値と照合する。
//   node scripts/verify-wards.mjs [--data public/data] [--no-browser] [--url http://127.0.0.1:5173/]
// 別の方法：public/data/shelters.json と shelters.geojson を Node で直接読み（画面のコードは使わない）、区ごとに
//   未公開（データに載っていない。published が false）、指定なし（データに載っていて、洪水・高潮で使える避難場所が 0 件）、指定あり（null）に分ける。
//   浸水の深さは、区の分類には使わない（浸水の深さは浸水の段が示す）。
//   洪水・高潮で使える避難場所の「浸水が想定される区域の中・外」（深さ 0.5m 以上が中）は、flood.json と深さの格子（*.bin）を直接読んで、想定3通りの外・中の数を求め直し、
//   画面の値（避難の段のデータの inside、凡例、断面のグラフの輪郭だけの丸）と照合する。
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

/* 洪水・高潮で使える避難場所の、浸水が想定される区域の中・外（求め直し） */
const floodMeta = readJson('flood.json');
const depthGrid = { river: readFileSync(resolve(DIR, floodMeta.files.riverDepth)), tide: readFileSync(resolve(DIR, floodMeta.files.tideDepth)) };
/** 地点の深さのランク（1 = 0.5m 未満、2 = 0.5〜3m ...）。想定 scenario で、格子の外・23区の外（255）は null。 */
function depthRank(scenario, x, y) {
  const col = Math.floor((x - floodMeta.minX) / floodMeta.cellSize);
  const row = Math.floor((floodMeta.maxY - y) / floodMeta.cellSize);
  if (col < 0 || col >= floodMeta.width || row < 0 || row >= floodMeta.height) return null;
  const r = depthGrid.river[row * floodMeta.width + col];
  const t = depthGrid.tide[row * floodMeta.width + col];
  if (scenario === 'river') return r === 255 ? null : r;
  if (scenario === 'tide') return t === 255 ? null : t;
  return r === 255 || t === 255 ? null : Math.max(r, t);
}
const isIn = (scenario, x, y) => (depthRank(scenario, x, y) ?? 0) >= 2;
const usableShelters = shelters.features.filter((f) => f.properties.flood || f.properties.tide);
const insideWant = {};
for (const sc of ['max', 'river', 'tide']) {
  const n = usableShelters.filter((f) => isIn(sc, ...f.geometry.coordinates)).length;
  insideWant[sc] = { out: usableShelters.length - n, in: n };
}
console.log('\n[求め直し] 洪水・高潮で使える避難場所', usableShelters.length, 'か所の、浸水が想定される区域の外・中（深さ 0.5m 以上が中）');
for (const [sc, v] of Object.entries(insideWant)) console.log(`  ${sc.padEnd(5)} 外 ${v.out}・中 ${v.in}`);
/** 断面の線から 1 km 以内で、線への垂線の足が線分の内側にある、洪水・高潮で使える避難場所のうち、中・外の数（画面の断面のグラフの丸の数）。 */
function sectionWant(scenario, line) {
  const dx = line.bx - line.ax;
  const dy = line.by - line.ay;
  const len = Math.hypot(dx, dy);
  let out = 0;
  let inn = 0;
  for (const f of usableShelters) {
    const [x, y] = f.geometry.coordinates;
    const d = ((x - line.ax) * dx + (y - line.ay) * dy) / len;
    const off = (dx * (y - line.ay) - dy * (x - line.ax)) / len;
    if (d < 0 || d > len || Math.abs(off) > 1000) continue;
    if (isIn(scenario, x, y)) inn++;
    else out++;
  }
  return { out, in: inn };
}
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
    usable: d.kind.filter((k) => k === 'usable').length,
    inside: Object.fromEntries(
      ['max', 'river', 'tide'].map((sc) => {
        let inn = 0;
        let out = 0;
        d.kind.forEach((k, i) => {
          if (k !== 'usable') return;
          if (d.inside && d.inside[sc][i] === 1) inn++;
          else out++;
        });
        return [sc, { out, in: inn }];
      }),
    ),
  };
});
// 札は、初期状態（レイヤー一覧の行がすべて閉じている）では出さない。避難の行を開いているあいだだけ出す。区の枠と網掛けは、データとして常にある
check((await page.evaluate(() => window.__wardLabels ?? null)) === null, '初期表示（すべて閉じた状態）では、区名の札を出さない');
await page.click('[data-testid=layer-toggle-shelters]');
await sleep(1200);
const placedNow = () =>
  page.evaluate(() => ({
    placed: window.__wardLabels ? window.__wardLabels.placed.map((p) => ({ name: p.label.name, kind: p.label.kind })) : null,
    omitted: window.__wardLabels ? window.__wardLabels.omitted : null,
  }));
Object.assign(screen, await placedNow());
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
check(screen.placed !== null && screen.placed.length === 8 && screen.omitted.length === 0, `1400×1000 で避難の行を開くと、8枚の札がすべて地図に出ている（${screen.placed?.length} 枚、出さなかった区 ${screen.omitted?.join('・') || 'なし'}）`);
check(screen.frame > 0 && screen.hatch > 0 && screen.gapPolygons > 0, `指定なしの区の枠（${screen.frame} 本）と、未公開の区の網掛け（${screen.hatch} 本）の両方がある`);
// 洪水・高潮で使える避難場所の、浸水が想定される区域の中・外：画面の値と、データを直接読んで求め直した値
check(screen.usable === usableShelters.length, `洪水・高潮で使える避難場所の数 ${usableShelters.length}（画面 ${screen.usable}）`);
for (const sc of ['max', 'river', 'tide']) {
  const g = screen.inside[sc];
  const w = insideWant[sc];
  check(g.out === w.out && g.in === w.in, `想定 ${sc}：外 ${w.out}・中 ${w.in}（画面 外 ${g.out}・中 ${g.in}）`);
}
// 凡例（避難の段）
const legend = await page.$$eval('[data-testid=legend-shelters] li', (els) => els.map((e) => e.textContent.trim()));
const want = [
  '洪水・高潮で使える避難場所：浸水が想定される区域の外（塗り）',
  '洪水・高潮で使える避難場所：浸水が想定される区域の中（輪郭）',
  'それ以外の避難場所',
  '病院',
  '指定なし：洪水・高潮用の指定が 0 件の区',
  '未公開：データに載っていない区（ないとは限らない）',
];
check(legend.length === want.length && want.every((w, i) => legend[i] === w), `凡例は6行（${legend.join(' / ')}）`);
const swatches = await page.$$eval('[data-testid=legend-shelters] li > span', (els) => els.map((e) => e.className.replace('lp-swatch', '').trim()));
check(swatches.slice(0, 2).join() === 'lp-swatch-dot,lp-swatch-ring', `凡例の見本：塗りの丸、輪郭だけの丸（${swatches.join(' / ')}）`);
// 別の行を開くと、避難の行は閉じ、札も消える
await page.click('[data-testid=layer-toggle-flood]');
await sleep(800);
check((await page.getAttribute('[data-testid=layer-toggle-shelters]', 'aria-expanded')) === 'false' && (await placedNow()).placed === null, '別のレイヤーの行を開くと、避難の行が閉じて、札が消える');
// 折りたたみの注記：指定なしと未公開が区別して読める
await page.click('[data-testid=overall-notes-toggle]');
const notes = await page.textContent('[data-testid=overall-notes-body]');
const noneSentence = notes.slice(notes.indexOf('指定なしは'), notes.indexOf('未公開は'));
const unpubSentence = notes.slice(notes.indexOf('未公開は'));
for (const n of names('none')) check(noneSentence.includes(n) && !unpubSentence.slice(0, 60).includes(n), `注記の「指定なし」に ${n} が出ている`);
for (const n of names('unpublished')) check(unpubSentence.includes(n) && !noneSentence.includes(n), `注記の「未公開」に ${n} が出ている`);
check(!/浸水が深い|琥珀/.test(notes + legend.join('')), '注記と凡例に、浸水の深さによる区の書き分けが残っていない');
// 断面のグラフ（例の線「台地から低地へ」）：洪水・高潮で使える避難場所の丸が、塗り（区域の外）と輪郭だけ（中）に描き分けられ、想定の切り替えに連動する
{
  const line = { ax: -4471, ay: 1066, bx: 10706, by: 2969 };
  await page.goto(`${base}?${values.data.includes('fixture') ? 'data=fixture&' : ''}section=${line.ax},${line.ay},${line.bx},${line.by}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await sleep(2000);
  const chartCircles = () =>
    page.$$eval('[data-testid=section-chart][data-layer=shelters] circle', (els) => ({
      hollow: els.filter((e) => e.getAttribute('data-inside') === 'true').length,
      filled: els.filter((e) => e.getAttribute('r') === '4.4').length,
    }));
  for (const sc of ['max', 'river', 'tide']) {
    await page.evaluate((v) => window.__store.getState().setOption('floodScenario', v), sc);
    await sleep(600);
    const got = await chartCircles();
    const w = sectionWant(sc, line);
    check(got.hollow === w.in && got.filled === w.out, `断面のグラフ（想定 ${sc}）：輪郭だけの丸 ${w.in}・塗りの丸 ${w.out}（画面 ${got.hollow}・${got.filled}）`);
  }
  // 「見るもの」を継続時間にしても、判定は深さのまま（中・外の丸の数は変わらない）
  await page.evaluate(() => {
    const st = window.__store.getState();
    st.setOption('floodScenario', 'max');
    st.setOption('floodView', 'duration');
  });
  await sleep(600);
  const dur = await chartCircles();
  const wMax = sectionWant('max', line);
  check(dur.hollow === wMax.in && dur.filled === wMax.out, `「見るもの」を水が引くまでにしても、判定は深さのまま（輪郭だけ ${dur.hollow}・塗り ${dur.filled}）`);
}
await browser.close();
if (failures.length) {
  console.log(`\n不合格 ${failures.length} 件`);
  process.exit(1);
}
console.log('\nすべて合格');
process.exit(0);
