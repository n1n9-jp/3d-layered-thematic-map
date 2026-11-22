import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../config';
import { selectionSummary } from './selectionSummary';

describe('selectionSummary', () => {
  it('既定のままなら何も添えない', () => {
    for (const id of ['elevation', 'flood', 'population', 'transit', 'shelters'] as const) expect(selectionSummary(id, DEFAULT_OPTIONS)).toBeNull();
  });
  it('浸水は想定と見るもの', () => {
    expect(selectionSummary('flood', { ...DEFAULT_OPTIONS, floodScenario: 'tide' })).toBe('高潮・深さ');
    expect(selectionSummary('flood', { ...DEFAULT_OPTIONS, floodView: 'duration' })).toBe('大きいほう・期間');
    expect(selectionSummary('flood', { ...DEFAULT_OPTIONS, floodScenario: 'river', floodView: 'duration' })).toBe('洪水・期間');
  });
  it('人口は65歳以上のときだけ', () => {
    expect(selectionSummary('population', { ...DEFAULT_OPTIONS, populationView: 'elderly' })).toBe('65歳以上');
  });
  it('ほかのレイヤーは、浸水・人口の切り替えがあっても添えない', () => {
    expect(selectionSummary('shelters', { ...DEFAULT_OPTIONS, floodScenario: 'tide', populationView: 'elderly' })).toBeNull();
  });
});
