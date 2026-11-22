#!/usr/bin/env node
// 切り替え（浸水の想定と見るもの、人口の総数と65歳以上）と、断面の例の線のボタンの動作確認（実データ）。
//   node scripts/verify-controls.mjs [--url http://127.0.0.1:5173/] [--data fixture]
// 確認すること：
//   1. レイヤー一覧のボタンで、store の options・凡例・23区全体の表の想定・探針の値が連動する
//   2. 浸水の凡例の段数が、想定と見るものに応じて変わる（深さ 6+1、継続時間：洪水 7+1・高潮 5+1・大きいほう 9+1）。高潮の最上段に「上限なし」が付く
//   3. 人口の「65歳以上」で、凡例が65歳以上の密度に変わり、「不明」が出る
//   4. 「断面」で、線がないときに例の線のボタンが3つ出て、押すと線が引かれ、右の列にグラフと集計が出る
//   5. 錦糸町（墨田区）を固定したクローズアップで、データ未公開の区であることが表に出る
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
async function open(query) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  const sep = values.data ? `data=${values.data}&` : '';
  await page.goto(`${base}?${sep}${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  return { ctx, page };
}
const opts = (page) => page.evaluate(() => window.__store.getState().options);
const legend = (page, id) => page.$$eval(`[data-testid=legend-${id}] li`, (els) => els.map((e) => e.textContent.trim()));
const press = async (page, testid) => {
  await page.click(`[data-testid="${testid}"]`);
  await sleep(400);
};

/* 1〜3. 切り替え */
{
  const { ctx, page } = await open('');
  console.log('\n[1] 浸水の想定と見るもの');
  check(JSON.stringify(await opts(page)) === JSON.stringify({ floodScenario: 'max', floodView: 'depth', populationView: 'total' }), '既定：大きいほう・深さ・総人口');
  check((await legend(page, 'flood')).length === 7, `深さの凡例：6段 + 浸水なし（${(await legend(page, 'flood')).length}）`);
  check((await page.getAttribute('[data-testid=overall-exposure]', 'data-scenario')) === 'max', '23区全体の表：想定は大きいほう');
  await press(page, 'opt-floodScenario-river');
  check((await opts(page)).floodScenario === 'river', '「洪水」で、store の想定が river');
  check((await page.getAttribute('[data-testid=overall-exposure]', 'data-scenario')) === 'river', '23区全体の表も、洪水に従う');
  check((await page.textContent('[data-testid=overall-exposure-scenario]')).includes('洪水'), '表の想定の表示が「洪水」');
  await press(page, 'opt-floodScenario-tide');
  check((await page.getAttribute('[data-testid=overall-exposure]', 'data-scenario')) === 'tide', '「高潮」で、表も高潮');

  console.log('\n[2] 継続時間の凡例');
  await press(page, 'opt-floodView-duration');
  let l = await legend(page, 'flood');
  check(l.length === 6, `高潮・継続時間：5段 + 浸水なし（${l.length}）`);
  check(l.some((x) => x.startsWith('1週間以上') && x.includes('上限なし')), `高潮の最上段は「1週間以上（高潮。上限なし）」（${l[0]}）`);
  await press(page, 'opt-floodScenario-river');
  l = await legend(page, 'flood');
  check(l.length === 8 && l[0] === '4週間以上' && l.includes('1週間〜2週間'), `洪水・継続時間：7段 + 浸水なし（${l.length}）。最上段は「4週間以上」、5 は「1週間〜2週間」`);
  await press(page, 'opt-floodScenario-max');
  l = await legend(page, 'flood');
  check(l.length === 10, `大きいほう・継続時間：9段 + 浸水なし（${l.length}）`);
  check(l.some((x) => x.startsWith('2週間以上')) && l.some((x) => x.includes('高潮。上限なし')) && l.includes('1週間〜2週間'), '洪水と高潮で最上段の意味が違うことが、凡例の名前で分かる');
  await press(page, 'opt-floodView-depth');
  check((await legend(page, 'flood')).length === 7, '「深さ」に戻すと、6段 + 浸水なし');

  console.log('\n[3] 人口の65歳以上');
  const before = await legend(page, 'population');
  await press(page, 'opt-populationView-elderly');
  const after = await legend(page, 'population');
  check((await opts(page)).populationView === 'elderly', '「65歳以上」で、store が elderly');
  check(before.length === 8 && after.length === 9 && after.at(-1).includes('不明') && after[0].includes('65歳以上'), `凡例が65歳以上の密度に変わり、最後に「不明」が出る（${before.length} → ${after.length}）`);
  check(!before.some((x) => x.includes('不明')), '総人口の凡例には「不明」がない');
  await ctx.close();
}

/* 探針：切り替えにかかわらず4つの値 */
{
  const { ctx, page } = await open('probe=10706,2969&flood=river&floodview=duration');
  console.log('\n[probe] 江戸川区役所（洪水・継続時間で開いても、4つの値が読める）');
  const text = await page.textContent('[data-layer=flood]');
  for (const [k, v] of [['洪水の深さ', '3〜5m'], ['高潮の深さ', '3〜5m'], ['洪水の継続', '2週間〜4週間'], ['高潮の継続', '1週間以上（上限なし）']]) check(text.includes(k) && text.includes(v), `${k}：${v}`);
  const sh = await page.textContent('[data-layer=shelters]');
  check(sh.includes('最寄りの避難場所') && sh.includes('最寄りの病院'), '避難：最寄りの避難場所と病院が出る');
  check(sh.includes('江戸川区は洪水・高潮用の指定が 0 件'), '避難：江戸川区は洪水・高潮用が 0 件であることが出る');
  await ctx.close();
}

/* 4. 断面の例の線 */
{
  const { ctx, page } = await open('');
  console.log('\n[4] 断面の例の線');
  await press(page, 'mode-section');
  check((await page.locator('[data-testid=section-example]').count()) === 3, '線がないとき、例の線のボタンが3つ出る');
  await page.locator('[data-testid=section-example]').first().click();
  await sleep(2500);
  const line = await page.evaluate(() => window.__store.getState().section);
  check(line && line.ax === -4471 && line.ay === 1066 && line.bx === 10706 && line.by === 2969, `1つ目のボタンで線が引かれる（${JSON.stringify(line)}）`);
  check((await page.locator('[data-testid=section-chart]').count()) === 5, '右の列にグラフが5つ');
  check((await page.locator('[data-testid=section-examples]').count()) === 0, '線を引いたあとは、例の線のボタンは出ない');
  const head = await page.getAttribute('[data-testid=section-headline]', 'data-severe-m');
  check(Number(head) > 4500 && Number(head) < 6500, `浸水 3m 以上の区間の長さが出る（${head} m）`);
  const gaps = await page.locator('[data-testid=section-gap][data-kind=unpublished]').count();
  check(gaps >= 1, `避難のグラフに、データ未公開の区間の網掛けが出る（${gaps}）`);
  check((await page.locator('[data-testid=section-gap][data-kind=none]').count()) >= 1, '洪水・高潮用が 0 件の区間の枠が出る');
  check((await page.locator('[data-layer=flood] [data-testid=section-rank-tick]').count()) >= 3, '浸水のグラフの縦軸に、段のラベルが出る');
  // 想定を切り替えると、断面の集計が変わる
  await press(page, 'opt-floodScenario-tide');
  await sleep(800);
  const tideM = await page.getAttribute('[data-testid=section-headline]', 'data-severe-m');
  check(tideM !== head, `想定を高潮にすると、浸水 3m 以上の区間が変わる（${head} → ${tideM} m）`);
  await ctx.close();
}

/* 5. 錦糸町のクローズアップ */
{
  const { ctx, page } = await open('probe=5811,1810&radius=2000');
  console.log('\n[5] 錦糸町（墨田区）のクローズアップ');
  check((await page.textContent('[data-testid=info-district]')) === '墨田区', '区名は墨田区');
  const t = await page.textContent('[data-testid=info-table]');
  check(t.includes('データ未公開の区') && t.includes('墨田区'), '表に、データ未公開の区が出る');
  check(t.includes('この区のデータ') && t.includes('墨田区は未公開'), '「この地点」に、この区が未公開であることが出る');
  const ex = await page.locator('[data-testid=closeup-exposure-row]').count();
  check(ex === 7, `円の中の「浸水が想定される区域に住む人」の表が出る（${ex} 行）`);
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
process.exit(0); // 起動した Vite（切り離した子プロセス）が残っても、ここで終える（終了時に止める）
