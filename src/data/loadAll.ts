import { DATA_BASE, LAYER_IDS } from '../config';
import { loadBoundary } from '../layers/boundary';
import { registry } from '../layers';
import { loadRivers } from '../layers/rivers';
import { useMapStore } from '../store';
import type { DataKey } from '../store';

let started: Promise<void> | null = null;

async function loadOne(key: DataKey, load: () => Promise<unknown>): Promise<void> {
  const set = useMapStore.setState;
  set((s) => ({ status: { ...s.status, [key]: 'loading' } }));
  try {
    const data = await load();
    set((s) => ({ data: { ...s.data, [key]: data }, status: { ...s.status, [key]: 'ready' } }));
  } catch (e) {
    console.error(`[loadAll] ${key}`, e);
    set((s) => ({ status: { ...s.status, [key]: 'error' } }));
  }
}

/** 区境界・川と全レイヤーを読み込む。全部が成功か失敗に落ち着いたら window.__ready を true にする。2回目以降の呼び出しは同じ Promise を返す。 */
export function loadAll(): Promise<void> {
  started ??= Promise.all([
    loadOne('boundary', () => loadBoundary(DATA_BASE)),
    loadOne('rivers', () => loadRivers(DATA_BASE)),
    ...LAYER_IDS.map((id) => loadOne(id, () => registry[id].load(DATA_BASE))),
  ]).then(() => {
    window.__ready = true;
  });
  return started;
}
