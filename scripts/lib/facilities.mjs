// 施設レイヤー（学校・病院）の純粋な処理。入出力は scripts/build-facilities.mjs が担当する。

/** 対象にする学校分類（P29_003）→ subtype（学校種別の日本語名）。 */
export const SCHOOL_SUBTYPES = new Map([
  ['16001', '小学校'],
  ['16002', '中学校'],
  ['16014', '義務教育学校'],
  ['16003', '中等教育学校'],
  ['16004', '高等学校'],
  ['16012', '特別支援学校'],
  ['16005', '高等専門学校'],
  ['16006', '短期大学'],
  ['16007', '大学'],
]);

/** 休校中を表す P29_007 の値。 */
const CLOSED = '2';

/** 医療機関分類（P04_001）で病院を表す値。 */
const HOSPITAL = 1;

/** 全角の英数字を半角にする。 */
export function toHalfWidthAlnum(text) {
  return text.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/** 前後の空白（全角スペースを含む）を除く。 */
export function trimSpaces(text) {
  return text.replace(/^[\s　]+|[\s　]+$/g, '');
}

/** 病院名の整形：前後の空白を除き、全角の英数字を半角にする。 */
export function normalizeHospitalName(name) {
  return toHalfWidthAlnum(trimSpaces(String(name ?? '')));
}

/** 学校名の整形：備考（キャンパス名など）があれば「名称（備考）」。 */
export function schoolName(name, remark) {
  const base = trimSpaces(String(name ?? ''));
  const note = remark == null ? '' : trimSpaces(String(remark));
  return note ? `${base}（${note}）` : base;
}

/**
 * 学校データ（P29）の Feature から、施設の properties を作る。対象外（対象外の分類、休校中、名称なし）は null。
 * 位置の絞り込みは呼び出し側で行う。
 */
export function schoolProperties(properties) {
  const subtype = SCHOOL_SUBTYPES.get(String(properties.P29_003));
  if (!subtype) return null;
  if (String(properties.P29_007) === CLOSED) return null;
  const name = schoolName(properties.P29_004, properties.P29_009);
  if (!name) return null;
  return { kind: 'school', name, subtype };
}

/** 医療機関データ（P04）の Feature から、施設の properties を作る。病院以外・名称なしは null。 */
export function hospitalProperties(properties) {
  if (Number(properties.P04_001) !== HOSPITAL) return null;
  const name = normalizeHospitalName(properties.P04_002);
  if (!name) return null;
  return { kind: 'hospital', name, subtype: '病院' };
}

/**
 * ZIP を展開した { ファイル名: データ } から、名前の末尾が suffix のエントリを探す。
 * 区切りがバックスラッシュの ZIP でも、スラッシュでも、ファイル名だけでも照合できる。
 */
export function findEntry(files, suffix) {
  const names = Object.keys(files).filter(
    (n) => n === suffix || (n.endsWith(suffix) && /[\\/]/.test(n.charAt(n.length - suffix.length - 1))),
  );
  if (names.length !== 1) throw new Error(`ZIP の中の ${suffix} が ${names.length} 個見つかりました（1個のはず）`);
  return files[names[0]];
}
