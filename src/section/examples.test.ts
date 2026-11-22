import { describe, expect, it } from 'vitest';
import { EXTENT } from '../config';
import { isUsableLine, lineLength } from '../lib/section';
import { EXAMPLE_LINES } from './examples';

describe('断面の例の線', () => {
  it('2〜3本。名前と説明があり、IDが重ならない', () => {
    expect(EXAMPLE_LINES.length).toBeGreaterThanOrEqual(2);
    expect(EXAMPLE_LINES.length).toBeLessThanOrEqual(3);
    expect(new Set(EXAMPLE_LINES.map((e) => e.id)).size).toBe(EXAMPLE_LINES.length);
    for (const e of EXAMPLE_LINES) {
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.note.length).toBeGreaterThan(0);
    }
  });
  it('線として使え（300 m 以上）、両端が描画範囲の中にある', () => {
    for (const { line } of EXAMPLE_LINES) {
      expect(isUsableLine(line)).toBe(true);
      expect(lineLength(line)).toBeGreaterThan(300);
      for (const [x, y] of [[line.ax, line.ay], [line.bx, line.by]]) {
        expect(x).toBeGreaterThanOrEqual(EXTENT.minX);
        expect(x).toBeLessThanOrEqual(EXTENT.maxX);
        expect(y).toBeGreaterThanOrEqual(EXTENT.minY);
        expect(y).toBeLessThanOrEqual(EXTENT.maxY);
      }
    }
  });
});
