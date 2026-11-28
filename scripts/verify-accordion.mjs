#!/usr/bin/env node
// 開閉の見出し（アコーディオン）の動作確認（実データ）。
//   node scripts/verify-accordion.mjs [--url http://127.0.0.1:5173/] [--data fixture]
// 確認すること：
//   1. 初期状態は、レイヤー一覧の5行・23区全体の表と注記・断面の集計・地点の表の行が、すべて閉じている（凡例・切り替え・表はDOMにない。区名の札も出ない）。
//      見出しは button 要素で、aria-expanded を持つ
//   2. レイヤー名を押すと、その行が開き（凡例・切り替えが出る）、別の行を押すと、開いていた行が閉じる（同時に開けるのは1つ）。もう一度押すと閉じる
//   3. 避難の行を開いているあいだだけ、区名の札が8枚出る
//   4. キーボード（Tab で見出しへ移り、Enter・スペースで開閉）でも、同じ開閉ができる
//   5. 既定以外の切り替えは、閉じた行にも小さく出る（「高潮・深さ」「65歳以上」）
//   6. 固定した探針の表の行：押すと開き、別の行で閉じる（同時に1つ）。23区全体の表・注記は、それぞれ独立に開閉する
// 1つでも外れれば、内容を表示して終了コード 1。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { url: { type: 'string' }, data: { type: 'string', default: '' } } });
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


const base = await baseUrl();
const browser = await chromium.launch(process.env.SHOT_CHROMIUM_ARGS ? { args: process.env.SHOT_CHROMIUM_ARGS.split(/\s+/) } : {});
const errors = [];
async function open(query, size = { width: 1400, height: 1000 }) {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const sep = values.data ? `data=${values.data}&` : '';
  await page.goto(`${base}?${sep}${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await sleep(1500);
  return { ctx, page };
}
const IDS = ['elevation', 'flood', 'population', 'transit', 'shelters'];
const expanded = (page, id) => page.getAttribute(`[data-testid=layer-toggle-${id}]`, 'aria-expanded');
const openIds = async (page) => (await Promise.all(IDS.map(async (id) => ((await expanded(page, id)) === 'true' ? id : null)))).filter(Boolean);
const labelCount = (page) => page.evaluate(() => (window.__wardLabels ? window.__wardLabels.placed.length : 0));
/** Tab で、selector の要素にフォーカスが来るまで進める（最大 n 回）。来たら true。 */
async function tabTo(page, selector, n = 60) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((s) => document.activeElement?.matches(s), selector)) return true;
  }
  return false;
}

/* 1. 初期状態 */
{
  const { ctx, page } = await open('');
  console.log('\n[1] 初期状態');
  check((await openIds(page)).length === 0, 'レイヤー一覧の5行はすべて閉じている（aria-expanded=false）');
  check((await page.locator('[data-testid^=legend-]').count()) === 0 && (await page.locator('[data-testid^=opt-]').count()) === 0, '凡例と切り替えは、閉じた行にはない');
  const tags = await Promise.all(IDS.map((id) => page.$eval(`[data-testid=layer-toggle-${id}]`, (e) => e.tagName)));
  check(tags.every((t) => t === 'BUTTON'), 'レイヤー名の見出しは button 要素');
  check((await labelCount(page)) === 0, '区名の札は出ない');
  check((await page.getAttribute('[data-testid=overall-table-toggle]', 'aria-expanded')) === 'false' && (await page.getAttribute('[data-testid=overall-notes-toggle]', 'aria-expanded')) === 'false', '23区全体の表と注記の見出しは閉じている');
  check((await page.locator('[data-testid=overall-exposure]').count()) === 0 && (await page.locator('[data-testid=overall-notes-body]').count()) === 0, '表と注記は、DOM にない');
  check((await page.locator('[data-testid^=layer-summary-]').count()) === 0, '既定のままなので、閉じた行に選択の表示は付かない');
  await ctx.close();
}

/* 2・3. マウス */
{
  const { ctx, page } = await open('');
  console.log('\n[2・3] マウスで開閉');
  await page.click('[data-testid=layer-toggle-shelters]');
  check((await openIds(page)).join() === 'shelters', '避難の名前を押すと、避難の行が開く');
  check((await page.locator('[data-testid=legend-shelters] li').count()) === 5, '開いた行に、凡例の5行が出る');
  check(await page.isVisible('[data-testid=notes-shelters] summary'), '開いた行に「読み方と注意」の見出しが出る');
  await sleep(1200);
  check((await labelCount(page)) === 8, '避難の行を開いているあいだ、区名の札が8枚出る');
  await page.click('[data-testid=layer-toggle-flood]');
  check((await openIds(page)).join() === 'flood', '別の行（浸水）を押すと、避難は閉じて、浸水だけが開く');
  check((await page.locator('[data-testid=legend-shelters]').count()) === 0 && (await page.locator('[data-testid=opt-floodScenario-tide]').count()) === 1, '避難の凡例は消え、浸水の切り替えが出る');
  await sleep(800);
  check((await labelCount(page)) === 0, '避難の行を閉じると、区名の札が消える');
  await page.click('[data-testid=layer-toggle-flood]');
  check((await openIds(page)).length === 0, '開いている行をもう一度押すと閉じる');
  // 5. 選択の表示
  await page.click('[data-testid=layer-toggle-flood]');
  await page.click('[data-testid=opt-floodScenario-tide]');
  await page.click('[data-testid=layer-toggle-population]');
  await page.click('[data-testid=opt-populationView-elderly]');
  await page.click('[data-testid=layer-toggle-population]');
  check((await openIds(page)).length === 0, '（準備）すべて閉じた');
  check((await page.textContent('[data-testid=layer-summary-flood]')) === '高潮・深さ', '閉じた浸水の行に「高潮・深さ」が出る');
  check((await page.textContent('[data-testid=layer-summary-population]')) === '65歳以上', '閉じた人口の行に「65歳以上」が出る');
  // チェックボックスと単独の操作は、行の開閉を起こさない
  await page.uncheck('input[aria-label="標高を表示"]');
  check((await openIds(page)).length === 0, '表示のチェックを切り替えても、行は開かない');
  await ctx.close();
}

/* 4. キーボード */
{
  const { ctx, page } = await open('');
  console.log('\n[4] キーボード（Tab と Enter）');
  const found = await tabTo(page, '[data-testid=layer-toggle-shelters]');
  check(found, 'Tab で、避難のレイヤー名の見出しにフォーカスが届く');
  await page.keyboard.press('Enter');
  check((await openIds(page)).join() === 'shelters' && (await page.locator('[data-testid=legend-shelters]').count()) === 1, 'Enter で、避難の行が開く');
  await page.keyboard.press('Enter');
  check((await openIds(page)).length === 0, 'もう一度 Enter で閉じる');
  await page.keyboard.press(' ');
  check((await openIds(page)).join() === 'shelters', 'スペースでも開く');
  // 別の行へ Tab で移って Enter：前の行が閉じる
  const found2 = await tabTo(page, '[data-testid=layer-toggle-transit]');
  check(found2, '続けて Tab で、公共交通の見出しへ移れる（避難の行の中のボタンを経由する）');
  await page.keyboard.press('Enter');
  check((await openIds(page)).join() === 'transit', 'Enter で公共交通を開くと、避難は閉じる');
  // 23区全体の見出し
  const foundT = await tabTo(page, '[data-testid=overall-table-toggle]', 80);
  check(foundT, 'Tab で、23区全体の表の見出しへ届く');
  await page.keyboard.press('Enter');
  check((await page.getAttribute('[data-testid=overall-table-toggle]', 'aria-expanded')) === 'true' && (await page.locator('[data-testid=overall-exposure]').count()) === 1, 'Enter で、表が開く');
  const foundN = await tabTo(page, '[data-testid=overall-notes-toggle]', 10);
  check(foundN, '次の Tab で、数え方の見出しへ届く');
  await page.keyboard.press('Enter');
  check((await page.getAttribute('[data-testid=overall-notes-toggle]', 'aria-expanded')) === 'true' && (await page.getAttribute('[data-testid=overall-table-toggle]', 'aria-expanded')) === 'true', '表と注記は、それぞれ独立に開閉する（注記を開いても、表は開いたまま）');
  await ctx.close();
}

/* 6. 固定した探針の表の行 */
{
  const { ctx, page } = await open('probe=5493,3341');
  console.log('\n[6] 固定した探針の表の行');
  const rowOpen = async () => page.$$eval('[data-testid=info-row]', (els) => els.filter((e) => e.dataset.open === 'true').map((e) => e.dataset.layer));
  check((await rowOpen()).length === 0, '行は、初期状態ではすべて閉じている');
  const tags = await page.$$eval('[data-testid^=info-row-toggle-]', (els) => els.map((e) => e.tagName + ':' + e.getAttribute('aria-expanded')));
  check(tags.length === 5 && tags.every((t) => t === 'BUTTON:false'), '各行の見出しは button 要素で、aria-expanded=false');
  const first = await page.$eval('[data-testid=info-row-main]', (e) => e.textContent.trim());
  check(first.length > 0, `閉じた行に、主な値が出る（避難：${first}）`);
  await page.click('[data-testid=info-row-toggle-flood]');
  check((await rowOpen()).join() === 'flood', '浸水の行を押すと開く');
  check((await page.locator('[data-testid=info-area-title]').count()) === 1 && (await page.locator('[data-testid=closeup-exposure-row]').count()) === 7, '開くと、半径内の集計と、浸水が想定される区域に住む人の表が出る');
  await page.click('[data-testid=info-row-toggle-population]');
  check((await rowOpen()).join() === 'population', '別の行（人口）を押すと、浸水は閉じる（同時に1つ）');
  check(await page.isVisible('[data-testid=closeup]') && (await page.getByTestId('mode-overview').count()) === 1 && (await page.getByRole('button', { name: '5 km', exact: true }).count()) === 1, 'クローズアップ、半径のボタン、読み方の切り替え（「全体」）は、開閉にかかわらず見えている');
  await page.focus('[data-testid=info-row-toggle-transit]');
  await page.keyboard.press('Enter');
  check((await rowOpen()).join() === 'transit', 'キーボード（フォーカス＋Enter）でも開閉できる');
  await ctx.close();
}

/* 7. 断面の集計 */
{
  const { ctx, page } = await open('section=-4471,1066,10706,2969');
  console.log('\n[7] 断面の集計');
  check((await page.getAttribute('[data-testid=section-summary-acc-toggle]', 'aria-expanded')) === 'false' && (await page.locator('[data-testid=section-headline]').count()) === 0, '線に沿った集計は、初期状態では閉じている');
  check((await page.locator('[data-testid=section-chart]').count()) === 5, '5つのグラフは、閉じていても見えている');
  await page.focus('[data-testid=section-summary-acc-toggle]');
  await page.keyboard.press('Enter');
  check((await page.locator('[data-testid=section-headline]').count()) === 1, 'Enter で開くと、集計が出る');
  await ctx.close();
}

/* 8. 断面で線を引く前の説明 */
{
  const { ctx, page } = await open('');
  console.log('\n[8] 断面で線を引く前の説明');
  await page.getByTestId('mode-section').click();
  check((await page.getAttribute('[data-testid=section-guide-toggle]', 'aria-expanded')) === 'false' && (await page.locator('[data-testid=section-guide-body]').count()) === 0, '線の引き方と例の説明は、初期状態では閉じている');
  const hint = (await page.textContent('[data-testid=mode-hint]')).trim();
  check(hint === '地図の上で2点をクリックして線を引く' && (await page.locator('[data-testid=info-column] [data-testid=mode-hint]').count()) === 0, `手がかりの1行は、情報の列ではなく帯の切り替えの右に出る（${hint}）`);
  const names = await page.$$eval('[data-testid=section-example]', (els) => els.map((e) => e.textContent.trim()));
  check(names.length === 3 && names.every((n) => n.length > 0 && !n.includes('東西 ') && !n.includes('南北 ')), `例の線のボタンは3つで、名前だけ（${names.join(' / ')}）`);
  check((await page.locator('[data-testid=section-example-notes]').count()) === 0, '例の線の説明文は、閉じているあいだ出ない');
  await page.focus('[data-testid=section-guide-toggle]');
  await page.keyboard.press('Enter');
  check((await page.locator('[data-testid=section-guide-body]').count()) === 1 && (await page.locator('[data-testid=section-example-notes] dd').count()) === 3, 'Enter で開くと、説明の段落と例の線の説明文が出る');
  await ctx.close();
}

await browser.close();
check(errors.length === 0, `ブラウザのエラーなし${errors.length ? `：${errors[0]}` : ''}`);
if (failures.length) {
  console.log(`\n不合格 ${failures.length} 件`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nすべて合格');
process.exit(0);
