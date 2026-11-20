#!/usr/bin/env node
// 最終確認用の一括撮影。scripts/shot-scenarios.json の全シナリオを1回の Vite 起動で順に撮り、
// 各シナリオの読み込み状態・コンソールエラー・所要時間を記録して index.md にまとめる。
//   node scripts/shot-all.mjs [--out <ディレクトリ>] [--data fixture] [--only <名前,名前>]
// オプション:
//   --out <dir>        出力先（既定 shots/final）
//   --data fixture     全シナリオのクエリに data=fixture を足す
//   --only <a,b,...>   指定した名前のシナリオだけ撮る
// 終了コード: 読み込みに失敗したシナリオ、またはエラーのあったシナリオが1つでもあれば 1。使い方の誤りは 2。
// シナリオの形式: { name, query, size: "WxH", actions: [{ type: "hover", x: "center"|<px>, y: "center"|<px> }], criteria }
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const READY_TIMEOUT_MS = 30000;
const LAUNCH_ARGS = (process.env.SHOT_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'shots/final' },
    data: { type: 'string' },
    only: { type: 'string' },
  },
});

function usageError(message) {
  console.error(`shot-all.mjs: ${message}`);
  process.exit(2);
}

if (values.data !== undefined && values.data !== 'fixture') usageError(`--data は fixture のみ指定できます: ${values.data}`);

let scenarios = JSON.parse(readFileSync(join(HERE, 'shot-scenarios.json'), 'utf8'));
if (values.only !== undefined) {
  const names = values.only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !scenarios.some((s) => s.name === n));
  if (names.length === 0 || unknown.length > 0) {
    usageError(`--only に未知のシナリオ名があります: ${unknown.join(', ') || '(空)'}\n  使える名前: ${scenarios.map((s) => s.name).join(', ')}`);
  }
  scenarios = scenarios.filter((s) => names.includes(s.name));
}

const outDir = resolve(process.cwd(), values.out);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Vite が起動直後に終了しました (code ${child.exitCode})`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await sleep(150);
  }
  throw new Error(`Vite の起動が ${timeoutMs}ms 以内に完了しませんでした`);
}

// Vite を独立したプロセスグループで起動し、終了時にグループごと落とす
function startVite(port) {
  const child = spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.getLog = () => log;
  return child;
}

async function stopVite(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // すでに終了している
  }
  const timedOut = await Promise.race([exited.then(() => false), sleep(3000).then(() => true)]);
  if (timedOut) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // すでに終了している
    }
    await exited;
  }
}

let vite = null;
let browser = null;

// どの経路で抜けても Vite のプロセスグループを残さない
process.on('exit', () => {
  if (vite && vite.exitCode === null) {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      // すでに終了している
    }
  }
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await browser?.close().catch(() => {});
    await stopVite(vite);
    process.exit(130);
  });
}

function queryFor(scenario) {
  const parts = scenario.query ? [scenario.query.replace(/^\?/, '')] : [];
  if (values.data === 'fixture' && !/(^|&)data=/.test(parts.join('&'))) parts.push('data=fixture');
  return parts.join('&');
}

function parseSize(size, name) {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '1400x1000');
  if (!m) throw new Error(`シナリオ ${name} の size が <幅>x<高さ> ではありません: ${size}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function runActions(page, actions, viewport) {
  for (const a of actions ?? []) {
    if (a.type === 'hover') {
      const x = a.x === 'center' ? viewport.width / 2 : Number(a.x);
      const y = a.y === 'center' ? viewport.height / 2 : Number(a.y);
      await page.mouse.move(x, y);
      await page.mouse.move(x + 1, y + 1); // pick を確実に走らせる
      await page.mouse.move(x, y);
      await sleep(300);
    } else {
      throw new Error(`未知の操作です: ${a.type}`);
    }
  }
}

async function shootScenario(base, scenario) {
  const viewport = parseSize(scenario.size, scenario.name);
  const query = queryFor(scenario);
  const file = `${scenario.name}.png`;
  const result = { name: scenario.name, query, criteria: scenario.criteria, file, notReady: [], errors: [], ms: 0, failed: false };

  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') result.errors.push(`[console.error] ${msg.text().split('\n')[0]}`);
    });
    page.on('pageerror', (err) => result.errors.push(`[pageerror] ${err.message}`));
    page.on('requestfailed', (req) => result.errors.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`));

    const openedAt = performance.now();
    await page.goto(base + (query ? `?${query}` : ''), { waitUntil: 'load' });
    const ready = await page
      .waitForFunction(() => window.__ready === true, undefined, { timeout: READY_TIMEOUT_MS, polling: 100 })
      .then(() => true)
      .catch(() => false);
    if (!ready) result.errors.push(`[shot] window.__ready が ${READY_TIMEOUT_MS}ms 以内に true になりませんでした`);

    await runActions(page, scenario.actions, viewport);

    const status = await page.evaluate(() => window.__store?.getState().status ?? null);
    if (status === null) {
      result.notReady = ['window.__store が見つかりません'];
    } else {
      result.notReady = Object.entries(status)
        .filter(([, v]) => v !== 'ready')
        .map(([k, v]) => `${k}(${v})`);
    }
    result.ms = Math.round(performance.now() - openedAt);
    await page.screenshot({ path: join(outDir, file) });
  } catch (err) {
    result.errors.push(`[shot-all] ${err.message}`);
    result.failed = true;
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function stateText(r) {
  if (r.failed) return '撮影失敗';
  return r.notReady.length === 0 ? 'ready' : `失敗: ${r.notReady.join(', ')}`;
}

function errorText(r) {
  return r.errors.length === 0 ? 'なし' : `${r.errors.length}件`;
}

function writeIndex(results, startedAt, totalMs) {
  const ng = results.filter((r) => r.notReady.length > 0 || r.errors.length > 0 || r.failed);
  const lines = [
    '# 撮影結果',
    '',
    `- 実行日時: ${startedAt}`,
    `- データ: ${values.data === 'fixture' ? '仮データ（data=fixture）' : '実データ'}`,
    `- シナリオ数: ${results.length}、問題あり: ${ng.length}、合計時間: ${(totalMs / 1000).toFixed(1)}秒`,
    '',
    '| 名前 | クエリ | 合格の基準 | 読み込み状態 | エラー | 所要時間(ms) | 画像 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (r) =>
        `| ${esc(r.name)} | ${r.query ? `\`${esc(r.query)}\`` : '（なし）'} | ${esc(r.criteria)} | ${esc(stateText(r))} | ${errorText(r)} | ${r.ms} | ${r.failed ? '（なし）' : `[${r.file}](${r.file})`} |`,
    ),
    '',
  ];
  const withErrors = results.filter((r) => r.errors.length > 0);
  if (withErrors.length > 0) {
    lines.push('## エラーの内容', '');
    for (const r of withErrors) {
      lines.push(`### ${r.name}`, '');
      for (const e of r.errors) lines.push(`- ${esc(e)}`);
      lines.push('');
    }
  }
  writeFileSync(join(outDir, 'index.md'), lines.join('\n'));
  return ng;
}

let exitCode = 0;
try {
  mkdirSync(outDir, { recursive: true });
  const port = await freePort();
  vite = startVite(port);
  const base = `http://127.0.0.1:${port}/`;
  await waitForServer(base, vite);
  browser = await chromium.launch({ args: LAUNCH_ARGS });

  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const results = [];
  for (const scenario of scenarios) {
    const r = await shootScenario(base, scenario);
    results.push(r);
    console.log(`${r.failed || r.notReady.length > 0 || r.errors.length > 0 ? 'NG' : 'OK'}  ${r.name}  ${r.ms}ms`);
  }
  const ng = writeIndex(results, startedAt, performance.now() - t0);

  console.log('');
  console.log(`出力先: ${outDir}`);
  console.log(`シナリオ ${results.length} 件中、問題あり ${ng.length} 件（index.md を出力しました）`);
  for (const r of results) {
    console.log(`  ${r.name.padEnd(20)} 読み込み: ${stateText(r)} / エラー: ${errorText(r)} / ${r.ms}ms / ${r.file}`);
  }
  if (ng.length > 0) exitCode = 1;
} catch (err) {
  console.error(`shot-all.mjs: ${err.message}`);
  if (vite?.getLog) console.error(vite.getLog());
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopVite(vite);
}
process.exit(exitCode);
