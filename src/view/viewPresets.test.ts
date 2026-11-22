import { describe, expect, it } from 'vitest';
import { DEFAULT_ANGLES, VIEW_LIMITS } from '../config';
import { projectPoint } from './camera';
import { ORBIT_STEP, VIEW_PRESETS, matchPreset, orbitDiff, requestView, resolveAngles, selectedPreset, subscribeViewCommand } from './viewPresets';
import type { ViewCommand } from './viewPresets';

describe('VIEW_PRESETS', () => {
  it('真上・斜め・正面の角度', () => {
    expect(VIEW_PRESETS.top).toMatchObject({ rotationX: 90, rotationOrbit: 0 });
    expect(VIEW_PRESETS.oblique).toMatchObject(DEFAULT_ANGLES);
    expect(VIEW_PRESETS.front.rotationOrbit).toBe(0);
  });
  it('正面は、完全な水平ではなく、下限より上の低い角度（10〜15度）', () => {
    const { rotationX } = VIEW_PRESETS.front;
    expect(rotationX).toBeGreaterThanOrEqual(10);
    expect(rotationX).toBeLessThanOrEqual(15);
    expect(rotationX).toBeGreaterThan(VIEW_LIMITS.minRotationX);
  });
});

describe('orbitDiff', () => {
  it('360度の整数倍の違いは0、最大は180', () => {
    expect(orbitDiff(0, 360)).toBe(0);
    expect(orbitDiff(-45, 315)).toBe(0);
    expect(orbitDiff(10, 350)).toBe(20);
    expect(orbitDiff(0, 180)).toBe(180);
    expect(orbitDiff(0, -180)).toBe(180);
  });
});

describe('resolveAngles', () => {
  it('決まった視点へは、方位を近い向きに回る', () => {
    expect(resolveAngles({ type: 'preset', id: 'top' }, { rotationX: 30, rotationOrbit: 350 })).toEqual({ rotationX: 90, rotationOrbit: 360 });
    expect(resolveAngles({ type: 'preset', id: 'front' }, { rotationX: 90, rotationOrbit: -100 })).toEqual({ rotationX: 12, rotationOrbit: 0 });
    expect(resolveAngles({ type: 'preset', id: 'oblique' }, { rotationX: 90, rotationOrbit: 370 })).toEqual({ ...DEFAULT_ANGLES, rotationOrbit: 405 });
    expect(resolveAngles({ type: 'preset', id: 'oblique' }, { rotationX: 50, rotationOrbit: 45 })).toEqual(DEFAULT_ANGLES);
  });
  it('回す操作は、傾きを保って方位を45度動かす', () => {
    expect(resolveAngles({ type: 'rotate', dir: -1 }, { rotationX: 33, rotationOrbit: 10 })).toEqual({ rotationX: 33, rotationOrbit: 55 });
    expect(resolveAngles({ type: 'rotate', dir: 1 }, { rotationX: 33, rotationOrbit: 10 })).toEqual({ rotationX: 33, rotationOrbit: -35 });
  });
  it('右へ8回で元の方位に戻る（左も同じ）', () => {
    for (const dir of [1, -1] as const) {
      let a = { rotationX: 20, rotationOrbit: 45 };
      for (let i = 0; i < 360 / ORBIT_STEP; i++) a = resolveAngles({ type: 'rotate', dir }, a);
      expect(a.rotationX).toBe(20);
      expect(orbitDiff(a.rotationOrbit, 45)).toBe(0);
    }
  });
  it('右へ回すと、見下ろした地図は時計回りに、左へは反時計回りに回る', () => {
    // 真上から見て、北の点が画面の上から、右へ回すと右へ寄る（画面の y は下向き）
    const size = { width: 800, height: 800 };
    const north = (rotationOrbit: number) => {
      const [x, y] = projectPoint({ target: [0, 0, 0], rotationX: 90, rotationOrbit, zoom: 0 }, size, [0, 100, 0]);
      return [x - 400, y - 400];
    };
    const right = north(resolveAngles({ type: 'rotate', dir: 1 }, { rotationX: 90, rotationOrbit: 0 }).rotationOrbit);
    const left = north(resolveAngles({ type: 'rotate', dir: -1 }, { rotationX: 90, rotationOrbit: 0 }).rotationOrbit);
    expect(right[0]).toBeGreaterThan(0);
    expect(left[0]).toBeLessThan(0);
  });
});

describe('matchPreset', () => {
  it('3つの視点と一致すればその ID', () => {
    expect(matchPreset({ rotationX: 90, rotationOrbit: 0 })).toBe('top');
    expect(matchPreset({ rotationX: 20, rotationOrbit: 45 })).toBe('oblique');
    expect(matchPreset({ rotationX: 12, rotationOrbit: 0 })).toBe('front');
  });
  it('方位は360度の整数倍の違いを区別しない', () => {
    expect(matchPreset({ rotationX: 90, rotationOrbit: 360 })).toBe('top');
    expect(matchPreset({ rotationX: 20, rotationOrbit: -315 })).toBe('oblique');
  });
  it('許容（0.5度）の内側なら一致、外側なら null', () => {
    expect(matchPreset({ rotationX: 20.4, rotationOrbit: 45.4 })).toBe('oblique');
    expect(matchPreset({ rotationX: 20.6, rotationOrbit: 45 })).toBeNull();
    expect(matchPreset({ rotationX: 20, rotationOrbit: 44.4 })).toBeNull();
  });
  it('どれとも違う角度は null（方位を45度回した後など）', () => {
    expect(matchPreset({ rotationX: 20, rotationOrbit: 90 })).toBeNull();
    expect(matchPreset({ rotationX: 45, rotationOrbit: 0 })).toBeNull();
  });
});

describe('selectedPreset', () => {
  const vs = { rotationX: 90, rotationOrbit: 0 };
  it('自動で収める状態で、角度が一致していれば選択中', () => {
    expect(selectedPreset({ viewState: vs, autoFit: true, solo: null })).toBe('top');
  });
  it('ドラッグなどで動かした後（autoFit が false）は選択中にならない', () => {
    expect(selectedPreset({ viewState: vs, autoFit: false, solo: null })).toBeNull();
  });
  it('単独表示のあいだは選択中にならない', () => {
    expect(selectedPreset({ viewState: vs, autoFit: true, solo: 'flood' })).toBeNull();
  });
});

describe('requestView', () => {
  it('購読者に命令を渡し、解除後は渡さない', () => {
    const got: ViewCommand[] = [];
    const off = subscribeViewCommand((c) => got.push(c));
    requestView({ type: 'preset', id: 'front' });
    off();
    requestView({ type: 'rotate', dir: 1 });
    expect(got).toEqual([{ type: 'preset', id: 'front' }]);
  });
});
