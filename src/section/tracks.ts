import { useMemo } from 'react';
import { LAYER_IDS } from '../config';
import type { LayerId, LayerOptions } from '../config';
import { registry } from '../layers';
import { useMapStore } from '../store';
import type { LayerStatus } from '../store';
import { RIVER_TIERS } from '../layers/rivers';
import type { RiverData } from '../layers/rivers';
import type { LayerModule, SectionLine, SectionTrack } from '../types';
import { computeRiverCrossings } from './riverCrossings';

export type SectionTracks = Partial<Record<LayerId, SectionTrack[]>>;

/**
 * 読み込み済みの各レイヤーの、線に沿ったトラック。読み込み前・失敗したレイヤーは含まない。
 * あるレイヤーの section が例外を出しても、そのレイヤーだけ含めない（onError に渡す）。
 */
export function computeSectionTracks(
  line: SectionLine,
  data: Partial<Record<string, unknown>>,
  status: Record<string, LayerStatus>,
  options: LayerOptions,
  modules: Record<LayerId, Pick<LayerModule<unknown>, 'section'>> = registry,
  onError?: (id: LayerId, e: unknown) => void,
): SectionTracks {
  const out: SectionTracks = {};
  for (const id of LAYER_IDS) {
    if (status[id] !== 'ready') continue;
    try {
      out[id] = modules[id].section(data[id], line, options);
    } catch (e) {
      onError?.(id, e);
    }
  }
  // 川を横切る位置は、標高と浸水のグラフ（系列）に添える。川が読み込めていなければ付けない。
  if (status.rivers === 'ready' && data.rivers) {
    try {
      const rivers = computeRiverCrossings(data.rivers as RiverData, line);
      for (const id of RIVER_TIERS) {
        const tracks = out[id];
        if (tracks) out[id] = tracks.map((t) => (t.kind === 'series' ? { ...t, rivers } : t));
      }
    } catch (e) {
      console.error('[section] rivers', e);
    }
  }
  return out;
}

/** 断面の線に対する、各レイヤーのトラック。線がなければ空。データか線が変わったときだけ計算する（全レイヤーで 1 ms 前後）。 */
export function useSectionTracks(): { line: SectionLine | null; tracks: SectionTracks } {
  const line = useMapStore((s) => s.section);
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);
  const options = useMapStore((s) => s.options);
  const tracks = useMemo(
    () => (line ? computeSectionTracks(line, data, status, options, registry, (id, e) => console.error(`[section] ${id}.section`, e)) : {}),
    [line, data, status, options],
  );
  return { line, tracks };
}
