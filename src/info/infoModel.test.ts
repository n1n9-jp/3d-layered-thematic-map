import { describe, expect, it } from 'vitest';
import { LAYER_IDS } from '../config';
import type { LayerId } from '../config';
import type { LayerStatus } from '../store';
import type { ProbeValue } from '../types';
import { areaCell, areaHeading, buildRows, columnMode, coordsText, pointCell, valueText, valueTitle } from './infoModel';

const LABELS = { elevation: '標高', flood: '浸水', population: '人口', transit: '公共交通', shelters: '避難' } as Record<LayerId, string>;
const ready = Object.fromEntries(LAYER_IDS.map((id) => [id, 'ready'])) as Record<LayerId, LayerStatus>;

describe('columnMode', () => {
  it('探針がなければ empty（固定の値によらない）', () => {
    expect(columnMode(null, false)).toBe('empty');
    expect(columnMode(null, true)).toBe('empty');
  });
  it('探針があって固定していなければ hover、固定していれば pinned', () => {
    expect(columnMode({ x: 1, y: 2 }, false)).toBe('hover');
    expect(columnMode({ x: 1, y: 2 }, true)).toBe('pinned');
  });
});

describe('pointCell', () => {
  const v: ProbeValue[] = [{ label: '標高', value: 3.2, unit: 'm' }];
  it('読み込み済みなら sample の値', () => {
    expect(pointCell('ready', () => v)).toEqual({ state: 'values', values: v });
  });
  it('値が空なら none', () => {
    expect(pointCell('ready', () => [])).toEqual({ state: 'none', values: [] });
  });
  it('読み込み中・未読み込みは loading、失敗は error で、sample は呼ばない', () => {
    let called = 0;
    const sample = () => (called++, v);
    expect(pointCell('loading', sample).state).toBe('loading');
    expect(pointCell('idle', sample).state).toBe('loading');
    expect(pointCell('error', sample).state).toBe('error');
    expect(called).toBe(0);
  });
  it('sample が例外を投げても none にして、通知する', () => {
    const errs: unknown[] = [];
    const cell = pointCell('ready', () => { throw new Error('x'); }, (e) => errs.push(e));
    expect(cell).toEqual({ state: 'none', values: [] });
    expect(errs).toHaveLength(1);
  });
});

describe('areaCell', () => {
  const v: ProbeValue[] = [{ label: '駅', value: 38, unit: '駅' }];
  it('集計があればその値', () => {
    expect(areaCell('ready', v)).toEqual({ state: 'values', values: v });
  });
  it('集計がなければ、状態に応じて none / loading / error', () => {
    expect(areaCell('ready', undefined).state).toBe('none');
    expect(areaCell('loading', undefined).state).toBe('loading');
    expect(areaCell('idle', undefined).state).toBe('loading');
    expect(areaCell('error', undefined).state).toBe('error');
  });
});

describe('buildRows', () => {
  const ids: LayerId[] = ['shelters', 'transit', 'population', 'flood', 'elevation'];
  const sample = (id: LayerId): ProbeValue[] => [{ label: id, value: 1 }];
  const summaries = Object.fromEntries(ids.map((id) => [id, [{ label: `${id}-sum`, value: 2 }]])) as Record<LayerId, ProbeValue[]>;

  it('ids の順（上の段から）に、レイヤー名・この地点・半径内の集計を並べる', () => {
    const rows = buildRows({ ids, labels: LABELS, status: ready, sample, summaries });
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.map((r) => r.label)).toEqual(['避難', '公共交通', '人口', '浸水', '標高']);
    for (const r of rows) {
      expect(r.point.values[0].label).toBe(r.id);
      expect(r.area?.values[0].label).toBe(`${r.id}-sum`);
    }
  });
  it('summaries が null なら（hover）、area は付かない', () => {
    const rows = buildRows({ ids, labels: LABELS, status: ready, sample, summaries: null });
    expect(rows.every((r) => r.area === null)).toBe(true);
    expect(rows.every((r) => r.point.state === 'values')).toBe(true);
  });
  it('レイヤーごとに状態が違ってよい（片方が読み込み中でも、ほかは読める）', () => {
    const status = { ...ready, flood: 'loading', transit: 'error' } as Record<LayerId, LayerStatus>;
    const rows = buildRows({ ids, labels: LABELS, status, sample, summaries: { ...summaries, flood: undefined, transit: undefined } });
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.flood.point.state).toBe('loading');
    expect(by.flood.area?.state).toBe('loading');
    expect(by.transit.point.state).toBe('error');
    expect(by.transit.area?.state).toBe('error');
    expect(by.elevation.point.state).toBe('values');
  });
  it('表示していないレイヤー（ids にない）は行にならない', () => {
    const rows = buildRows({ ids: ['elevation'], labels: LABELS, status: ready, sample, summaries: null });
    expect(rows).toHaveLength(1);
  });
  it('sample の例外は、そのレイヤーの onError に渡り、ほかの行には影響しない', () => {
    const errs: LayerId[] = [];
    const rows = buildRows({
      ids,
      labels: LABELS,
      status: ready,
      sample: (id) => {
        if (id === 'flood') throw new Error('boom');
        return sample(id);
      },
      summaries: null,
      onError: (id) => errs.push(id),
    });
    expect(errs).toEqual(['flood']);
    expect(rows.find((r) => r.id === 'flood')?.point.state).toBe('none');
    expect(rows.find((r) => r.id === 'elevation')?.point.state).toBe('values');
  });
});

describe('表示用の文字列', () => {
  it('valueTitle は、レイヤー名と同じ・空の見出しを出さない', () => {
    expect(valueTitle({ label: '標高', value: 1 }, '標高')).toBeNull();
    expect(valueTitle({ label: '', value: 1 }, '標高')).toBeNull();
    expect(valueTitle({ label: '平均', value: 1 }, '標高')).toBe('平均');
  });
  it('valueText は桁区切りと単位。値がなければ「—」', () => {
    expect(valueText({ label: '人口', value: 100498, unit: '人' })).toBe('100,498 人');
    expect(valueText({ label: '標高', value: null })).toBe('—');
    expect(valueText({ label: '最寄り駅', value: '東京駅' })).toBe('東京駅');
  });
  it('areaHeading は「半径 ○ km 内」', () => {
    expect(areaHeading(1000)).toBe('半径 1 km 内');
    expect(areaHeading(5000)).toBe('半径 5 km 内');
  });
  it('coordsText は m 単位に丸めて桁区切り', () => {
    expect(coordsText({ x: 8172.4, y: -1342.6 })).toBe('x 8,172 m, y -1,343 m');
  });
});
