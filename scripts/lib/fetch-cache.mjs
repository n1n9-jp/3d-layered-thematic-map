import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './paths.mjs';

/** 取得の設定。通常は変更しない（テストが値を差し替えるために公開している）。 */
export const FETCH_SETTINGS = {
  /** 通信エラー・5xx のときの最大試行回数。 */
  maxAttempts: 3,
  /** 再試行の間隔の基準値（試行回数を掛けて待つ）。 */
  retryIntervalMs: 2000,
  /** 1回の取得（ヘッダーから本文の受信完了まで）のタイムアウト。 */
  timeoutMs: 60_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 再試行しない HTTP エラー（4xx など）。 */
class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status} ${statusText}: ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** URL に対応するキャッシュファイルの絶対パス。 */
export function cachePath(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const base = path.basename(new URL(url).pathname).replace(/[^\w.-]/g, '_') || 'index';
  return path.join(CACHE_DIR, `${hash}-${base}`);
}

/** 1回分の取得。HTTP エラーは HttpError、通信エラーとタイムアウトはそのまま投げる。 */
async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_SETTINGS.timeoutMs) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, res.statusText, url);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 一時ファイルに書いてから rename することで、途中までのファイルがキャッシュとして残らないようにする。 */
async function writeCache(file, buf) {
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, buf);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * URL の内容を Buffer で返す。`.cache/` にあればそれを使い、なければダウンロードして保存する。
 * 通信エラーと 5xx は再試行し、4xx はすぐに失敗させる。
 */
export async function fetchCached(url) {
  const file = cachePath(url);
  try {
    return await readFile(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const { maxAttempts, retryIntervalMs } = FETCH_SETTINGS;
  let buf;
  for (let attempt = 1; ; attempt++) {
    try {
      buf = await download(url);
      break;
    } catch (e) {
      if ((e instanceof HttpError && e.status < 500) || attempt >= maxAttempts) throw e;
      await sleep(retryIntervalMs * attempt);
    }
  }
  await writeCache(file, buf);
  return buf;
}
