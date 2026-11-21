#!/usr/bin/env node
// 「断面」の操作の確認（仮データ）。
//   node scripts/verify-section.mjs [--url http://127.0.0.1:5173/] [--size 1400x1000]
// --url がなければ Vite を起動する。確認すること：
//   1. 「断面」に切り替えて、平面を2回クリックすると線が引ける（始点を置くと、下書きの線が出る）
//   2. 端点のドラッグで、その端点だけが動き、右の列のグラフが変わる。線のドラッグで、線全体が平行に動く
//   3. 線の外からのドラッグは視点の回転（線は変わらない）
//   4. 右の列のグラフにカーソルを置くと、全体の地図の、線の上の対応する地点に、水色の垂直線が出る（画面の画素の色で突き合わせる）。
//      逆に、全体の地図の線の上にカーソルを置くと、右のグラフの同じ位置に縦線が出る
//   5. Esc で線が消える。「地点」へ切り替えても線と固定した探針は保持され、探針とクローズアップはこれまでどおり動く。URL の section= で開ける
//   6. 全体の地図の大きさと位置（viewState の zoom と target）が、断面の有無・モードで変わらない
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

const { values } = parseArgs({ options: { url: { type: 'string' }, size: { type: 'string', default: '1400x1000' } } });
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
const waitFor = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const settle = async (page, ms = 1000) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
};
const state = (page) =>
  page.evaluate(() => {
    const s = window.__store.getState();
    return { mode: s.mode, line: s.section, start: s.sectionStart, hover: s.sectionHover, probe: s.probe, pinned: s.probePinned, view: s.viewState, spacing: s.spacing };
  });

/** 全体の地図の画面の変換と、canvas の位置。 */
async function projector(page) {
  const info = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    const s = window.__store.getState();
    return { left: r.left, top: r.top, width: r.width, height: r.height, vs: s.viewState, spacing: s.spacing };
  });
  const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: info.width, height: info.height, viewState: info.vs });
  return { spacing: info.spacing, at: (x, y, z) => { const [px, py] = vp.project([x, y, z]); return [info.left + px, info.top + py]; } };
}

/** 画面の (cx, cy) の近く（±r px）に、水色（探針の色）の画素があるか。 */
async function hasCyanNear(page, cx, cy, r = 4) {
  const buf = await page.screenshot();
  const png = PNG.sync.read(buf);
  for (let y = Math.max(0, Math.round(cy) - r); y <= Math.min(png.height - 1, Math.round(cy) + r); y++) {
    for (let x = Math.max(0, Math.round(cx) - r); x <= Math.min(png.width - 1, Math.round(cx) + r); x++) {
      const i = (y * png.width + x) * 4;
      const [R, G, B] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      if (Math.abs(R - 90) < 30 && Math.abs(G - 220) < 30 && Math.abs(B - 255) < 25) return true;
    }
  }
  return false;
}

const chartCount = (page) => page.locator('[data-testid=section-chart]').count();
const length = (page) => page.textContent('[data-testid=section-length]');

async function open(browser, base, query = '?data=fixture') {
  const [w, h] = values.size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + query, { waitUntil: 'load' });
  await waitFor(page, () => window.__ready === true);
  await settle(page, 1500);
  return { ctx, page, errors };
}

async function run(browser, base) {
  console.log('\n[1] 線を引く');
  const { ctx, page, errors } = await open(browser, base);
  const v0 = (await state(page)).view;
  const P = await projector(page);
  const zTop = 4 * P.spacing;
  const zMid = 2 * P.spacing;
  check((await state(page)).mode === 'point', '開いたときは「地点」');
  await page.getByTestId('mode-section').click();
  await waitFor(page, () => window.__store.getState().mode === 'section');
  check(await page.isVisible('[data-testid=section-hint]'), '「断面」に切り替えると、操作の手がかりが出る');
  check((await page.getByTestId('mode-section').getAttribute('aria-pressed')) === 'true', '「断面」が選択中の見た目');

  const [ax, ay] = P.at(-7000, -3000, zTop);
  const [bx, by] = P.at(6000, 4000, zTop);
  await page.mouse.move(ax, ay);
  await page.mouse.move(ax + 1, ay + 1);
  await page.mouse.click(ax, ay);
  await waitFor(page, () => window.__store.getState().sectionStart !== null);
  check((await page.getAttribute('[data-testid=section-hint]', 'data-state')) === 'start', '1回クリック：始点が決まり、終点を待つ');
  await page.mouse.move(bx - 40, by - 20);
  await page.mouse.move(bx, by);
  await waitFor(page, () => window.__store.getState().sectionCursor !== null);
  await settle(page, 500);
  check((await state(page)).line === null, '始点だけのあいだは、線はまだない（下書きだけ）');
  await page.mouse.click(bx, by);
  await waitFor(page, () => window.__store.getState().section !== null);
  await settle(page, 1500);
  let s = await state(page);
  check(s.line !== null && s.start === null, '2回クリック：線が決まる');
  check((await chartCount(page)) === 5, `右の列に5レイヤーのグラフが並ぶ（${await chartCount(page)}）`);
  const order = await page.$$eval('[data-testid=section-chart]', (els) => els.map((e) => e.getAttribute('data-layer')));
  check(order.join() === 'facilities,transit,roads,population,elevation', `グラフは全体の地図の段の順（上の段が上）：${order.join(',')}`);
  const len0 = await length(page);
  console.log(`      線：(${Math.round(s.line.ax)},${Math.round(s.line.ay)}) → (${Math.round(s.line.bx)},${Math.round(s.line.by)}) 長さ ${len0}`);
  const sums = await page.$$eval('[data-testid=section-summary]', (els) => els.map((e) => e.textContent));
  check(sums.every((t) => t && t.length > 3), `各グラフに要約がある：${sums.join(' / ')}`);
  check((await page.textContent('[data-testid=section-ends]')).includes('A') && (await page.textContent('[data-testid=section-ends]')).includes('B'), '見出しに始点 A・終点 B の区名の欄がある');
  const z1 = (await state(page)).view;
  check(Math.abs(z1.zoom - v0.zoom) < 1e-9 && z1.target.every((t, i) => Math.abs(t - v0.target[i]) < 1e-6), '線を引いても、全体の地図の大きさと位置は変わらない');

  console.log('\n[2] 端点と線のドラッグ');
  const line0 = s.line;
  const [ex, ey] = P.at(line0.bx, line0.by, zMid);
  await page.mouse.move(ex, ey);
  await sleep(300);
  await page.mouse.down();
  await page.mouse.move(ex - 40, ey - 30, { steps: 8 });
  await page.mouse.up();
  await waitFor(page, (b) => { const l = window.__store.getState().section; return l && (l.bx !== b.bx || l.by !== b.by); }, line0);
  await settle(page, 1500);
  s = await state(page);
  check(s.line.ax === line0.ax && s.line.ay === line0.ay, '終点 B のドラッグ：始点 A は動かない');
  check(Math.hypot(s.line.bx - line0.bx, s.line.by - line0.by) > 500, `終点 B が動く（${Math.round(line0.bx)},${Math.round(line0.by)} → ${Math.round(s.line.bx)},${Math.round(s.line.by)}）`);
  check((await length(page)) !== len0, `右の列の長さが変わる（${len0} → ${await length(page)}）`);
  check(s.view.rotationOrbit === v0.rotationOrbit && s.view.rotationX === v0.rotationX, '端点のドラッグでは視点は回らない');

  const line1 = s.line;
  const [mx, my] = P.at((line1.ax + line1.bx) / 2, (line1.ay + line1.by) / 2, zMid);
  await page.mouse.move(mx, my);
  await sleep(300);
  await page.mouse.down();
  await page.mouse.move(mx + 60, my + 20, { steps: 8 });
  await page.mouse.up();
  await waitFor(page, (b) => { const l = window.__store.getState().section; return l && (l.ax !== b.ax || l.ay !== b.ay); }, line1);
  await settle(page, 1500);
  s = await state(page);
  const dA = [s.line.ax - line1.ax, s.line.ay - line1.ay];
  const dB = [s.line.bx - line1.bx, s.line.by - line1.by];
  check(Math.hypot(...dA) > 500 && Math.abs(dA[0] - dB[0]) < 1 && Math.abs(dA[1] - dB[1]) < 1, `線のドラッグ：両端が同じだけ平行に動く（Δ=${Math.round(dA[0])},${Math.round(dA[1])}）`);
  check(s.view.rotationOrbit === v0.rotationOrbit, '線のドラッグでは視点は回らない');

  console.log('\n[3] 線の外からのドラッグは視点の回転');
  const line2 = s.line;
  const [ox, oy] = P.at(-11000, 9000, zTop); // 線から離れた平面の上
  await page.mouse.move(ox, oy);
  await sleep(200);
  await page.mouse.down();
  await page.mouse.move(ox + 80, oy, { steps: 8 });
  await page.mouse.up();
  await settle(page, 1500);
  s = await state(page);
  check(Math.abs(s.view.rotationOrbit - v0.rotationOrbit) > 1, `視点が回る（方位 ${v0.rotationOrbit} → ${s.view.rotationOrbit.toFixed(1)}）`);
  check(JSON.stringify(s.line) === JSON.stringify(line2), '線は変わらない');
  check(s.line !== null && (await state(page)).start === null, '回したあとのクリック相当の誤動作（始点の置き直し）がない');

  console.log('\n[4] 連動：右のグラフ → 全体の地図');
  // 視点を回した後なので、変換を取り直す。
  const P2 = await projector(page);
  const lineH = (await state(page)).line;
  const len = Math.hypot(lineH.bx - lineH.ax, lineH.by - lineH.ay);
  const plot = await page.evaluate(() => {
    const r = document.querySelector('[data-testid=section-plot]').getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2, w: r.width };
  });
  await page.mouse.move(plot.x + plot.w * 0.38, plot.y);
  await page.mouse.move(plot.x + plot.w * 0.4, plot.y);
  await waitFor(page, () => window.__store.getState().sectionHover !== null);
  await settle(page, 1500);
  const hv = (await state(page)).hover;
  check(Math.abs(hv - 0.4 * len) < 0.02 * len, `グラフの 40% の位置 → 線に沿った距離 ${Math.round(hv)} m（線の長さ ${Math.round(len)} m の 40% ± 2%）`);
  const px = lineH.ax + ((lineH.bx - lineH.ax) * hv) / len;
  const py = lineH.ay + ((lineH.by - lineH.ay) * hv) / len;
  const [sx, sy] = P2.at(px, py, zMid);
  check(await hasCyanNear(page, sx, sy), `全体の地図に、線の上の対応する地点（${Math.round(px)},${Math.round(py)}）に水色の印が出る（画面 ${Math.round(sx)},${Math.round(sy)}）`);
  const qx = lineH.ax + (lineH.bx - lineH.ax) * 0.85;
  const qy = lineH.ay + (lineH.by - lineH.ay) * 0.85;
  const [fx, fy] = P2.at(qx, qy, zMid);
  check(!(await hasCyanNear(page, fx, fy)), '対応しない地点（線の 85% の位置）には水色の印がない');
  const cursors = await page.locator('[data-testid=section-cursor]').count();
  check(cursors === 5, `全グラフに共通の縦の線が出る（${cursors} 本）`);
  const reads = await page.$$eval('[data-testid=section-readout]', (els) => els.map((e) => e.textContent));
  check(reads.some((t) => t && t.length > 0), `見出しの右に、その位置の値が読める：${reads.join(' / ')}`);
  await page.mouse.move(plot.x - 30, plot.y);
  await waitFor(page, () => window.__store.getState().sectionHover === null);
  check((await page.locator('[data-testid=section-cursor]').count()) === 0, 'グラフの外へ出ると、縦の線は消える');

  console.log('\n[4b] 連動：全体の地図 → 右のグラフ');
  const [tx, ty] = P2.at(lineH.ax + (lineH.bx - lineH.ax) * 0.7, lineH.ay + (lineH.by - lineH.ay) * 0.7, zMid);
  await page.mouse.move(tx - 8, ty);
  await page.mouse.move(tx, ty);
  await waitFor(page, () => window.__store.getState().sectionHover !== null);
  await settle(page, 800);
  const hv2 = (await state(page)).hover;
  check(Math.abs(hv2 - 0.7 * len) < 0.03 * len, `地図の線の 70% の位置 → 線に沿った距離 ${Math.round(hv2)} m`);
  check((await page.locator('[data-testid=section-cursor]').count()) === 5, '右のグラフの全段に縦の線が出る');
  const cx = await page.$eval('[data-testid=section-chart][data-layer=elevation] [data-testid=section-cursor]', (e) => Number(e.getAttribute('x1')));
  check(Math.abs((cx - 58) / (plot.w) - 0.7) < 0.03, `縦の線がグラフの 70% の位置にある（${((cx - 58) / plot.w * 100).toFixed(1)}%）`);
  await page.mouse.move(40, 40);
  await waitFor(page, () => window.__store.getState().sectionHover === null);

  console.log('\n[5] 引き直し、Esc と、「地点」との往復');
  // 端点の外をクリックすると、新しい線の引き直し（いまの線は消え、そこが新しい始点）
  const Pr = await projector(page);
  const [rx1, ry1] = Pr.at(-9000, 7000, zTop);
  const [rx2, ry2] = Pr.at(3000, 8000, zTop);
  await page.mouse.move(rx1, ry1);
  await page.mouse.click(rx1, ry1);
  await waitFor(page, () => window.__store.getState().sectionStart !== null);
  s = await state(page);
  check(s.line === null && s.start !== null, '端点の外をクリック：いまの線が消え、そこが新しい始点になる（引き直し）');
  await page.mouse.move(rx2, ry2);
  await page.mouse.click(rx2, ry2);
  await waitFor(page, () => window.__store.getState().section !== null);
  s = await state(page);
  check(s.line !== null && Math.abs(s.line.ax - s.line.bx) > 1000, '次のクリックで、新しい線が決まる');
  await settle(page, 800);
  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__store.getState().section === null);
  await settle(page, 800);
  check(await page.isVisible('[data-testid=section-hint]'), 'Esc で線が消え、手がかりに戻る');
  check((await chartCount(page)) === 0, 'グラフも消える');

  // もう一度、線を引き、固定した探針を置いてから往復する。
  const P3 = await projector(page);
  const [cx1, cy1] = P3.at(-6000, 2000, zTop);
  const [cx2, cy2] = P3.at(5000, -2000, zTop);
  await page.mouse.move(cx1, cy1);
  await page.mouse.click(cx1, cy1);
  await page.mouse.move(cx2, cy2);
  await page.mouse.click(cx2, cy2);
  await waitFor(page, () => window.__store.getState().section !== null);
  await settle(page, 1000);
  const lineKeep = (await state(page)).line;
  await page.getByTestId('mode-point').click();
  await waitFor(page, () => window.__store.getState().mode === 'point');
  await settle(page, 1000);
  s = await state(page);
  check(JSON.stringify(s.line) === JSON.stringify(lineKeep), '「地点」へ切り替えても、線は消さずに保持する');
  check((await page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'empty', '「地点」：右の列は手がかり（探針なし）');
  const [hx, hy] = P3.at(1000, 1000, zTop);
  await page.mouse.move(hx, hy);
  await page.mouse.move(hx + 1, hy + 1);
  await page.mouse.move(hx, hy);
  await waitFor(page, () => window.__store.getState().probe !== null);
  check((await page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'hover', '「地点」：カーソルを置くと、探針と値が出る');
  await page.mouse.click(hx, hy);
  await waitFor(page, () => window.__store.getState().probePinned);
  await settle(page, 2500);
  check((await page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'pinned' && (await page.isVisible('[data-testid=closeup]')), '「地点」：クリックで固定すると、クローズアップが出る');
  const pinned = (await state(page)).probe;
  await page.getByTestId('mode-section').click();
  await waitFor(page, () => window.__store.getState().mode === 'section');
  await settle(page, 1500);
  s = await state(page);
  check(JSON.stringify(s.line) === JSON.stringify(lineKeep) && (await chartCount(page)) === 5, '「断面」へ戻すと、線とグラフが再び出る');
  check(s.pinned && JSON.stringify(s.probe) === JSON.stringify(pinned), '地点の固定は、「断面」のあいだも保持している');
  // 「断面」の Esc は線を消す操作。保持している固定した探針は、解除しない。
  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__store.getState().section === null);
  s = await state(page);
  check(s.pinned && s.probe !== null, '「断面」で Esc を押しても、保持している固定した探針は解除されない');
  await page.getByTestId('mode-point').click();
  await waitFor(page, () => window.__store.getState().mode === 'point');
  await settle(page, 1500);
  check((await page.getAttribute('[data-testid=info-column]', 'data-mode')) === 'pinned', '「地点」へ戻すと、固定した探針とクローズアップが残っている');
  check(errors.length === 0, `ブラウザのエラーなし${errors.length ? `：${errors[0]}` : ''}`);
  await ctx.close();

  console.log('\n[6] URL の section= と、大きさ・位置');
  const o = await open(browser, base, '?data=fixture&section=-7000,-3000,6000,4000');
  const so = await state(o.page);
  check(so.mode === 'section' && so.line !== null, 'section= で開くと、「断面」に切り替わり、線が引かれている');
  check((await chartCount(o.page)) === 5, '右の列にグラフが並ぶ');
  check(Math.abs(so.view.zoom - v0.zoom) < 1e-9 && so.view.target.every((t, i) => Math.abs(t - v0.target[i]) < 1e-6), '断面で開いても、全体の地図の大きさと位置は「地点」と同じ');
  await o.page.getByTestId('mode-point').click();
  await settle(o.page, 800);
  const sp = await state(o.page);
  check(Math.abs(sp.view.zoom - v0.zoom) < 1e-9 && sp.view.target.every((t, i) => Math.abs(t - v0.target[i]) < 1e-6), '「地点」へ切り替えても、大きさと位置は変わらない');
  check(o.errors.length === 0, `ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
  await o.ctx.close();

  const bad = await open(browser, base, '?data=fixture&section=1,2,3');
  check((await state(bad.page)).mode === 'point', '不正な section= は無視して「地点」で開く');
  await bad.ctx.close();
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
