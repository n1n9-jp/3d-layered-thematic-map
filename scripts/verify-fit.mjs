#!/usr/bin/env node
// 画面の収まりの確認（実データ）：全体の地図の区名の札と、右の列の23区全体の集計。
//   node scripts/verify-fit.mjs [--url http://127.0.0.1:5173/] [--only labels,column]
// --url がなければ Vite を起動する。確認すること：
//   column（右の列の23区全体の集計）
//     2000×1100・1400×1000 の初期表示で、想定のラベル・大きな数字・深さの区分ごとの表（合計の行、標高 0m 未満の行まで）が、
//     スクロールなしで列の表示範囲の中にある（要素の位置と、scrollHeight で確かめる）。主な数字の大きさが読める。外した要素
//     （説明文、カード、「5 区」、列の下の注意と操作の説明）が出ていない。「試作。避難の判断には使えません。」は出典の欄に1回だけ。
//     折りたたみの注記に、足し合わせでないことと、指定なし・未公開の読み方がある。1000×700 では、収まらなければ、スクロールで最後の行まで読める
//   labels（避難の段の区名の札）
//     2000×1100・1400×1000・1000×700 の初期表示と、方位（ro=120・-60）・正面・真上・間隔 0 と 20km で、
//     札どうし・題・右の列・レイヤー名・ほかの段の区境界線と鉄道に重ならず、引き出し線が札や線と交わらない。
//     2000×1100・1400×1000 では、8つの札がすべて出る。視点（マウスの移動）では、札の置き場所を決め直さず、間隔を変えたときだけ決め直す
// 1つでも外れれば、内容を表示して終了コード 1 で終わる。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({ options: { url: { type: 'string' }, only: { type: 'string' } } });
const want = (k) => !values.only || values.only.split(',').map((x) => x.trim()).includes(k);
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

/** 23区のデータのある範囲（`src/config.ts` の DATA_OUTLINE。凸多角形、ローカル座標）。 */
function loadOutline() {
  const src = readFileSync(join(ROOT, 'src/config.ts'), 'utf8');
  const body = /DATA_OUTLINE[^=]*=\s*\[([\s\S]*?)\];/.exec(src)[1];
  const nums = [...body.matchAll(/-?\d+/g)].map((m) => Number(m[0]));
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  return pts;
}
function inConvex(poly, [x, y]) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c === 0) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

/** 実データの、区境界線と鉄道の頂点（ローカル座標）。札が、ほかの段のこれらに重ならないことを確かめる。 */
function loadVertices() {
  const out = {};
  for (const [key, f] of [['boundary', 'boundary.geojson'], ['rail', 'rail.geojson']]) {
    const pts = [];
    const walk = (c) => (typeof c[0] === 'number' ? pts.push(c) : c.forEach(walk));
    JSON.parse(readFileSync(join(ROOT, 'public/data', f), 'utf8')).features.forEach((ft) => walk(ft.geometry.coordinates));
    out[key] = pts;
  }
  // 鉄道は、23区の外（描画範囲の端まで）にも細い線が伸びる。札を避ける対象は、23区のデータのある範囲の中の鉄道
  const outline = loadOutline();
  out.rail = out.rail.filter((v) => inConvex(outline, v));
  return out;
}

async function open(browser, base, query, size) {
  const [w, h] = size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().split('\n')[0]));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000, polling: 100 });
  return { ctx, page, errors };
}

/** 札の置き場所を決めた回数が、続けて2回、同じになるまで待つ（視点の収め直しが終わるまで）。 */
async function settled(page) {
  let prev = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(1200);
    const n = await page.evaluate(() => window.__wardLabelLayouts ?? 0);
    if (n === prev && n > 0) return n;
    prev = n;
  }
  return prev;
}

const rectsOverlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inRect = (r, [x, y]) => x > r.left && x < r.right && y > r.top && y < r.bottom;
const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
const segCross = (a, b, c, d) => {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
};
function segHitsRect(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const clip = (p, q) => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, a[0] - r.left) && clip(dx, r.right - a[0]) && clip(-dy, a[1] - r.top) && clip(dy, r.bottom - a[1]) && t1 - t0 > 1e-9;
}

/* ------------------------------------------------------------------ 右の列の23区全体の集計 */

async function column(browser, base) {
  console.log('\n[column] 右の列：23区全体の集計');
  for (const size of ['2000x1100', '1400x1000', '1000x700']) {
    const o = await open(browser, base, '', size);
    await sleep(1500);
    const r = await o.page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const rect = (s) => {
        const e = q(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      };
      const sc = q('[data-testid=overall-scroll]');
      return {
        scroll: rect('[data-testid=overall-scroll]'),
        scrollTop: sc.scrollTop,
        scrollH: sc.scrollHeight,
        clientH: sc.clientHeight,
        overflowY: getComputedStyle(sc).overflowY,
        scen: rect('[data-testid=overall-scenario]'),
        severe: rect('[data-testid=overall-severe]'),
        bignum: parseFloat(getComputedStyle(q('[data-testid=overall-severe]')).fontSize),
        table: rect('[data-testid=overall-exposure]'),
        total: rect('[data-testid=overall-exposure-total]'),
        below: rect('[data-testid=overall-exposure-below]'),
        notes: rect('[data-testid=overall-notes-toggle]'),
        gone: ['.ov-scen-note', '.ov-pair', '.ov-card', '[data-testid=overall-flooded]', '[data-testid=overall-deep]', '[data-testid=overall-shelters]', '[data-testid=overall-below]', '[data-testid=disclaimer]', '[data-testid=info-hint]'].filter((s) => q(s)),
        columnText: q('[data-testid=info-column]').textContent,
        bodyText: document.body.innerText,
      };
    });
    const inside = (b) => b && b.top >= r.scroll.top - 0.5 && b.bottom <= r.scroll.bottom + 0.5;
    console.log(`      ${size}：列の表示範囲 ${Math.round(r.scroll.top)}〜${Math.round(r.scroll.bottom)}、合計の行 ${Math.round(r.total.top)}〜${Math.round(r.total.bottom)}、標高の行 ${Math.round(r.below.top)}〜${Math.round(r.below.bottom)}、scrollHeight ${r.scrollH} / 表示 ${r.clientH}、主な数字 ${r.bignum.toFixed(1)}px`);
    check(r.scrollTop === 0, `${size}：スクロールしていない（scrollTop ${r.scrollTop}）`);
    check(r.overflowY === 'auto', `${size}：収まらないときは、列の中をスクロールできる（overflow-y: ${r.overflowY}）`);
    check(inside(r.severe), `${size}：主な数字（約242万人）が、スクロールなしで見える`);
    check(r.scen.top < r.severe.top && r.severe.top < r.table.top, `${size}：上から、想定のラベル、大きな数字、表の順`);
    check(r.gone.length === 0, `${size}：外した要素（説明文・カード・「5 区」・列の下の注意と操作の説明）が出ていない${r.gone.length ? `：${r.gone.join(' ')}` : ''}`);
    if (size !== '1000x700') {
      check(inside(r.table), `${size}：深さの区分ごとの表が、見出しから最後の行まで見える`);
      check(inside(r.total), `${size}：表の「合計」の行が、列の表示範囲の中にある（下端まで ${(r.scroll.bottom - r.total.bottom).toFixed(1)}px）`);
      check(inside(r.below), `${size}：表の「標高 0m 未満の土地」の行（最後の行）も見える`);
      check(inside(r.notes), `${size}：「数え方とデータの注意」の開閉ボタンも見える`);
      check(r.scrollH <= r.clientH + 1, `${size}：スクロールなしで全部が収まる（scrollHeight ${r.scrollH} ≦ 表示 ${r.clientH}）`);
    } else {
      await o.page.evaluate(() => {
        const sc = document.querySelector('[data-testid=overall-scroll]');
        sc.scrollTop = sc.scrollHeight;
      });
      await sleep(300);
      const after = await o.page.evaluate(() => {
        const sc = document.querySelector('[data-testid=overall-scroll]').getBoundingClientRect();
        const t = document.querySelector('[data-testid=overall-exposure-below]').getBoundingClientRect();
        return t.bottom <= sc.bottom + 0.5 && t.top >= sc.top - 0.5;
      });
      check(after, `${size}：（収まらなければ）いちばん下までスクロールすると、表の最後の行が見える`);
    }
    const minBig = size === '2000x1100' ? 70 : 45;
    check(r.bignum >= minBig, `${size}：主な数字が離れた席から読める大きさ（${r.bignum.toFixed(1)}px ≧ ${minBig}px）`);
    const proto = r.bodyText.split('試作。避難の判断には使えません。').length - 1;
    check(proto === 1, `${size}：「試作。避難の判断には使えません。」が画面に1回だけある（出典の欄。${proto} 回）`);
    check(!/試作です/.test(r.bodyText), `${size}：「試作です。…」の注意文は、どこにも出ていない`);
    await o.page.click('[data-testid=overall-notes-toggle]');
    await sleep(200);
    const notes = await o.page.textContent('[data-testid=overall-notes-body]');
    check(/足し合わせません/.test(notes), `${size}：折りたたみの注記に、「大きいほう」が足し合わせでないことの説明がある`);
    check(/指定なし/.test(notes) && /未公開/.test(notes) && /江戸川区/.test(notes) && /葛飾区/.test(notes), `${size}：折りたたみの注記に、指定なしと未公開の区の読み方がある`);
    check(o.errors.length === 0, `${size}：ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
    await o.ctx.close();
  }
}

/* ------------------------------------------------------------------ 避難の段の区名の札 */

const CASES = [
  // [名前, サイズ, クエリ, 8つとも出ることを求めるか]
  ['初期表示', '2000x1100', '', true],
  ['初期表示', '1400x1000', '', true],
  ['初期表示', '1000x700', '', false],
  ['方位 120', '2000x1100', 'ro=120', true],
  ['方位 -60', '2000x1100', 'ro=-60', true],
  ['正面', '2000x1100', 'rx=12&ro=0', true],
  ['真上', '2000x1100', 'rx=90&ro=0', true],
  ['間隔 0', '2000x1100', 'spacing=0', true],
  ['間隔 20km', '2000x1100', 'spacing=20000', true],
  ['方位 120', '1400x1000', 'ro=120', true],
  ['方位 -60', '1400x1000', 'ro=-60', true],
  ['正面', '1400x1000', 'rx=12&ro=0', true],
  ['真上', '1400x1000', 'rx=90&ro=0', true],
  ['間隔 0', '1400x1000', 'spacing=0', true],
  ['間隔 20km', '1400x1000', 'spacing=20000', true],
];

async function labels(browser, base, vertices) {
  console.log('\n[labels] 避難の段の区名の札');
  const only = process.env.CASE ? process.env.CASE.split(',') : null;
  for (const [name, size, query, needAll] of CASES) {
    if (only && !only.includes(`${size}:${name}`)) continue;
    const tag = `${size}・${name}`;
    const o = await open(browser, base, query, size);
    await settled(o.page);
    const info = await o.page.evaluate(() => {
      const s = window.__store.getState();
      const canvas = document.querySelector('canvas').getBoundingClientRect();
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { left: b.left - canvas.left, right: b.right - canvas.left, top: b.top - canvas.top, bottom: b.bottom - canvas.top };
      };
      const L = window.__wardLabels;
      return {
        canvas: { width: canvas.width, height: canvas.height },
        vs: s.viewState,
        spacing: s.spacing,
        order: s.order,
        visible: s.visible,
        solo: s.solo,
        title: box('[data-testid=page-title]'),
        column: box('[data-testid=info-column]'),
        layout: L && { level: L.level, omitted: L.omitted, layerNames: L.layerNames, placed: L.placed.map((p) => ({ name: p.label.name, kind: p.label.kind, text: p.text, rect: p.rect, anchor: p.anchor, attach: p.attach })) },
      };
    });
    if (!info.layout) {
      check(false, `${tag}：札の配置が取れない`);
      await o.ctx.close();
      continue;
    }
    const L = info.layout;
    const vp = new OrbitView({ orthographic: true, fovy: 5 }).makeViewport({ width: info.canvas.width, height: info.canvas.height, viewState: info.vs });
    // 表示中の段の高さ（下から order の順）
    const zs = {};
    let tier = 0;
    for (const id of info.order) if (info.visible[id] || info.solo === id) zs[id] = info.solo !== null ? 0 : tier++ * info.spacing;
    const otherZs = Object.entries(zs).filter(([id]) => id !== 'shelters').map(([, z]) => z);
    const rects = L.placed.map((p) => p.rect);
    const lens = L.placed.map((p) => Math.round(Math.hypot(p.attach[0] - p.anchor[0], p.attach[1] - p.anchor[1])));
    console.log(`      ${tag}：段階 ${L.level}、${L.placed.map((p) => p.text.replace('\n', '／')).join('、')}${L.omitted.length ? `（出さなかった区：${L.omitted.join('・')}）` : ''}、引き出し線 ${lens.join('/')}px`);
    if (needAll) check(L.placed.length === 8 && L.omitted.length === 0, `${tag}：8つの札がすべて出る（${L.placed.length} 枚）`);
    else check(L.placed.length >= 1, `${tag}：札が出る（${L.placed.length} 枚。収まらないときは、小さく・短くし、置けないものは出さない）`);
    const names = new Set(L.placed.map((p) => p.name));
    check(names.size === L.placed.length, `${tag}：同じ区の札が重複しない`);
    // 札の重なりと範囲
    let bad = [];
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i], rects[j])) bad.push(`${L.placed[i].name}×${L.placed[j].name}`);
    check(bad.length === 0, `${tag}：札どうしが重ならない${bad.length ? `（${bad.join('、')}）` : ''}`);
    bad = [];
    for (const p of L.placed) {
      for (const q of L.placed) {
        if (p === q) continue;
        if (segHitsRect(p.anchor, p.attach, q.rect)) bad.push(`${p.name}の線×${q.name}の札`);
      }
    }
    for (let i = 0; i < L.placed.length; i++)
      for (let j = i + 1; j < L.placed.length; j++) if (segCross(L.placed[i].anchor, L.placed[i].attach, L.placed[j].anchor, L.placed[j].attach)) bad.push(`${L.placed[i].name}の線×${L.placed[j].name}の線`);
    check(bad.length === 0, `${tag}：引き出し線が、ほかの札や線と交わらない${bad.length ? `（${bad.join('、')}）` : ''}`);
    check(rects.every((r) => r.left >= 0 && r.top >= 0 && r.bottom <= info.canvas.height && r.right <= info.canvas.width), `${tag}：札が描画領域の中に収まる`);
    check(rects.every((r) => !rectsOverlap(r, info.column)), `${tag}：右の列に重ならない（列の左端 ${Math.round(info.column.left)}、札の右端 最大 ${Math.round(Math.max(...rects.map((r) => r.right)))}）`);
    check(rects.every((r) => !rectsOverlap(r, info.title)), `${tag}：題に重ならない`);
    check(rects.every((r) => L.layerNames.every((n) => !rectsOverlap(r, n))), `${tag}：レイヤー名に重ならない`);
    // 札の中に、別の段の区境界線・鉄道の頂点がない（避難の段と同じ高さの段は、避難の段自体なので除く）
    const hit = { boundary: 0, rail: 0 };
    for (const z of otherZs)
      for (const key of ['boundary', 'rail'])
        for (const v of vertices[key]) {
          const px = vp.project([v[0], v[1], z]);
          if (rects.some((r) => inRect(r, px))) hit[key]++;
        }
    check(hit.boundary === 0, `${tag}：ほかの段の区境界線（実データの頂点 ${vertices.boundary.length} 個）が、札の中にない${hit.boundary ? `（${hit.boundary} 個が札の中）` : ''}`);
    check(hit.rail === 0, `${tag}：ほかの段の鉄道（23区のデータのある範囲の中の頂点 ${vertices.rail.length} 個）が、札の中にない${hit.rail ? `（${hit.rail} 個が札の中）` : ''}`);
    check(o.errors.length === 0, `${tag}：ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
    await o.ctx.close();
  }

  // マウスの移動では置き場所を決め直さない。間隔を変えると決め直す
  console.log('\n      マウスの移動と間隔の変更');
  const o = await open(browser, base, '', '1400x1000');
  const n0 = await settled(o.page);
  const before = await o.page.evaluate(() => window.__wardLabels.placed.map((p) => [p.label.name, Math.round(p.rect.left), Math.round(p.rect.top)].join()).join('|'));
  for (const [x, y] of [[200, 300], [300, 420], [150, 600], [400, 500], [250, 200], [350, 700]]) {
    await o.page.mouse.move(x, y);
    await sleep(500);
  }
  await sleep(1500);
  const n1 = await o.page.evaluate(() => window.__wardLabelLayouts);
  const after = await o.page.evaluate(() => window.__wardLabels.placed.map((p) => [p.label.name, Math.round(p.rect.left), Math.round(p.rect.top)].join()).join('|'));
  check(n1 === n0, `マウスを動かしても、札の置き場所を決め直さない（${n0} 回 → ${n1} 回）`);
  check(before === after, 'マウスを動かしても、札の位置が変わらない');
  await o.page.evaluate(() => window.__store.getState().setSpacing(20000));
  const n2 = await settled(o.page);
  check(n2 > n1, `間隔を変えると、札の置き場所を決め直す（${n1} 回 → ${n2} 回）`);
  const L2 = await o.page.evaluate(() => ({ n: window.__wardLabels.placed.length, omitted: window.__wardLabels.omitted }));
  check(L2.n === 8, `間隔 20 km にしても、8つの札が出る（${L2.n} 枚）`);
  check(o.errors.length === 0, `ブラウザのエラーなし${o.errors.length ? `：${o.errors[0]}` : ''}`);
  await o.ctx.close();
}

const base = await baseUrl();
const browser = await chromium.launch();
try {
  if (want('column')) await column(browser, base);
  if (want('labels')) await labels(browser, base, loadVertices());
} finally {
  await browser.close();
}
console.log(failures.length === 0 ? '\nすべて通りました' : `\n外れた項目：${failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
