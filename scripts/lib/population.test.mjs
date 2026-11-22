import { describe, expect, it } from 'vitest';
import { elderlyOf, parseMeshTable } from './population.mjs';

const SPEC = { codeLength: 10, populationColumn: 'T001142001', elderlyColumn: 'T001142019' };
// 1行目：列コード、2行目：列名、3行目〜：データ。列は KEY_CODE, HTKSYORI, HTKSAKI, GASSAN, 総人口, 65歳以上
const table = (...rows) =>
  ['KEY_CODE,HTKSYORI,HTKSAKI,GASSAN,T001142001,T001142019', ',,,,　人口（総数）,　６５歳以上人口　総数', ...rows].join('\r\n') + '\r\n';

describe('parseMeshTable', () => {
  const map = parseMeshTable(
    table(
      '5339000541,2,5339000544,,3,*', // 秘匿
      '5339000542,2,5339000544,,6,*', // 秘匿
      '5339000544,1,,5339000541;5339000542,42,50', // 合算先（周辺の秘匿分を含み、総人口を上回る）
      '5339000551,0,,,100,25', // 通常
      '5339000552,0,,,0,0', // 人口0の行
    ),
    SPEC,
  );

  it('総人口は、秘匿のメッシュでも読む', () => {
    expect(map.get('5339000541').population).toBe(3);
  });
  it('秘匿（HTKSYORI=2）のメッシュの 65歳以上は null', () => {
    expect(map.get('5339000541')).toEqual({ population: 3, elderly: null, merged: false });
  });
  it('合算先（HTKSYORI=1）は merged: true で、値はそのまま（総人口を上回ってもここでは丸めない）', () => {
    expect(map.get('5339000544')).toEqual({ population: 42, elderly: 50, merged: true });
  });
  it('通常のメッシュと、人口0の行', () => {
    expect(map.get('5339000551')).toEqual({ population: 100, elderly: 25, merged: false });
    expect(map.get('5339000552')).toEqual({ population: 0, elderly: 0, merged: false });
  });
  it('行のないメッシュは Map にない', () => {
    expect(map.has('5339000553')).toBe(false);
  });

  it('列が見つからなければ、列名を示して例外', () => {
    expect(() => parseMeshTable(table('5339000551,0,,,1,1'), { ...SPEC, elderlyColumn: 'T001142099' })).toThrow('T001142099');
  });
  it('メッシュコードの桁数や、総人口・秘匿の区分・65歳以上の値が不正なら例外（行番号つき）', () => {
    expect(() => parseMeshTable(table('533900055,0,,,1,1'), SPEC)).toThrow('3行目');
    expect(() => parseMeshTable(table('5339000551,0,,,x,1'), SPEC)).toThrow('総人口');
    expect(() => parseMeshTable(table('5339000551,9,,,1,1'), SPEC)).toThrow('秘匿処理の区分');
    expect(() => parseMeshTable(table('5339000551,0,,,1,*'), SPEC)).toThrow('65歳以上人口');
    expect(() => parseMeshTable(table('5339000551,2,,,1,3'), SPEC)).toThrow('`*`');
  });
});

describe('elderlyOf', () => {
  it('行がない（人口0の）メッシュは elderly 0、合算先ではない', () => {
    expect(elderlyOf(undefined)).toEqual({ elderly: 0, elderlyMerged: false, clamped: false });
  });
  it('秘匿のメッシュは elderly null', () => {
    expect(elderlyOf({ population: 3, elderly: null, merged: false })).toEqual({ elderly: null, elderlyMerged: false, clamped: false });
  });
  it('通常のメッシュはそのまま', () => {
    expect(elderlyOf({ population: 100, elderly: 25, merged: false })).toEqual({ elderly: 25, elderlyMerged: false, clamped: false });
  });
  it('合算先は elderlyMerged: true。総人口を上回れば総人口に丸め、丸めたことを示す', () => {
    expect(elderlyOf({ population: 42, elderly: 40, merged: true })).toEqual({ elderly: 40, elderlyMerged: true, clamped: false });
    expect(elderlyOf({ population: 42, elderly: 50, merged: true })).toEqual({ elderly: 42, elderlyMerged: true, clamped: true });
  });
  it('総人口と同じ値は、丸めたことにしない', () => {
    expect(elderlyOf({ population: 42, elderly: 42, merged: true }).clamped).toBe(false);
  });
});
