import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config.ts';
import { ROOT_DIR } from './paths.mjs';

describe('vite.config.ts', () => {
  it("base は './'", () => {
    expect(config.base).toBe('./');
  });

  it('ビルド結果の index.html は、アセットを相対パスで参照する', async () => {
    const outDir = await mkdtemp(path.join(os.tmpdir(), 'vite-out-'));
    try {
      await build({ root: ROOT_DIR, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
      const html = await readFile(path.join(outDir, 'index.html'), 'utf8');
      const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(ref.startsWith('./')).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
