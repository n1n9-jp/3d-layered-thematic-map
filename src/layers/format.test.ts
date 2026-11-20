import { describe, expect, it } from 'vitest';
import { formatDistance, unique, withSuffix } from './format';

describe('format', () => {
  it('formatDistance', () => {
    expect(formatDistance(34.6)).toBe('35m');
    expect(formatDistance(0)).toBe('0m');
    expect(formatDistance(999.4)).toBe('999m');
    expect(formatDistance(999.6)).toBe('1.0km');
    expect(formatDistance(1234)).toBe('1.2km');
  });
  it('withSuffix', () => {
    expect(withSuffix('渋谷', '駅')).toBe('渋谷駅');
    expect(withSuffix('渋谷駅', '駅')).toBe('渋谷駅');
  });
  it('unique は最初に現れた順を保つ', () => {
    expect(unique(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });
});
