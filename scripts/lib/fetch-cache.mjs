import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CACHE_DIR = path.resolve('.cache');
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cachePath(url) {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const base = path.basename(new URL(url).pathname).replace(/[^\w.-]/g, '_') || 'index';
  return path.join(CACHE_DIR, `${hash}-${base}`);
}

/** URL の内容を Buffer で返す。`.cache/` にあればそれを使い、なければダウンロードして保存する。 */
export async function fetchCached(url) {
  const file = cachePath(url);
  try {
    return await readFile(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, buf);
      return buf;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_INTERVAL_MS * attempt);
    }
  }
  throw lastError;
}
