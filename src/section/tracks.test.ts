import { describe, expect, it, vi } from 'vitest';
import type { LayerId } from '../config';
import type { SectionLine, SectionTrack } from '../types';
import { computeSectionTracks } from './tracks';

const line: SectionLine = { ax: 0, ay: 0, bx: 1000, by: 0 };
const track = (label: string): SectionTrack => ({ kind: 'marks', label, marks: [] });
const modules = (fail?: LayerId) =>
  Object.fromEntries(
    ['elevation', 'population', 'roads', 'transit', 'facilities'].map((id) => [
      id,
      {
        section: (data: unknown) => {
          if (id === fail) throw new Error('boom');
          return [track(`${id}:${String(data)}`)];
        },
      },
    ]),
  ) as never;
const ready = { elevation: 'ready', population: 'ready', roads: 'ready', transit: 'ready', facilities: 'ready' } as const;

describe('computeSectionTracks', () => {
  it('読み込み済みのレイヤーだけ、そのレイヤーのデータで計算する', () => {
    const out = computeSectionTracks(line, { elevation: 'E', roads: 'R' }, { ...ready, population: 'loading', transit: 'error', facilities: 'idle' }, modules());
    expect(Object.keys(out).sort()).toEqual(['elevation', 'roads']);
    expect(out.elevation?.[0].label).toBe('elevation:E');
  });
  it('1つのレイヤーが例外を出しても、ほかは計算する', () => {
    const onError = vi.fn();
    const out = computeSectionTracks(line, {}, ready, modules('roads'), onError);
    expect(out.roads).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(4);
    expect(onError).toHaveBeenCalledWith('roads', expect.any(Error));
  });
});
