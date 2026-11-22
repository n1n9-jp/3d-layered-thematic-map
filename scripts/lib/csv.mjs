// CSV の読み取り（RFC 4180 に沿った、引用符つきの CSV）。純粋関数。

/**
 * CSV の文字列を、行ごとのセルの配列にする。
 * - 先頭の BOM は取り除く
 * - ダブルクォートで囲んだセルは、中のカンマ・改行・`""`（引用符1個）をそのまま読む
 * - 行末は CRLF でも LF でもよい
 * - 空行（セルが1つで空）は捨てる
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false; // 引用符の中にいるか
  let wasQuoted = false; // いまのセルが引用符で囲まれていたか（空の "" と空セルを区別するため）

  const endCell = () => {
    row.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    const blank = row.length === 0 && cell === '' && !wasQuoted; // 空行
    endCell();
    if (!blank) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (c === ',') {
      endCell();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      if (src[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += c;
    }
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません');
  if (cell !== '' || row.length > 0 || wasQuoted) endRow();
  return rows;
}

/**
 * 1行目を列名として、2行目以降を { 列名: 値 } の配列にする。
 * 列名の前後の空白は除く。必要な列（required）が1つでもなければ例外。
 */
export function parseCsvTable(text, required = []) {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error('CSV が空です');
  const names = header.map((s) => s.trim());
  const missing = required.filter((r) => !names.includes(r));
  if (missing.length > 0) throw new Error(`CSV に列がありません: ${missing.join('、')}（実際の列: ${names.join(' | ')}）`);
  return body.map((cells, i) => {
    if (cells.length !== names.length) {
      throw new Error(`CSV の${i + 2}行目の列数が ${cells.length} です（列名は ${names.length} 個）`);
    }
    return Object.fromEntries(names.map((n, k) => [n, cells[k]]));
  });
}
