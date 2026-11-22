import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvTable } from './csv.mjs';

describe('parseCsv', () => {
  it('単純な CSV を、行ごとのセルにする（CRLF でも LF でも、最後の改行の有無によらない）', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('先頭の BOM を取り除く', () => {
    expect(parseCsv('﻿NO,共通ID\n1,E1\n')).toEqual([['NO', '共通ID'], ['1', 'E1']]);
  });

  it('引用符で囲んだセルの中のカンマ・改行・引用符（""）をそのまま読む', () => {
    expect(parseCsv('a,"x,y","line1\nline2","say ""hi"""\n')).toEqual([['a', 'x,y', 'line1\nline2', 'say "hi"']]);
  });

  it('空のセルと、空の引用符のセルを読める（末尾の空セルも落とさない）', () => {
    expect(parseCsv('1,,3,\n')).toEqual([['1', '', '3', '']]);
    expect(parseCsv('"",x\n')).toEqual([['', 'x']]);
  });

  it('空行は捨てる', () => {
    expect(parseCsv('a\n\nb\n\n')).toEqual([['a'], ['b']]);
  });

  it('引用符が閉じていなければ例外', () => {
    expect(() => parseCsv('a,"b\n')).toThrow('引用符');
  });
});

describe('parseCsvTable', () => {
  it('1行目の列名で、{ 列名: 値 } にする', () => {
    expect(parseCsvTable('名,値\nx,1\ny,2\n')).toEqual([{ 名: 'x', 値: '1' }, { 名: 'y', 値: '2' }]);
  });

  it('必要な列がなければ、足りない列名を示して例外', () => {
    expect(() => parseCsvTable('a,b\n1,2\n', ['a', 'c'])).toThrow('c');
  });

  it('列数が列名と違う行は、行番号を示して例外', () => {
    expect(() => parseCsvTable('a,b\n1,2\n3\n')).toThrow('3行目');
  });
});
