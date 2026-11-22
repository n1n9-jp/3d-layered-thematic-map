#!/usr/bin/env node
// 断面の右のチャートと、全体の地図の段の対応（配置と連動）の確認。
//   node scripts/verify-align.mjs [--url http://127.0.0.1:5173/] [--size 1400x1000] [--real] [--only 1,2,2b,3,4,5]
// 既定は仮データ（?data=fixture）。--real なら実データ（1フレーム約2秒かかる環境では時間がかかる。段の高さの確認だけなら --only 1 が速い）。
// --only は、確認する節の番号（下の 1〜5。間隔をゆっくり往復する 2b を含む）。
// 確認すること：
//   1. 各チャートの枠の縦の中心が、全体の地図の対応する段の平面の中心と、画面上で数 px 以内で揃う（2000×1100・1400×1000）
//   2. 間隔を 12 km → 20 km → 3 km → 0 へ動かすと、チャートが段に追従し、縦並びへの切り替えは1回だけ起きる。
//      間隔をゆっくり 12 km → 0 → 12 km と往復しても、切り替えは行きに1回、帰りに1回で、行き来を繰り返さない
//   3. 段を並べ替えると、チャートの順番が変わる。非表示の段のチャートは出ない
//   4. 真上の視点・単独表示は縦並び。拡大して段が列の外へはみ出しても、チャートは列の中に収まる
//   5. 右のチャートにカーソルを置くと、対応する段以外が暗くなり、外すと戻る。全体の地図の切り口の近くにカーソルを置くと、対応するチャートが目立つ
// 1つでも外れれば、内容を表示して終了コード 1 で終わる。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({ options: { url: { type: 'string' }, size: { type: 'string', default: '1400x1000' }, real: { type: 'boolean', default: false }, only: { type: 'string' } } });
const want = (k) => !values.only || values.only.split(',').map((x) => x.trim()).includes(k);
const DATA = values.real ? '' : 'data=fixture&';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${msg}`);
  if (!ok) failures.push(msg);
};
/** 段の高さと、チャートの枠の中心の、許す画面上のずれ（px）。 */
const TOLERANCE = 4;

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

const { OrbitView } = await import(join(ROOT, 'node_modules/@deck.gl/core/dist/index.js'));
const waitFor = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const settle = async (page, ms = 1500) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
};

async function open(browser, base, query, size = values.size) {
  const [w, h] = size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?${DATA}${query}`, { waitUntil: 'load' });
  await waitFor(page, () => window.__ready === true);
  // 配置の変化（data-layout）の履歴を、ページの中で取る。
  await page.evaluate(() => {
    window.__layoutLog = [];
    const attach = () => {
      const el = document.querySelector('[data-testid=section-scroll]');
      if (!el || el.__watched) return !!el;
      el.__watched = true;
      window.__layoutLog.push(el.getAttribute('data-layout'));
      new MutationObserver(() => window.__layoutLog.push(el.getAttribute('data-layout'))).observe(el, { attributes: true, attributeFilter: ['data-layout'] });
      return true;
    };
    attach();
    new MutationObserver(attach).observe(document.body, { childList: true, subtree: true });
  });
  await settle(page, 1500);
  return { ctx, page, errors };
}

/** 段の平面の中心の、画面（ブラウザの画面）上の y。表示中の段を order の順に下から詰めた高さ。 */
async function tierYs(page) {
  const info = await page.evaluate(() => {
    const s = window.__store.getState();
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { top: r.top, width: r.width, height: r.height, vs: s.viewState, spacing: s.spacing, order: s.order, visible: s.visible, solo: s.solo };
  });
  const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: info.width, height: info.height, viewState: info.vs });
  const ys = {};
  let tier = 0;
  for (const id of info.order) {
    if (info.solo !== null ? info.solo !== id : !info.visible[id]) continue;
    const z = info.solo !== null ? 0 : tier++ * info.spacing;
    ys[id] = info.top + vp.project([-1000, -1000, z])[1];
  }
  return ys;
}

const charts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=section-chart]')].map((c) => {
      const r = c.querySelector('[data-testid=section-frame]').getBoundingClientRect();
      return { id: c.dataset.layer, cy: r.top + r.height / 2, h: r.height, top: r.top, bottom: r.bottom, hot: c.hasAttribute('data-hot') };
    }),
  );
const stageBox = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('[data-testid=section-scroll]').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, layout: document.querySelector('[data-testid=section-scroll]').getAttribute('data-layout') };
  });
const layoutLog = (page) => page.evaluate(() => window.__layoutLog.slice());
/** 履歴から、連続する重複を除いた切り替えの列。 */
const transitions = (log) => log.filter((v, i) => i === 0 || v !== log[i - 1]);

async function measureOffsets(page) {
  const ys = await tierYs(page);
  const cs = await charts(page);
  return cs.map((c) => ({ id: c.id, off: c.cy - ys[c.id], h: c.h }));
}

/** 全体の地図の、段ごとの帯（段の中心の上下 pitch/2）の、画素の明るさの平均。 */
async function bandBrightness(page, ys) {
  const buf = await page.screenshot();
  const png = PNG.sync.read(buf);
  const info = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { left: r.left, width: r.width };
  });
  const entries = Object.entries(ys).sort((a, b) => a[1] - b[1]);
  const pitch = entries.length > 1 ? entries[1][1] - entries[0][1] : 100;
  const out = {};
  for (const [id, y] of entries) {
    let sum = 0;
    let n = 0;
    const x1 = Math.round(info.left + info.width * 0.62); // 右の列と、段の名前は含めない
    for (let py = Math.max(0, Math.round(y - pitch * 0.35)); py < Math.min(png.height, Math.round(y + pitch * 0.35)); py++)
      for (let px = Math.round(info.left); px < x1; px++) {
        const i = (py * png.width + px) * 4;
        sum += 0.3 * png.data[i] + 0.59 * png.data[i + 1] + 0.11 * png.data[i + 2];
        n++;
      }
    out[id] = sum / n;
  }
  return out;
}

const QUERY = 'section=-15000,-2000,14000,-2000';

async function run(browser, base) {
  console.log(`\n[1] 段とチャートの高さ（${values.real ? '実データ' : '仮データ'}、東西の線）`);
  for (const size of want('1') ? ['2000x1100', '1400x1000'] : []) {
    const o = await open(browser, base, QUERY, size);
    const st = await stageBox(o.page);
    const offs = await measureOffsets(o.page);
    const worst = Math.max(...offs.map((x) => Math.abs(x.off)));
    console.log(`      ${size}：配置 ${st.layout}、枠の高さ ${offs[0]?.h}px、ずれ ${offs.map((x) => `${x.id} ${x.off.toFixed(1)}`).join(' / ')}`);
    check(st.layout === 'aligned', `${size}：揃えた配置になる`);
    check(offs.length === 5 && worst <= TOLERANCE, `${size}：全チャートの枠の縦の中心が、段の平面の中心と ${TOLERANCE}px 以内で揃う（最大 ${worst.toFixed(2)}px）`);
    check(new Set(offs.map((x) => x.h)).size === 1, `${size}：5つとも同じ高さの枠`);
    const ys = await tierYs(o.page);
    const cs = await charts(o.page);
    const sorted = [...cs].sort((a, b) => a.cy - b.cy).map((c) => c.id);
    check(sorted.join() === 'shelters,transit,population,flood,elevation', `${size}：チャートは段の順（上の段が上）`);
    const axis = await o.page.evaluate(() => document.querySelector('[data-testid=section-axis]').getBoundingClientRect().top);
    check(axis >= Math.max(...cs.map((c) => c.bottom)) - 0.5, `${size}：横軸は、いちばん下のチャートの下に1つだけ（${await o.page.locator('[data-testid=section-axis]').count()} 個）`);
    check((await o.page.locator('[data-testid=section-axis]').count()) === 1, `${size}：横軸は1つ`);
    const plots = await o.page.$$eval('[data-testid=section-plot]', (els) => els.map((e) => [e.getBoundingClientRect().left, e.getBoundingClientRect().width]));
    check(plots.every((p) => Math.abs(p[0] - plots[0][0]) < 0.5 && Math.abs(p[1] - plots[0][1]) < 0.5), `${size}：全チャートで横の位置が揃う`);
    check(o.errors.length === 0, `${size}：ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
    void ys;
    await o.ctx.close();
  }

  console.log('\n[2] 間隔の変化（12 km → 20 km → 3 km → 0）');
  if (want('2')) {
    const o = await open(browser, base, QUERY);
    const { page } = o;
    const set = (v) => page.evaluate((x) => window.__store.getState().setSpacing(x), v);
    const report = async (label) => {
      await settle(page, 2500);
      const st = await stageBox(page);
      const offs = await measureOffsets(page);
      // いちばん上と下のチャートは、段が列の端に近いと、列の中へ寄せるので、ずれてよい。中の3つで測る。
      const inner = offs.filter((x) => x.id !== 'shelters' && x.id !== 'elevation');
      return { label, layout: st.layout, worst: Math.max(...inner.map((x) => Math.abs(x.off))), edge: Math.max(...offs.map((x) => Math.abs(x.off))), h: offs[0]?.h, n: offs.length };
    };
    await set(20000);
    const r20 = await report('20 km');
    console.log(`      20 km：${r20.layout}、枠 ${r20.h}px、中の3つのずれ最大 ${r20.worst.toFixed(2)}px、端を含む最大 ${r20.edge.toFixed(1)}px`);
    check(r20.layout === 'aligned' && r20.worst <= TOLERANCE, '20 km：揃った配置のまま、中のチャートは段の高さに揃う');
    await set(3000);
    const r3 = await report('3 km');
    console.log(`      3 km：${r3.layout}、枠 ${r3.h}px、ずれ最大 ${r3.worst.toFixed(1)}px`);
    check(r3.layout === 'stacked', '3 km：段が近すぎるので、縦並びになる');
    await set(0);
    const r0 = await report('0');
    check(r0.layout === 'stacked' && r0.n === 5, '間隔 0：縦並び（5つとも出る）');
    const log = transitions(await layoutLog(page));
    check(log.join('>') === 'aligned>stacked', `12→20→3→0 km の配置の変化は「揃える→縦並び」の1回だけ：${log.join('>')}`);
    // 縦並びの中身：上から順、同じ高さの枠、すべて列の中。
    const cs = await charts(page);
    const stage = await stageBox(page);
    check(cs.every((c, i) => i === 0 || c.top >= cs[i - 1].bottom) && cs.every((c) => c.top >= stage.top && c.bottom <= stage.bottom), '縦並び：上から順に重ならず、列の中に収まる');
    check(new Set(cs.map((c) => c.h)).size === 1, '縦並び：5つとも同じ高さの枠');
    await set(12000);
    await settle(page, 2500);
    check((await stageBox(page)).layout === 'aligned', '12 km へ戻すと、揃えた配置に戻る');
    check(o.errors.length === 0, `ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
    await o.ctx.close();
  }

  console.log('\n[2b] 間隔をゆっくり往復しても、境目で行き来しない（12 km → 0 → 12 km）');
  if (want('2b')) {
    const o = await open(browser, base, QUERY);
    const { page } = o;
    const down = [];
    for (let v = 12000; v >= 0; v -= 250) down.push(v);
    for (const v of down) {
      await page.evaluate((x) => window.__store.getState().setSpacing(x), v);
      await sleep(values.real ? 2500 : 140);
    }
    await settle(page, 2000);
    const afterDown = transitions(await layoutLog(page));
    check(afterDown.join('>') === 'aligned>stacked', `12→0 km の切り替えは1回：${afterDown.join('>')}`);
    for (const v of [...down].reverse()) {
      await page.evaluate((x) => window.__store.getState().setSpacing(x), v);
      await sleep(values.real ? 2500 : 140);
    }
    await settle(page, 2000);
    const all = transitions(await layoutLog(page));
    check(all.join('>') === 'aligned>stacked>aligned', `0→12 km で戻る切り替えも1回（計：${all.join('>')}）`);
    await o.ctx.close();
  }

  console.log('\n[3] 並べ替えと非表示');
  if (want('3')) {
    const o = await open(browser, base, QUERY);
    const { page } = o;
    await page.evaluate(() => window.__store.getState().moveLayer('elevation', 4)); // 標高を最上段へ
    await settle(page, 3000);
    let cs = await charts(page);
    let order = [...cs].sort((a, b) => a.cy - b.cy).map((c) => c.id);
    check(order[0] === 'elevation' && order.join() === 'elevation,shelters,transit,population,flood', `並べ替え：チャートの順番が変わる（上から ${order.join(',')}）`);
    let offs = await measureOffsets(page);
    check(Math.max(...offs.map((x) => Math.abs(x.off))) <= TOLERANCE, `並べ替え後も、チャートは段の高さに揃う（最大 ${Math.max(...offs.map((x) => Math.abs(x.off))).toFixed(2)}px）`);
    await page.evaluate(() => {
      const s = window.__store.getState();
      s.setVisible('transit', false);
      s.setVisible('population', false);
    });
    await settle(page, 3000);
    cs = await charts(page);
    check(cs.length === 3 && !cs.some((c) => c.id === 'transit' || c.id === 'population'), `非表示の段のチャートは出ない（${cs.map((c) => c.id).join(',')}）`);
    offs = await measureOffsets(page);
    check(Math.max(...offs.map((x) => Math.abs(x.off))) <= TOLERANCE, `3段でも、チャートは段の高さに揃う（最大 ${Math.max(...offs.map((x) => Math.abs(x.off))).toFixed(2)}px）`);
    await o.ctx.close();
  }

  console.log('\n[4] 揃えられないとき');
  if (want('4')) {
    const o = await open(browser, base, `${QUERY}&rx=90&ro=0`);
    check((await stageBox(o.page)).layout === 'stacked', '真上の視点：縦並び');
    await o.ctx.close();
    const so = await open(browser, base, `${QUERY}&solo=elevation`);
    const cs = await charts(so.page);
    check((await stageBox(so.page)).layout === 'stacked' && cs.length === 1, '単独表示：縦並び（そのレイヤーだけ）');
    await so.ctx.close();
    const z = await open(browser, base, QUERY);
    // 拡大して、上や下の段が列の外へはみ出すようにする（注視点を動かす）。
    await z.page.evaluate(() => {
      const s = window.__store.getState();
      s.setAutoFit(false);
      s.setViewState({ ...s.viewState, zoom: s.viewState.zoom + 0.7, target: [s.viewState.target[0], s.viewState.target[1], s.viewState.target[2] + 18000] });
    });
    await settle(z.page, 2500);
    const stage = await stageBox(z.page);
    const cs2 = await charts(z.page);
    const ys = await tierYs(z.page);
    const outside = Object.values(ys).some((y) => y < stage.top || y > stage.bottom);
    console.log(`      拡大・パン：配置 ${stage.layout}、段の y ${Object.values(ys).map((y) => Math.round(y)).join(',')}、列 ${Math.round(stage.top)}〜${Math.round(stage.bottom)}`);
    check(outside, '拡大・パンで、段が列の範囲の外へはみ出している（確認の前提）');
    check(cs2.every((c) => c.top >= stage.top - 0.5 && c.bottom <= stage.bottom + 0.5), '段がはみ出しても、チャートは列の中に収まる');
    check(cs2.every((c, i) => i === 0 || c.top >= cs2[i - 1].bottom - 0.5), 'チャートどうしは重ならない');
    await z.ctx.close();
  }

  console.log('\n[5] カーソルを置いたときの連動');
  if (want('5')) {
    const o = await open(browser, base, QUERY);
    const { page } = o;
    const ys = await tierYs(page);
    const base0 = await bandBrightness(page, ys);
    const cs = await charts(page);
    const target = cs.find((c) => c.id === 'population');
    const plot = await page.evaluate(() => {
      const r = document.querySelector('[data-testid=section-chart][data-layer=population] [data-testid=section-plot]').getBoundingClientRect();
      return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 };
    });
    await page.mouse.move(plot.x - 6, plot.y);
    await page.mouse.move(plot.x, plot.y);
    await waitFor(page, () => window.__store.getState().sectionFocus !== null);
    await settle(page, 2000);
    const f = await page.evaluate(() => window.__store.getState().sectionFocus);
    check(f?.id === 'population' && f?.from === 'chart', `人口のチャートにカーソル：目立たせる段は人口（${JSON.stringify(f)}）`);
    const dim = await bandBrightness(page, ys);
    const ratio = Object.fromEntries(Object.keys(ys).map((id) => [id, dim[id] / base0[id]]));
    console.log(`      明るさの比（暗くしたとき / 通常）：${Object.entries(ratio).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' / ')}`);
    check(ratio.population > 0.9, `対応する段（人口）はそのまま（${ratio.population.toFixed(2)}）`);
    check(['elevation', 'flood', 'transit', 'shelters'].every((id) => ratio[id] < 0.8), 'ほかの段は暗くなる');
    check((await page.locator('[data-testid=section-chart][data-layer=population][data-hot]').count()) === 1, '人口のチャートの枠が強調される');
    check((await page.locator('[data-testid=section-cursor]').count()) === 5, '全チャート共通の縦の線は保たれる');
    void target;
    await page.mouse.move(40, 40);
    await waitFor(page, () => window.__store.getState().sectionFocus === null);
    await settle(page, 2000);
    const back = await bandBrightness(page, ys);
    check(Object.keys(ys).every((id) => Math.abs(back[id] / base0[id] - 1) < 0.03), `カーソルを外すと元に戻る（比 ${Object.keys(ys).map((id) => (back[id] / base0[id]).toFixed(2)).join(',')}）`);

    // 全体の地図 → チャート
    const P = await page.evaluate(() => {
      const s = window.__store.getState();
      const r = document.querySelector('canvas').getBoundingClientRect();
      return { line: s.section, vs: s.viewState, spacing: s.spacing, left: r.left, top: r.top, w: r.width, h: r.height };
    });
    const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: P.w, height: P.h, viewState: P.vs });
    const zTr = 3 * P.spacing; // 公共交通（下から4段目）
    const at = (t) => vp.project([P.line.ax + (P.line.bx - P.line.ax) * t, P.line.ay + (P.line.by - P.line.ay) * t, zTr]);
    const [mx, my] = at(0.6);
    await page.mouse.move(P.left + mx - 8, P.top + my);
    await page.mouse.move(P.left + mx, P.top + my);
    await waitFor(page, () => window.__store.getState().sectionFocus !== null);
    await settle(page, 800);
    const f2 = await page.evaluate(() => window.__store.getState().sectionFocus);
    check(f2?.id === 'transit' && f2?.from === 'map', `地図の公共交通の切り口の近く：対応するチャートが目立つ（${JSON.stringify(f2)}）`);
    check((await page.locator('[data-testid=section-chart][data-layer=transit][data-hot]').count()) === 1, '公共交通のチャートが強調される');
    const dim2 = await bandBrightness(page, ys);
    check(Object.keys(ys).every((id) => Math.abs(dim2[id] / base0[id] - 1) < 0.05), '地図の側は暗くしない（カーソルのある地図の見た目は変えない）');
    await page.mouse.move(40, 40);
    await waitFor(page, () => window.__store.getState().sectionFocus === null);
    check((await page.locator('[data-hot]').count()) === 0, 'カーソルを外すと、強調が消える');
    check(o.errors.length === 0, `ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
    await o.ctx.close();
  }
}

let browser;
try {
  const base = await baseUrl();
  browser = await chromium.launch();
  await run(browser, base);
} finally {
  await browser?.close().catch(() => {});
}
console.log(failures.length === 0 ? '\nすべて合格' : `\n不合格 ${failures.length} 件:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
