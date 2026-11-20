import { useEffect, useMemo } from 'react';
import { registry } from '../layers';
import { layerZ } from '../stack';
import { useMapStore } from '../store';
import type { BoundaryData, ProbeValue } from '../types';
import { createDistrictLookup } from './district';
import { installProbeKeys, releaseProbe } from './controller';

type Row = { id: string; label: string; state: 'values' | 'none' | 'loading' | 'error'; values: ProbeValue[] };

const styles = {
  panel: {
    width: 280,
    background: 'rgba(20, 20, 20, 0.85)',
    color: '#e8e8e8',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '10px 12px',
    font: '13px/1.45 sans-serif',
  },
  hint: { color: '#9aa', fontSize: 12 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 },
  district: { fontSize: 15, fontWeight: 600, color: '#fff' },
  pin: { fontSize: 11, color: '#ffb000' },
  coords: { fontSize: 11, color: '#8a9' },
  rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, margin: 0 },
  name: { color: '#9bd' },
  dim: { color: '#777' },
  release: {
    marginLeft: 6,
    font: '11px sans-serif',
    color: '#ffb000',
    background: 'transparent',
    border: '1px solid rgba(255,176,0,0.5)',
    borderRadius: 3,
    padding: '0 5px',
    cursor: 'pointer',
  },
  foot: { marginTop: 8, fontSize: 11, color: '#8a8a8a' },
} as const;

function formatValue(v: ProbeValue): string {
  if (v.value === null) return '—';
  return `${typeof v.value === 'number' ? v.value.toLocaleString('ja-JP') : v.value}${v.unit ? ` ${v.unit}` : ''}`;
}

export default function ProbePanel() {
  const probe = useMapStore((s) => s.probe);
  const pinned = useMapStore((s) => s.probePinned);
  const order = useMapStore((s) => s.order);
  const visible = useMapStore((s) => s.visible);
  const solo = useMapStore((s) => s.solo);
  const spacing = useMapStore((s) => s.spacing);
  const data = useMapStore((s) => s.data);
  const status = useMapStore((s) => s.status);

  useEffect(() => installProbeKeys(), []);

  const lookup = useMemo(
    () => (status.boundary === 'ready' ? createDistrictLookup(data.boundary as BoundaryData) : null),
    [status.boundary, data.boundary],
  );

  const stack = { order, visible, solo, spacing };
  const rows: Row[] = [];
  let district: string | null = null;
  if (probe) {
    district = lookup?.(probe.x, probe.y) ?? null;
    for (const id of [...order].reverse()) {
      if (layerZ(stack, id) === null) continue;
      const label = registry[id].label;
      if (status[id] === 'loading' || status[id] === 'idle') rows.push({ id, label, state: 'loading', values: [] });
      else if (status[id] === 'error') rows.push({ id, label, state: 'error', values: [] });
      else {
        let values: ProbeValue[] = [];
        try {
          values = registry[id].sample(data[id], probe.x, probe.y);
        } catch (e) {
          console.error(`[probe] ${id}.sample`, e);
        }
        rows.push({ id, label, state: values.length > 0 ? 'values' : 'none', values });
      }
    }
  }

  if (!probe)
    return (
      <div style={styles.panel}>
        <div style={styles.hint}>平面にカーソルを置くと、各層の値を読めます</div>
      </div>
    );

  return (
    <div style={styles.panel} data-testid="probe-panel">
      <div style={styles.head}>
        <span style={styles.district}>{district ?? '区の外'}</span>
        {pinned && <span style={styles.pin}>● 固定中</span>}
      </div>
      <dl style={styles.rows}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: 'contents' }} data-layer={r.id}>
            <dt style={styles.name}>{r.label}</dt>
            <dd style={{ margin: 0 }}>
              {r.state === 'values' ? (
                r.values.map((v, i) => (
                  <div key={i}>
                    {v.label && <span style={styles.dim}>{v.label} </span>}
                    {formatValue(v)}
                  </div>
                ))
              ) : r.state === 'loading' ? (
                <span style={styles.dim}>読み込み中…</span>
              ) : r.state === 'error' ? (
                <span style={styles.dim}>読み込み失敗</span>
              ) : (
                <span style={styles.dim}>—</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div style={styles.coords}>
        x {Math.round(probe.x).toLocaleString('ja-JP')} m, y {Math.round(probe.y).toLocaleString('ja-JP')} m
      </div>
      {pinned && (
        <div style={styles.foot}>
          Esc か平面の外をクリックで解除
          <button type="button" style={styles.release} onClick={releaseProbe}>
            解除
          </button>
        </div>
      )}
    </div>
  );
}
