import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** リポジトリのルート（このファイルは `scripts/lib/` にあるので2階層上）。実行時のカレントディレクトリには依存しない。 */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** ダウンロードしたデータのキャッシュ置き場。 */
export const CACHE_DIR = path.join(ROOT_DIR, '.cache');

/** 前処理の生成物の置き場。 */
export const DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
