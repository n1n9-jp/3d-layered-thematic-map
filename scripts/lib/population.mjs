// 人口レイヤー（国勢調査の地域メッシュ統計）の表の読み取り。純粋関数。入出力は scripts/build-population.mjs が担当する。

/**
 * 秘匿処理の区分（列 HTKSYORI）。
 *  0 = 秘匿なし、1 = 合算先（周辺の秘匿メッシュの値を足してある）、2 = 秘匿（総人口と世帯数を除く列が `*`）。
 */
const SECRET_NONE = '0';
const SECRET_MERGE_TARGET = '1';
const SECRET_HIDDEN = '2';

/**
 * メッシュ統計の表（1行目が列コード、2行目が列名、3行目からデータ。カンマ区切り）を読んで、
 * メッシュコード → { population, elderly, merged } の Map にする。
 *  - population：総人口
 *  - elderly：65歳以上人口。秘匿されたメッシュ（`*`）は null
 *  - merged：合算先のメッシュか（elderly などに、周辺の秘匿メッシュの分を含む）
 * @param {string} text 文字コードを変換済みの表の全文
 * @param {{ codeLength: number, populationColumn: string, elderlyColumn: string }} spec
 */
export function parseMeshTable(text, { codeLength, populationColumn, elderlyColumn }) {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(',').map((s) => s.trim());
  const idx = Object.fromEntries(
    ['KEY_CODE', 'HTKSYORI', populationColumn, elderlyColumn].map((name) => [name, header.indexOf(name)]),
  );
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([name]) => name);
  if (missing.length > 0) throw new Error(`列が見つかりません: ${missing.join('、')}`);

  const table = new Map();
  for (let i = 2; i < lines.length; i++) {
    if (lines[i] === '') continue;
    const cols = lines[i].split(',');
    const code = cols[idx.KEY_CODE];
    if (!/^\d+$/.test(code) || code.length !== codeLength) throw new Error(`${i + 1}行目: メッシュコードが不正: ${code}`);
    const population = Number(cols[idx[populationColumn]]);
    if (!Number.isInteger(population) || population < 0) {
      throw new Error(`${i + 1}行目（${code}）: 総人口が不正: ${cols[idx[populationColumn]]}`);
    }
    const secret = cols[idx.HTKSYORI];
    if (![SECRET_NONE, SECRET_MERGE_TARGET, SECRET_HIDDEN].includes(secret)) {
      throw new Error(`${i + 1}行目（${code}）: 秘匿処理の区分が不正: ${JSON.stringify(secret)}`);
    }
    const cell = cols[idx[elderlyColumn]];
    let elderly = null;
    if (secret !== SECRET_HIDDEN) {
      elderly = Number(cell);
      if (!Number.isInteger(elderly) || elderly < 0) {
        throw new Error(`${i + 1}行目（${code}）: 65歳以上人口が不正: ${JSON.stringify(cell)}`);
      }
    } else if (cell !== '*') {
      throw new Error(`${i + 1}行目（${code}）: 秘匿のメッシュなのに 65歳以上人口が \`*\` ではありません: ${JSON.stringify(cell)}`);
    }
    table.set(code, { population, elderly, merged: secret === SECRET_MERGE_TARGET });
  }
  return table;
}

/**
 * メッシュ1個の properties に入れる高齢者の値。
 *  - 表に行がない（人口0）メッシュ：elderly 0、elderlyMerged false
 *  - 秘匿のメッシュ：elderly null
 *  - 65歳以上が総人口を上回るとき（合算先で起こる）：総人口を上限にして丸め、clamped を true にする
 * @param {{ population: number, elderly: number|null, merged: boolean }|undefined} entry
 * @returns {{ elderly: number|null, elderlyMerged: boolean, clamped: boolean }}
 */
export function elderlyOf(entry) {
  if (!entry) return { elderly: 0, elderlyMerged: false, clamped: false };
  const { population, elderly, merged } = entry;
  if (elderly === null) return { elderly: null, elderlyMerged: merged, clamped: false };
  if (elderly > population) return { elderly: population, elderlyMerged: merged, clamped: true };
  return { elderly, elderlyMerged: merged, clamped: false };
}
