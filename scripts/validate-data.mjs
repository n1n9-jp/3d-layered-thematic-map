// データ仕様の検証。使い方:
//   node scripts/validate-data.mjs [ディレクトリ] [--require-all]
// ディレクトリ省略時はリポジトリの public/data（実行したディレクトリには依存しない）。違反があれば終了コード 1（引数・ディレクトリの誤りは 2）。
import { DATA_DIR } from './lib/paths.mjs';
import { formatReport, validateDirectory } from './lib/validate.mjs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const unknown = flags.filter((f) => f !== '--require-all');

if (unknown.length > 0 || positional.length > 1) {
  console.error('使い方: node scripts/validate-data.mjs [ディレクトリ] [--require-all]');
  process.exit(2);
}

try {
  const report = await validateDirectory(positional[0] ?? DATA_DIR, {
    requireAll: flags.includes('--require-all'),
  });
  console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
