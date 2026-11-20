import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FETCH_SETTINGS, cachePath, fetchCached } from './fetch-cache.mjs';
import { CACHE_DIR, ROOT_DIR } from './paths.mjs';

const DEFAULTS = { ...FETCH_SETTINGS };

let server;
let base;
/** パスごとのリクエスト回数と応答の定義。 */
const hits = new Map();
const handlers = new Map();
const touched = new Set();

/** テストごとに一意なパスを作り、ハンドラを登録する。 */
function route(handler) {
  const p = `/${randomUUID()}/data.bin`;
  handlers.set(p, handler);
  const url = base + p;
  touched.add(url);
  return url;
}
const count = (url) => hits.get(new URL(url).pathname) ?? 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    handlers.get(req.url)(req, res, hits.get(req.url));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  Object.assign(FETCH_SETTINGS, DEFAULTS, { retryIntervalMs: 10 });
});

afterEach(() => {
  Object.assign(FETCH_SETTINGS, DEFAULTS);
});

afterAll(async () => {
  for (const url of touched) await rm(cachePath(url), { force: true });
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('保存先', () => {
  it('.cache/ はリポジトリのルート直下', () => {
    expect(CACHE_DIR).toBe(path.join(ROOT_DIR, '.cache'));
    expect(path.dirname(cachePath('http://example.com/a.zip'))).toBe(CACHE_DIR);
    expect(existsSync(path.join(ROOT_DIR, 'package.json'))).toBe(true);
  });

  it('既定値: 試行3回、タイムアウト60秒', () => {
    expect(DEFAULTS.maxAttempts).toBe(3);
    expect(DEFAULTS.timeoutMs).toBe(60_000);
  });
});

describe('fetchCached', () => {
  it('ダウンロードして .cache/ に保存し、2回目はサーバーに取りに行かない', async () => {
    const url = route((req, res) => res.end('hello'));
    expect((await fetchCached(url)).toString()).toBe('hello');
    expect(existsSync(cachePath(url))).toBe(true);
    expect((await fetchCached(url)).toString()).toBe('hello');
    expect(count(url)).toBe(1);
  });

  it('書き込み後に一時ファイルが残らない（並行して同じ URL を取っても壊れない）', async () => {
    const body = Buffer.alloc(200_000, 7);
    const url = route((req, res) => res.end(body));
    const results = await Promise.all(Array.from({ length: 8 }, () => fetchCached(url)));
    for (const buf of results) expect(buf.equals(body)).toBe(true);
    expect((await fetchCached(url)).equals(body)).toBe(true);
    const leftovers = (await readdir(CACHE_DIR)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('本文の途中で切れたらキャッシュに何も残さない', async () => {
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
      setTimeout(() => res.socket.destroy(), 20);
    });
    await expect(fetchCached(url)).rejects.toThrow();
    expect(existsSync(cachePath(url))).toBe(false);
    expect((await readdir(CACHE_DIR)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('5xx は再試行し、成功すれば保存する', async () => {
    const url = route((req, res, n) => {
      if (n < 3) {
        res.statusCode = 503;
        res.end('busy');
      } else res.end('ok');
    });
    expect((await fetchCached(url)).toString()).toBe('ok');
    expect(count(url)).toBe(3);
  });

  it('5xx が続けば試行回数で諦める', async () => {
    const url = route((req, res) => {
      res.statusCode = 500;
      res.end();
    });
    await expect(fetchCached(url)).rejects.toThrow(/HTTP 500/);
    expect(count(url)).toBe(3);
    expect(existsSync(cachePath(url))).toBe(false);
  });

  it('4xx は再試行せずすぐ失敗する', async () => {
    for (const status of [400, 403, 404, 429]) {
      const url = route((req, res) => {
        res.statusCode = status;
        res.end('no');
      });
      await expect(fetchCached(url)).rejects.toThrow(new RegExp(`HTTP ${status}`));
      expect(count(url)).toBe(1);
      expect(existsSync(cachePath(url))).toBe(false);
    }
  });

  it('通信エラー（接続が切れる）は再試行する', async () => {
    const url = route((req, res, n) => {
      if (n < 2) req.socket.destroy();
      else res.end('recovered');
    });
    expect((await fetchCached(url)).toString()).toBe('recovered');
    expect(count(url)).toBe(2);
  });

  it('タイムアウトしたら失敗し、再試行もする', async () => {
    FETCH_SETTINGS.timeoutMs = 150;
    FETCH_SETTINGS.maxAttempts = 2;
    const url = route(() => {
      /* 応答しない */
    });
    const started = Date.now();
    await expect(fetchCached(url)).rejects.toThrow();
    expect(count(url)).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(cachePath(url))).toBe(false);
  });

  it('本文の受信が止まってもタイムアウトする', async () => {
    FETCH_SETTINGS.timeoutMs = 150;
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
    });
    await expect(fetchCached(url)).rejects.toThrow();
  });
});
