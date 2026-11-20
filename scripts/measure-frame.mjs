#!/usr/bin/env node
// 1フレームの描画にかかる時間を測る。「5枚すべて」と「1枚ずつ」（ほかの段を hidden にする）を表で出す。
//   node scripts/measure-frame.mjs
//   node scripts/measure-frame.mjs --only all,roads --frames 8 --extra "zoom=-3.5"
// オプション:
//   --frames <n>    1構成あたりに測るフレーム数（既定 5）
//   --only <a,b>    測る構成（all / none / elevation / population / roads / transit / facilities をカンマ区切り）。既定は全部
//   --extra <q>     全構成の URL に付け足すクエリ（例: "zoom=-3.5"）
//   --size <WxH>    ビューポート（既定 1400x1000）
//   --url <URL>     起動済みのサーバーを測る（Vite は起動しない）
// 測り方: 初期表示が落ち着くまで待ってから、requestAnimationFrame のたびに視点を1度ずつ回して
// （window.__store の setViewState）描き直させ、フレームの間隔（ms）を測る。表には中央値と全フレームの値を出す。
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAYERS = ['elevation', 'population', 'roads', 'transit', 'facilities'];
const READY_TIMEOUT_MS = 60000;
const SETTLE_MS = 3000;
const LAUNCH_ARGS = (process.env.SHOT_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);

const { values } = parseArgs({
  options: {
    frames: { type: 'string', default: '5' },
    only: { type: 'string', default: '' },
    extra: { type: 'string', default: '' },
    size: { type: 'string', default: '1400x1000' },
    url: { type: 'string' },
  },
});

function fail(message) {
  console.error(`measure-frame.mjs: ${message}`);
  process.exit(2);
}

const frames = Number(values.frames);
if (!Number.isInteger(frames) || frames < 1) fail(`--frames は 1 以上の整数で指定してください: ${values.frames}`);
const sizeMatch = /^(\d+)x(\d+)$/.exec(values.size);
if (!sizeMatch) fail(`--size は <幅>x<高さ> で指定してください: ${values.size}`);
const viewport = { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) };

/** 構成名 → hidden クエリ */
function configQuery(name) {
  if (name === 'all') return '';
  if (name === 'none') return `hidden=${LAYERS.join(',')}`;
  return `hidden=${LAYERS.filter((id) => id !== name).join(',')}`;
}
const ALL_CONFIGS = ['all', ...LAYERS, 'none'];
const configs = values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : ALL_CONFIGS;
for (const c of configs) if (!ALL_CONFIGS.includes(c)) fail(`未知の構成: ${c}（${ALL_CONFIGS.join(' / ')}）`);

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
      if ((await fetch(url)).ok) return;
    } catch {
      // まだ起動していない
    }
    await sleep(150);
  }
  throw new Error(`Vite の起動が ${timeoutMs}ms 以内に完了しませんでした`);
}

function startVite(port) {
  return spawn(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: ROOT, stdio: 'ignore', detached: true },
  );
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

function buildUrl(base, query) {
  const q = [query, values.extra.replace(/^\?/, '')].filter(Boolean).join('&');
  return q ? base + (base.includes('?') ? '&' : '?') + q : base;
}

/** ページ内で、視点を1度ずつ回しながら各フレームの間隔（ms）を測る。 */
function measureInPage(count) {
  return new Promise((resolveFrames) => {
    const times = [];
    let last = null;
    const tick = (now) => {
      if (last !== null) times.push(now - last);
      last = now;
      // 最初の間隔は、視点を変える前のものなので捨てる
      if (times.length >= count + 1) {
        times.shift();
        resolveFrames(times);
        return;
      }
      const { viewState, setViewState } = window.__store.getState();
      setViewState({ ...viewState, rotationOrbit: viewState.rotationOrbit + 1 });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

let vite = null;
let browser = null;
let exitCode = 0;
process.on('exit', () => {
  if (vite && vite.exitCode === null) {
    try {
      process.kill(-vite.pid, 'SIGKILL');
    } catch {
      // すでに終了している
    }
  }
});

try {
  let baseUrl = values.url;
  if (!baseUrl) {
    const port = await freePort();
    vite = startVite(port);
    baseUrl = `http://127.0.0.1:${port}/`;
    await waitForServer(baseUrl, vite);
  }
  browser = await chromium.launch({ args: LAUNCH_ARGS });
  const rows = [];
  for (const name of configs) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const url = buildUrl(baseUrl, configQuery(name));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: READY_TIMEOUT_MS, polling: 100 });
    await sleep(SETTLE_MS);
    const times = await page.evaluate(measureInPage, frames);
    rows.push({ name, times });
    await context.close();
  }

  const ms = (v) => Math.round(v).toLocaleString('en-US');
  console.log(`viewport ${viewport.width}x${viewport.height}, ${frames} frames/config, extra="${values.extra}"`);
  console.log('| 構成 | 中央値 ms | 各フレーム ms |');
  console.log('| --- | ---: | --- |');
  for (const { name, times } of rows) {
    console.log(`| ${name} | ${ms(median(times))} | ${times.map(ms).join(', ')} |`);
  }
} catch (err) {
  console.error(`measure-frame.mjs: ${err.message}`);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopVite(vite);
}
process.exit(exitCode);
