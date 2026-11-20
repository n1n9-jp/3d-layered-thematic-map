import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachePath } from './fetch-cache.mjs';
import { ROOT_DIR } from './paths.mjs';

const run = promisify(execFile);
const libUrl = (name) => pathToFileURL(path.join(ROOT_DIR, 'scripts', 'lib', name)).href;

let server;
let workDir;
const cleanup = [];

beforeAll(async () => {
  workDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cwd-test-')));
  server = http.createServer((req, res) => res.end('from-server'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const f of cleanup) await rm(f, { force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('別のディレクトリから node で実行しても、リポジトリ側に保存される', () => {
  it('fetchCached → .cache/、writeFeatureCollection → public/data/（実行ディレクトリには何も作らない）', async () => {
    const url = `http://127.0.0.1:${server.address().port}/${randomUUID()}/cwd.bin`;
    const name = `__cwd-test-${randomUUID()}.geojson`;
    cleanup.push(cachePath(url), path.join(ROOT_DIR, 'public', 'data', name));

    const script = `
      import { fetchCached } from ${JSON.stringify(libUrl('fetch-cache.mjs'))};
      import { writeFeatureCollection } from ${JSON.stringify(libUrl('geojson.mjs'))};
      const buf = await fetchCached(${JSON.stringify(url)});
      const file = await writeFeatureCollection(${JSON.stringify(name)}, [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1.4, 2.6] } },
      ]);
      console.log(JSON.stringify({ cwd: process.cwd(), body: buf.toString(), file }));
    `;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: workDir });
    const out = JSON.parse(stdout);

    expect(await realpath(out.cwd)).toBe(workDir);
    expect(out.body).toBe('from-server');
    expect(existsSync(cachePath(url))).toBe(true);
    expect(out.file).toBe(path.join(ROOT_DIR, 'public', 'data', name));
    expect(JSON.parse(await readFile(out.file, 'utf8')).features[0].geometry.coordinates).toEqual([1, 3]);
    expect(existsSync(path.join(workDir, '.cache'))).toBe(false);
    expect(existsSync(path.join(workDir, 'public'))).toBe(false);
  });
});
