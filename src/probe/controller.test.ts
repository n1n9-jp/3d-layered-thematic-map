import { beforeEach, describe, expect, it } from 'vitest';
import { initialStateFromQuery, useMapStore } from '../store';
import { installProbeKeys } from './controller';

/** window の代わりに、キー入力を手で流せる小さな受け口。 */
function fakeTarget() {
  const handlers: ((e: Event) => void)[] = [];
  return {
    addEventListener: (_: string, h: (e: Event) => void) => void handlers.push(h),
    removeEventListener: (_: string, h: (e: Event) => void) => void handlers.splice(handlers.indexOf(h), 1),
    press: (key: string) => handlers.forEach((h) => h({ key } as unknown as Event)),
    count: () => handlers.length,
  };
}

beforeEach(() => {
  useMapStore.setState({ ...initialStateFromQuery('') });
});

describe('Esc キー', () => {
  it('「地点」で固定していれば、「全体」へ戻り、固定が消える', () => {
    const t = fakeTarget();
    installProbeKeys(t as never);
    useMapStore.setState({ mode: 'point', probe: { x: 1, y: 2 }, probePinned: true });
    t.press('Escape');
    expect(useMapStore.getState()).toMatchObject({ mode: 'overview', probe: null, probePinned: false });
  });
  it('「断面」で線があれば、「全体」へ戻り、線が消える', () => {
    const t = fakeTarget();
    installProbeKeys(t as never);
    useMapStore.setState({ mode: 'section', section: { ax: 0, ay: 0, bx: 1000, by: 0 } });
    t.press('Escape');
    expect(useMapStore.getState()).toMatchObject({ mode: 'overview', section: null });
  });
  it('Esc 以外のキーでは何も変わらない。解除すると反応しない', () => {
    const t = fakeTarget();
    const off = installProbeKeys(t as never);
    useMapStore.setState({ mode: 'point' });
    t.press('a');
    expect(useMapStore.getState().mode).toBe('point');
    off();
    expect(t.count()).toBe(0);
  });
});
