import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPTIONS } from '../config';
import type { LayerId } from '../config';
import type { SectionLine, SectionTrack } from '../types';
import { computeSectionTracks } from './tracks';

const OPTS = { ...DEFAULT_OPTIONS, floodScenario: 'tide' } as const;
const line: SectionLine = { ax: 0, ay: 0, bx: 1000, by: 0 };
const track = (label: string): SectionTrack => ({ kind: 'marks', label, marks: [] });
const modules = (fail?: LayerId) =>
  Object.fromEntries(
    ['elevation', 'flood', 'population', 'transit', 'shelters'].map((id) => [
      id,
      {
        section: (data: unknown, _line: SectionLine, options: unknown) => {
          if (id === fail) throw new Error('boom');
          return [track(`${id}:${String(data)}:${options === OPTS ? 'opts' : 'other'}`)];
        },
      },
    ]),
  ) as never;
const ready = { elevation: 'ready', flood: 'ready', population: 'ready', transit: 'ready', shelters: 'ready' } as const;

describe('computeSectionTracks', () => {
  it('読み込み済みのレイヤーだけ、そのレイヤーのデータで計算する', () => {
    const out = computeSectionTracks(line, { elevation: 'E', flood: 'F' }, { ...ready, population: 'loading', transit: 'error', shelters: 'idle' }, OPTS, modules());
    expect(Object.keys(out).sort()).toEqual(['elevation', 'flood']);
    expect(out.elevation?.[0].label).toBe('elevation:E:opts'); // 切り替えの状態が、各レイヤーの section に渡る
  });
  it('1つのレイヤーが例外を出しても、ほかは計算する', () => {
    const onError = vi.fn();
    const out = computeSectionTracks(line, {}, ready, OPTS, modules('flood'), onError);
    expect(out.flood).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(4);
    expect(onError).toHaveBeenCalledWith('flood', expect.any(Error));
  });
});
