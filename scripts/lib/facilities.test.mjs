import { describe, expect, it } from 'vitest';
import {
  findEntry,
  hospitalProperties,
  normalizeHospitalName,
  schoolName,
  schoolProperties,
  toHalfWidthAlnum,
} from './facilities.mjs';

describe('toHalfWidthAlnum', () => {
  it('全角の英数字を半角にし、それ以外は変えない', () => {
    expect(toHalfWidthAlnum('ＪＲ東京総合病院')).toBe('JR東京総合病院');
    expect(toHalfWidthAlnum('Ａｂｃ０９　ー・（）')).toBe('Abc09　ー・（）');
  });
});

describe('normalizeHospitalName', () => {
  it('前後の全角・半角スペースを除き、全角英数字を半角にする', () => {
    expect(normalizeHospitalName('　ＪＲ東京総合病院 ')).toBe('JR東京総合病院');
    expect(normalizeHospitalName('　 聖路加国際病院　')).toBe('聖路加国際病院');
  });
  it('名称の途中の空白は残す', () => {
    expect(normalizeHospitalName('医療法人　〇〇病院')).toBe('医療法人　〇〇病院');
  });
  it('null や undefined は空文字', () => {
    expect(normalizeHospitalName(null)).toBe('');
    expect(normalizeHospitalName(undefined)).toBe('');
  });
});

describe('schoolName', () => {
  it('備考があれば名称（備考）', () => {
    expect(schoolName('東京大学', '本郷キャンパス')).toBe('東京大学（本郷キャンパス）');
  });
  it('備考が null・空・空白なら名称のみ', () => {
    expect(schoolName('千代田区立麹町中学校', null)).toBe('千代田区立麹町中学校');
    expect(schoolName('千代田区立麹町中学校', '')).toBe('千代田区立麹町中学校');
    expect(schoolName('千代田区立麹町中学校', '　')).toBe('千代田区立麹町中学校');
  });
});

describe('schoolProperties', () => {
  const base = { P29_003: '16007', P29_004: '東京大学', P29_007: '1', P29_009: '本郷キャンパス' };
  it('対象の学校は kind・name・subtype を返す', () => {
    expect(schoolProperties(base)).toEqual({ kind: 'school', name: '東京大学（本郷キャンパス）', subtype: '大学' });
    expect(schoolProperties({ ...base, P29_003: '16001', P29_009: null })).toEqual({
      kind: 'school',
      name: '東京大学',
      subtype: '小学校',
    });
  });
  it('休校中は除き、調査なし（0）と開校中（1）は残す', () => {
    expect(schoolProperties({ ...base, P29_007: '2' })).toBeNull();
    expect(schoolProperties({ ...base, P29_007: '0' })).not.toBeNull();
  });
  it('幼稚園・認定こども園・各種学校・専修学校は対象外', () => {
    for (const code of ['16011', '16013', '16015', '16016']) {
      expect(schoolProperties({ ...base, P29_003: code })).toBeNull();
    }
  });
  it('対象の学校分類9種がすべて日本語名になる', () => {
    const names = ['16001', '16002', '16014', '16003', '16004', '16012', '16005', '16006', '16007'].map(
      (code) => schoolProperties({ ...base, P29_003: code, P29_009: null }).subtype,
    );
    expect(names).toEqual([
      '小学校',
      '中学校',
      '義務教育学校',
      '中等教育学校',
      '高等学校',
      '特別支援学校',
      '高等専門学校',
      '短期大学',
      '大学',
    ]);
  });
});

describe('hospitalProperties', () => {
  it('病院だけを対象にし、名称を整形する', () => {
    expect(hospitalProperties({ P04_001: 1, P04_002: '　ＪＲ東京総合病院' })).toEqual({
      kind: 'hospital',
      name: 'JR東京総合病院',
      subtype: '病院',
    });
    expect(hospitalProperties({ P04_001: 2, P04_002: '〇〇クリニック' })).toBeNull();
    expect(hospitalProperties({ P04_001: 3, P04_002: '〇〇歯科' })).toBeNull();
  });
  it('名称が空なら対象外', () => {
    expect(hospitalProperties({ P04_001: 1, P04_002: '　' })).toBeNull();
  });
});

describe('findEntry', () => {
  const data = new Uint8Array([1]);
  it('バックスラッシュ区切りの名前を末尾で照合する', () => {
    expect(findEntry({ 'P04-20_13_GML\\P04-20_13.geojson': data, 'P04-20_13_GML\\other.txt': 1 }, 'P04-20_13.geojson')).toBe(data);
  });
  it('スラッシュ区切りや、パスなしの名前にも合う', () => {
    expect(findEntry({ 'a/P04-20_13.geojson': data }, 'P04-20_13.geojson')).toBe(data);
    expect(findEntry({ 'P04-20_13.geojson': data }, 'P04-20_13.geojson')).toBe(data);
  });
  it('名前の一部だけが同じファイルには合わない', () => {
    expect(() => findEntry({ 'xP04-20_13.geojson': data }, 'P04-20_13.geojson')).toThrow();
  });
  it('見つからない・複数あるときは例外', () => {
    expect(() => findEntry({}, 'a.geojson')).toThrow();
    expect(() => findEntry({ 'x/a.geojson': data, 'y/a.geojson': data }, 'a.geojson')).toThrow();
  });
});
