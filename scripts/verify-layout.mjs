#!/usr/bin/env node
// 画面の配置と操作の確認（実データ向け）。
//   node scripts/verify-layout.mjs [--url http://127.0.0.1:5173/] [--sizes 1400x1000,2000x1100,1000x700]
// --url がなければ Vite を起動する。確認すること：
//   1. 固定前・カーソルを置いた状態・固定後・解除後で、viewState の zoom と target が一致する（URL で固定して開いた場合も同じ）
//   2. 右の列の中身が状態に応じて変わる（23区全体のまとめ／手がかり／区名と「この地点」／クローズアップと3列の表）
//   3. 固定した印のドラッグ、クローズアップの中のクリック、半径の切り替え、Esc と「全体」の選択での解除が動く
//   4. 「断面」（URL の section= で開く）でも、全体の地図の大きさと位置が変わらない。線を消す・「地点」へ戻す・「断面」へ戻すでも同じ
// 1つでも外れれば、内容を表示して終了コード 1 で終わる。描画が遅い環境（1フレーム約2秒）を見込んで、待ちは長めにとる。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    sizes: { type: 'string', default: '1400x1000,2000x1100,1000x700' },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? '  ok ' : '  NG '} ${msg}`);
  if (!ok) failures.push(msg);
};

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
  vite = spawn(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
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

const EPS = 1e-9;
const sameView = (a, b) => Math.abs(a.zoom - b.zoom) < EPS && a.target.every((v, i) => Math.abs(v - b.target[i]) < 1e-6);
const fmt = (v) => `zoom=${v.zoom.toFixed(6)} target=[${v.target.map((t) => t.toFixed(1)).join(', ')}]`;

const getState = (page) =>
  page.evaluate(() => {
    const s = window.__store.getState();
    return { view: s.viewState, probe: s.probe, pinned: s.probePinned, radius: s.closeupRadius };
  });
const mode = (page) => page.getAttribute('[data-testid=info-column]', 'data-mode');
/** 描画が追いつく（2フレーム）まで待つ。 */
const settle = async (page, ms = 1500) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
};
const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

async function open(browser, base, size, query = '') {
  const [w, h] = size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + query, { waitUntil: 'load' });
  await waitFor(page, () => window.__ready === true);
  await settle(page, 2500);
  return { ctx, page, errors, w, h };
}

/** 最上段の平面の、東京駅付近（23区の中）の画面上の位置。 */
async function topPlanePoint(page) {
  const info = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    const s = window.__store.getState();
    return { left: r.left, top: r.top, width: r.width, height: r.height, vs: s.viewState, spacing: s.spacing };
  });
  const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: info.width, height: info.height, viewState: info.vs });
  const [x, y] = vp.project([1550, 130, 4 * info.spacing]);
  return [Math.round(info.left + x), Math.round(info.top + y)];
}

async function viewConsistency(browser, base, size) {
  console.log(`\n[${size}] 固定前・カーソルを置いた状態・固定後・解除後の視点`);
  const { ctx, page, errors } = await open(browser, base, size);
  const v0 = (await getState(page)).view;
  check((await mode(page)) === 'overview' && (await page.getAttribute('[data-testid=mode-overview]', 'aria-pressed')) === 'true', `開いた直後：「全体」が選ばれ、列は23区全体のまとめ（mode=overview）。${fmt(v0)}`);
  check((await page.isVisible('[data-testid=overall]')) && (await page.locator('[data-testid=info-hint]').count()) === 0, '開いた直後：23区全体の集計が見え、操作の説明文は出ていない');

  // 「全体」では、カーソルを置いても探針は出ず、クリックしても固定されない
  const [ox, oy] = await topPlanePoint(page);
  await page.mouse.move(ox, oy);
  await page.mouse.move(ox + 1, oy + 1);
  await page.mouse.move(ox, oy);
  await settle(page, 800);
  await page.mouse.click(ox, oy);
  await settle(page, 800);
  const so = await getState(page);
  check(so.probe === null && !so.pinned && (await mode(page)) === 'overview', '「全体」：カーソルを置いても探針は出ず、クリックしても固定されない');
  check(sameView(v0, so.view), '「全体」で操作しても、視点は変わらない');

  // 「地点」を選ぶと、手がかりの1行だけが出る
  await page.getByTestId('mode-point').click();
  await settle(page, 800);
  check((await mode(page)) === 'empty' && (await page.textContent('[data-testid=point-hint]')) === '地図をクリックして地点を選ぶ', '「地点」を選んだ直後：列は手がかりの1行だけ（23区全体のまとめは出ない）');
  check((await page.locator('[data-testid=overall]').count()) === 0, '「地点」を選んだ直後：23区全体のまとめは出ていない');

  const [hx, hy] = await topPlanePoint(page);
  await page.mouse.move(hx, hy);
  await page.mouse.move(hx + 1, hy + 1);
  await page.mouse.move(hx, hy);
  await waitFor(page, () => window.__store.getState().probe !== null);
  await settle(page);
  const s1 = await getState(page);
  check((await mode(page)) === 'hover' && !s1.pinned, 'カーソルを置いた：列は区名と「この地点」（mode=hover）');
  check(sameView(v0, s1.view), `カーソルを置いた状態の視点が固定前と一致。${fmt(s1.view)}`);
  check((await page.locator('[data-testid=info-row]').count()) === 5 && (await page.getAttribute('[data-testid=info-table]', 'data-columns')) === '1', 'カーソルを置いた：5レイヤーの行（この地点の値だけ）');
  check((await page.locator('[data-testid=info-row-body]').count()) === 0, 'カーソルを置いた：行は、初期状態ではすべて閉じている');
  const c1 = await page.textContent('[data-testid=info-column] .ic-coords');

  await page.mouse.move(hx + 30, hy + 20);
  await waitFor(page, (p) => { const q = window.__store.getState().probe; return q !== null && q.x !== p.x; }, s1.probe);
  await settle(page, 500);
  const c2 = await page.textContent('[data-testid=info-column] .ic-coords');
  check(c1 !== c2, `カーソルを動かすと値が追従する（${c1} → ${c2}）`);

  await page.mouse.click(hx + 30, hy + 20);
  await waitFor(page, () => window.__store.getState().probePinned);
  await settle(page, 3000);
  const s2 = await getState(page);
  check((await mode(page)) === 'pinned', '固定後：列はクローズアップと表（mode=pinned）');
  check(sameView(v0, s2.view), `固定後の視点が固定前と一致。${fmt(s2.view)}`);
  check((await page.getAttribute('[data-testid=info-table]', 'data-columns')) === '2', '固定後：行を開くと、この地点の値と、半径 ○ km 内の集計が出る（data-columns=2）');
  check((await page.locator('[data-testid=info-row-body]').count()) === 0, '固定後：行は、初期状態ではすべて閉じている');
  check(await page.isVisible('[data-testid=closeup]'), '固定後：クローズアップが見える');
  const rows = await page.locator('[data-testid=info-row]').count();
  check(rows === 5, `固定後：5レイヤーの行がある（${rows}）`);
  const mains = await page.$$eval('[data-testid=info-row-main]', (els) => els.map((e) => e.textContent.trim()));
  check(mains.length === 5 && mains.every((t) => t.length > 0), `固定後：閉じた行に、この地点の主な値が1つずつ出る（${mains.join(' / ')}）`);
  await page.click('[data-testid=info-row-toggle-population]');
  check((await page.textContent('[data-testid=info-area-title]')) === '半径 2 km 内', '人口の行を開くと、「半径 2 km 内」の集計が出る');
  await page.click('[data-testid=info-row-toggle-transit]');
  check((await page.locator('[data-testid=info-row-body]').count()) === 1 && (await page.getAttribute('[data-testid=info-row-toggle-population]', 'aria-expanded')) === 'false', '別の行を開くと、開いていた行は閉じる（同時に開けるのは1つ）');
  await page.click('[data-testid=info-row-toggle-transit]');
  check((await page.locator('[data-testid=info-row-body]').count()) === 0, '開いている行をもう一度押すと閉じる');

  await page.keyboard.press('Escape');
  await waitFor(page, () => !window.__store.getState().probePinned);
  await settle(page, 1500);
  const s3 = await getState(page);
  check(sameView(v0, s3.view), `解除後の視点が固定前と一致。${fmt(s3.view)}`);
  check(s3.probe === null && (await mode(page)) === 'overview' && (await page.isVisible('[data-testid=overall]')), '解除後：探針が消え、「全体」に戻って、列は23区全体の集計に戻る');
  check(errors.length === 0, `ブラウザのエラーなし${errors.length ? `：${errors[0]}` : ''}`);
  await ctx.close();

  // URL で固定して開いた場合も、同じ視点
  for (const q of ['?probe=8172,-1342&radius=5000', '?probe=1550,130']) {
    const o = await open(browser, base, size, q);
    const st = await getState(o.page);
    check(sameView(v0, st.view) && st.pinned, `${q} で開いた視点が固定前と一致。${fmt(st.view)}`);
    check((await mode(o.page)) === 'pinned', `${q}：列は固定中の中身`);
    check(o.errors.length === 0, `${q}：ブラウザのエラーなし`);
    await o.ctx.close();
  }

  // 断面：線があるときも、モードを切り替えても、線を消しても、同じ視点
  const sq = '?section=-15000,-2000,14000,-2000';
  const o = await open(browser, base, size, sq);
  const st0 = await getState(o.page);
  check(sameView(v0, st0.view), `${sq} で開いた視点が、断面なしと一致。${fmt(st0.view)}`);
  check((await o.page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'section', `${sq}：右の列は断面の中身`);
  check((await o.page.locator('[data-testid=section-chart]').count()) === 5, `${sq}：右の列に5つのグラフが並ぶ`);
  const rect = await o.page.evaluate(() => {
    const b = document.querySelector('[data-testid=info-column]').getBoundingClientRect();
    return { w: b.width, top: b.top, bottom: b.bottom, vh: window.innerHeight };
  });
  check(rect.top === 0 && rect.bottom === rect.vh, '断面：右の列は画面の高さいっぱい');
  await o.page.getByTestId('mode-point').click();
  await settle(o.page, 1000);
  check(sameView(v0, (await getState(o.page)).view), '「地点」へ切り替えても、視点は同じ');
  check((await o.page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'empty', '「地点」へ切り替えると、右の列は手がかりの1行（探針なし）');
  await o.page.getByTestId('mode-section').click();
  await settle(o.page, 1000);
  check(sameView(v0, (await getState(o.page)).view), '「断面」へ戻しても、視点は同じ');
  await o.page.keyboard.press('Escape');
  await waitFor(o.page, () => window.__store.getState().section === null);
  await settle(o.page, 1000);
  check(sameView(v0, (await getState(o.page)).view), 'Esc で線を消しても、視点は同じ');
  check((await o.page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'overview', 'Esc で、「全体」に戻る');
  check(o.errors.length === 0, `断面：ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
  const widths = [rect.w];
  check(widths[0] === (await o.page.evaluate(() => document.querySelector('[data-testid=info-column]').getBoundingClientRect().width)), '右の列の幅は、モードによらず一定');
  await o.ctx.close();
}

async function interactions(browser, base, size) {
  console.log(`\n[${size}] 固定した印のドラッグ・クローズアップの中のクリック・半径・解除`);
  const { ctx, page, errors } = await open(browser, base, size, '?probe=1550,130');
  const s0 = await getState(page);

  // 1. 固定した印（真ん中の段の輪）をドラッグ
  const info = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    const s = window.__store.getState();
    return { left: r.left, top: r.top, width: r.width, height: r.height, vs: s.viewState, probe: s.probe, spacing: s.spacing };
  });
  const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: info.width, height: info.height, viewState: info.vs });
  const [rx, ry] = vp.project([info.probe.x, info.probe.y, 2 * info.spacing]);
  const mx = info.left + rx;
  const my = info.top + ry;
  await page.mouse.move(mx, my);
  await sleep(300);
  await page.mouse.down();
  await page.mouse.move(mx - 90, my + 40, { steps: 10 });
  await page.mouse.up();
  await waitFor(page, (b) => {
    const p = window.__store.getState().probe;
    return p !== null && (p.x !== b.x || p.y !== b.y);
  }, s0.probe);
  await settle(page, 2500);
  const s1 = await getState(page);
  check(Math.hypot(s1.probe.x - s0.probe.x, s1.probe.y - s0.probe.y) > 500, `印のドラッグで中心が動く（${Math.round(s0.probe.x)},${Math.round(s0.probe.y)} → ${Math.round(s1.probe.x)},${Math.round(s1.probe.y)}）`);
  check(sameView(s0.view, s1.view) && s1.view.rotationOrbit === s0.view.rotationOrbit && s1.view.rotationX === s0.view.rotationX, 'ドラッグしても視点は回らず、大きさも位置も変わらない');
  check(s1.pinned && (await mode(page)) === 'pinned', 'ドラッグ後も固定中');
  const coords1 = await page.textContent('[data-testid=info-coords]');
  check(coords1.includes(Math.round(s1.probe.x).toLocaleString('ja-JP')), `右の列の座標が追従する（${coords1}）`);

  // 2. クローズアップの中をクリック（円の中心から 30 px。クローズアップの円は、表が長いぶん、直径が約 190 px）
  const box = await page.evaluate(() => {
    const r = document.querySelector('.cu-canvas').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x + 30, box.y);
  await waitFor(page, (b) => {
    const p = window.__store.getState().probe;
    return p !== null && (p.x !== b.x || p.y !== b.y);
  }, s1.probe);
  await settle(page, 2500);
  const s2 = await getState(page);
  const moved = Math.hypot(s2.probe.x - s1.probe.x, s2.probe.y - s1.probe.y);
  check(moved > 300 && moved < 3000, `クローズアップの中のクリックで中心が動く（${Math.round(moved)} m）`);
  check(sameView(s0.view, s2.view), 'クリック後も全体の地図の視点は変わらない');

  // 3. 半径の切り替え
  await page.click('[data-testid=info-row-toggle-population]');
  const area = () => page.textContent('[data-testid=info-area-title]');
  await page.getByRole('button', { name: '5 km', exact: true }).click();
  await waitFor(page, () => window.__store.getState().closeupRadius === 5000);
  await settle(page, 2500);
  check((await area()) === '半径 5 km 内', '半径 5 km：表の見出しが「半径 5 km 内」');
  await page.getByRole('button', { name: '1 km', exact: true }).click();
  await waitFor(page, () => window.__store.getState().closeupRadius === 1000);
  await settle(page, 2000);
  check((await area()) === '半径 1 km 内', '半径 1 km：表の見出しが「半径 1 km 内」');
  check(sameView(s0.view, (await getState(page)).view), '半径を切り替えても全体の地図の視点は変わらない');

  // 4. Esc で解除
  await page.keyboard.press('Escape');
  await waitFor(page, () => !window.__store.getState().probePinned);
  await settle(page, 1500);
  const s4 = await getState(page);
  check(s4.probe === null && (await mode(page)) === 'overview', 'Esc で解除でき、「全体」に戻る');

  // 5. 「全体」を選んで解除（「地点」を選んで、もう一度固定してから）
  await page.getByTestId('mode-point').click();
  const [px, py] = await topPlanePoint(page);
  await page.mouse.move(px, py);
  await page.mouse.move(px + 1, py + 1);
  await page.mouse.move(px, py);
  await waitFor(page, () => window.__store.getState().probe !== null);
  await page.mouse.click(px, py);
  await waitFor(page, () => window.__store.getState().probePinned);
  await settle(page, 2500);
  check((await mode(page)) === 'pinned', '再び固定できる');
  check((await page.getByRole('button', { name: '消す', exact: true }).count()) === 0, '「消す」ボタンはない');
  await page.getByTestId('mode-overview').click();
  await waitFor(page, () => !window.__store.getState().probePinned);
  await settle(page, 1000);
  const s5 = await getState(page);
  check(s5.probe === null && (await mode(page)) === 'overview', '「全体」を選ぶと、固定が消えて「全体」に戻る');
  check(sameView(s0.view, s5.view), '解除後も視点は変わらない');

  // 6. 配置：列と右上のパネルが重ならず、列は画面の高さいっぱい
  const rects = await page.evaluate(() => {
    const r = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    return { column: r('[data-testid=info-column]'), vw: window.innerWidth, vh: window.innerHeight };
  });
  check(rects.column.top === 0 && rects.column.bottom === rects.vh, '右の列は画面の高さいっぱい');
  check(rects.column.right <= rects.vw - 256 + 1, '右の列は右上のパネルと重ならない');
  check(errors.length === 0, `ブラウザのエラーなし${errors.length ? `：${errors[0]}` : ''}`);
  await ctx.close();
}

let browser;
try {
  const base = await baseUrl();
  browser = await chromium.launch();
  const sizes = values.sizes.split(',');
  for (const size of sizes) await viewConsistency(browser, base, size);
  await interactions(browser, base, sizes[0]);
} finally {
  await browser?.close().catch(() => {});
}
console.log(failures.length === 0 ? '\nすべて合格' : `\n不合格 ${failures.length} 件:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
process.exit(failures.length === 0 ? 0 : 1);
