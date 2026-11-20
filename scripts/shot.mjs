#!/usr/bin/env node
// 画面のスクリーンショットを撮る。
//   node scripts/shot.mjs --query "data=fixture&spacing=5000" --out shots/stack.png
// オプション:
//   --query <q>     URL クエリ（先頭の ? は有無どちらでも可）
//   --out <path>    出力パス（既定 shots/shot.png）
//   --size <WxH>    ビューポート（既定 1400x1000）
//   --scale <n>     deviceScaleFactor（既定 1）
//   --hover <x,y>   撮影前にマウスを動かす画面座標
//   --url <URL>     指定時は Vite を起動せず、この URL を撮る（--query は付け足される）
//   --wait <ms>     撮影前の追加待ち時間（既定 0）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_TIMEOUT_MS = 30000; // window.__ready が false の間（読み込み中）に待つ上限
const READY_ABSENT_MS = 3000; // window.__ready が未定義のままならこの時間で「無い画面」とみなす
const FALLBACK_WAIT_MS = 1500; // __ready が無い画面での代用待ち

// Chromium の起動オプション。この環境のヘッドレス Chromium は GPU なしでも
// SwiftShader 経由で WebGL2 が成立するため、既定では追加オプションなし。
// 環境差で WebGL が使えない場合は SHOT_CHROMIUM_ARGS で追加できる
// （例: SHOT_CHROMIUM_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader"）。
const LAUNCH_ARGS = (process.env.SHOT_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);

const { values } = parseArgs({
  options: {
    query: { type: 'string', default: '' },
    out: { type: 'string', default: 'shots/shot.png' },
    size: { type: 'string', default: '1400x1000' },
    scale: { type: 'string', default: '1' },
    hover: { type: 'string' },
    url: { type: 'string' },
    wait: { type: 'string', default: '0' },
  },
});

function fail(message) {
  console.error(`shot.mjs: ${message}`);
  process.exit(2);
}

const sizeMatch = /^(\d+)x(\d+)$/.exec(values.size);
if (!sizeMatch) fail(`--size は <幅>x<高さ> で指定してください: ${values.size}`);
const viewport = { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) };

const scale = Number(values.scale);
if (!(scale > 0)) fail(`--scale は正の数で指定してください: ${values.scale}`);

const waitMs = Number(values.wait);
if (!(waitMs >= 0)) fail(`--wait は 0 以上のミリ秒で指定してください: ${values.wait}`);

let hover = null;
if (values.hover !== undefined) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(values.hover);
  if (!m) fail(`--hover は <x>,<y> で指定してください: ${values.hover}`);
  hover = { x: Number(m[1]), y: Number(m[2]) };
}

const outPath = resolve(process.cwd(), values.out);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function buildUrl(base) {
  const q = values.query.replace(/^\?/, '');
  if (!q) return base;
  return base + (base.includes('?') ? '&' : '?') + q;
}

let vite = null;
let browser = null;
let exitCode = 0;

// Ctrl-C や kill でも Vite のプロセスグループを残さない
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    await browser?.close().catch(() => {});
    await stopVite(vite);
    process.exit(130);
  });
}

try {
  let baseUrl = values.url;
  if (!baseUrl) {
    const port = await freePort();
    vite = startVite(port);
    baseUrl = `http://127.0.0.1:${port}/`;
    await waitForServer(baseUrl, vite);
  }
  const target = buildUrl(baseUrl);

  browser = await chromium.launch({ args: LAUNCH_ARGS });
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale });
  const page = await context.newPage();

  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      problems.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText ?? ''}`));

  await page.goto(target, { waitUntil: 'load' });

  // 読み込み完了待ち。window.__ready が true になるまで待つ。
  // 未定義のまま READY_ABSENT_MS 経過したら（__ready を持たない画面）、canvas と短い待ちで代用する。
  // 定義済みで false の間は読み込み中とみなし、READY_TIMEOUT_MS まで待つ。
  let readyMode = 'window.__ready';
  const result = await page
    .waitForFunction(
      ({ absentMs }) => {
        if (window.__ready === true) return 'ready';
        const t = (window.__shotStart ??= performance.now());
        if (typeof window.__ready === 'undefined' && performance.now() - t > absentMs) return 'absent';
        return false;
      },
      { absentMs: READY_ABSENT_MS },
      { timeout: READY_TIMEOUT_MS, polling: 100 },
    )
    .then((h) => h.jsonValue())
    .catch(() => 'timeout');
  if (result !== 'ready') {
    readyMode =
      result === 'absent' ? 'canvas+delay (window.__ready なし)' : 'canvas+delay (window.__ready が true にならず timeout)';
    if (result === 'timeout') problems.push(`[shot] window.__ready が ${READY_TIMEOUT_MS}ms 以内に true になりませんでした`);
    await page.waitForSelector('canvas', { timeout: 5000 }).catch(() => {
      problems.push('[shot] canvas が見つかりません');
    });
    await sleep(FALLBACK_WAIT_MS);
  }

  if (hover) {
    await page.mouse.move(hover.x, hover.y);
    await page.mouse.move(hover.x + 1, hover.y + 1); // pick を確実に走らせる
    await page.mouse.move(hover.x, hover.y);
    await sleep(300);
  }
  if (waitMs > 0) await sleep(waitMs);

  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });

  console.log(`url: ${target}`);
  console.log(`ready: ${readyMode}`);
  console.log(`saved: ${outPath} (${viewport.width}x${viewport.height} @${scale}x)`);
  if (problems.length === 0) {
    console.log('browser errors: none');
  } else {
    console.log(`browser errors: ${problems.length}`);
    for (const p of problems) console.log(`  ${p}`);
  }
} catch (err) {
  console.error(`shot.mjs: ${err.message}`);
  if (vite?.getLog) console.error(vite.getLog());
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopVite(vite);
}
process.exit(exitCode);
