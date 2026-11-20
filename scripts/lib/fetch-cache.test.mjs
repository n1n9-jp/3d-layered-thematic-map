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

  it('既定値: 試行3回、ヘッダー待ち60秒、本文の途絶え60秒', () => {
    expect(DEFAULTS.maxAttempts).toBe(3);
    expect(DEFAULTS.headersTimeoutMs).toBe(60_000);
    expect(DEFAULTS.bodyIdleTimeoutMs).toBe(60_000);
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

  it('429 は 5xx と同じく再試行し、成功すれば保存する', async () => {
    const url = route((req, res, n) => {
      if (n < 3) {
        res.statusCode = 429;
        res.end('slow down');
      } else res.end('ok');
    });
    expect((await fetchCached(url)).toString()).toBe('ok');
    expect(count(url)).toBe(3);
    expect(existsSync(cachePath(url))).toBe(true);
  });

  it('429 が続けば試行回数で諦める', async () => {
    const url = route((req, res) => {
      res.statusCode = 429;
      res.end();
    });
    await expect(fetchCached(url)).rejects.toThrow(/HTTP 429/);
    expect(count(url)).toBe(3);
    expect(existsSync(cachePath(url))).toBe(false);
  });

  it('429 以外の 4xx は再試行せずすぐ失敗する', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
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

  it('ヘッダーが届かないままなら、headersTimeoutMs で中断して再試行する', async () => {
    FETCH_SETTINGS.headersTimeoutMs = 150;
    FETCH_SETTINGS.maxAttempts = 2;
    const url = route(() => {
      /* 応答しない */
    });
    const started = Date.now();
    await expect(fetchCached(url)).rejects.toThrow(/ヘッダー/);
    expect(count(url)).toBe(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(cachePath(url))).toBe(false);
  });

  it('本文の受信が止まったら、bodyIdleTimeoutMs で中断する', async () => {
    FETCH_SETTINGS.bodyIdleTimeoutMs = 150;
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial');
    });
    const started = Date.now();
    await expect(fetchCached(url)).rejects.toThrow(/本文/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(existsSync(cachePath(url))).toBe(false);
  });

  it('本文を少しずつ送り続ける応答は、合計が両方の上限を超えても中断されない', async () => {
    // 上限はどちらも 200ms。ヘッダーまで 120ms、その後 25 個のチャンクを 20ms 間隔（合計 500ms 超）で送る。
    FETCH_SETTINGS.headersTimeoutMs = 200;
    FETCH_SETTINGS.bodyIdleTimeoutMs = 200;
    FETCH_SETTINGS.maxAttempts = 1;
    const chunk = Buffer.alloc(1000, 5);
    const url = route((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-length': String(chunk.length * 25) });
        let sent = 0;
        const timer = setInterval(() => {
          res.write(chunk);
          if (++sent === 25) {
            clearInterval(timer);
            res.end();
          }
        }, 20);
      }, 120);
    });
    const started = Date.now();
    const buf = await fetchCached(url);
    expect(Date.now() - started).toBeGreaterThan(450);
    expect(buf.equals(Buffer.alloc(chunk.length * 25, 5))).toBe(true);
    expect(count(url)).toBe(1);
    expect(existsSync(cachePath(url))).toBe(true);
  });

  it('ヘッダー待ちの時間は本文の受信に持ち越さない（ヘッダー待ちが上限近くでも、本文が続けば完了する）', async () => {
    FETCH_SETTINGS.headersTimeoutMs = 300;
    FETCH_SETTINGS.bodyIdleTimeoutMs = 300;
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.write('a');
        setTimeout(() => res.write('b'), 200);
        setTimeout(() => res.end('c'), 400);
      }, 250);
    });
    expect((await fetchCached(url)).toString()).toBe('abc');
  });

  it('本文の途絶えの上限は、ヘッダー待ちとは別に効く', async () => {
    // ヘッダー待ちの上限は十分長く、本文の途絶えの上限だけが短い
    FETCH_SETTINGS.headersTimeoutMs = 5000;
    FETCH_SETTINGS.bodyIdleTimeoutMs = 100;
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      res.writeHead(200);
      res.write('a');
      setTimeout(() => res.end('b'), 400); // 途絶えが 400ms > 100ms
    });
    await expect(fetchCached(url)).rejects.toThrow(/本文/);
  });

  it('ヘッダー待ちの上限は、本文の途絶えの上限とは別に効く', async () => {
    FETCH_SETTINGS.headersTimeoutMs = 100;
    FETCH_SETTINGS.bodyIdleTimeoutMs = 5000;
    FETCH_SETTINGS.maxAttempts = 1;
    const url = route((req, res) => {
      setTimeout(() => res.end('late'), 400);
    });
    await expect(fetchCached(url)).rejects.toThrow(/ヘッダー/);
  });
});
