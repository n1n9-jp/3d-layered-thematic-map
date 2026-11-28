import { useMapStore } from '../store';
import type { UiMode } from '../store';
import { BAND, bandRows } from '../view/layout';
import './ModeBand.css';

const MODES: { id: UiMode; label: string }[] = [
  { id: 'overview', label: '全体' },
  { id: 'point', label: '地点' },
  { id: 'section', label: '断面' },
];

/**
 * 「全体」（23区全体のまとめ）、「地点」（探針とクローズアップ）、「断面」（2点の線に沿った変化）の切り替え。
 * 地図の触り方と情報の列の中身の両方を切り替える。「地点」と「断面」の行き来では、固定した地点も引いた線も保持する。「全体」を選ぶと、どちらも消える。
 */
function ModeSwitch() {
  const mode = useMapStore((s) => s.mode);
  const setMode = useMapStore((s) => s.setMode);
  return (
    <div className="mb-seg" role="group" aria-label="読み方" data-testid="mode-bar">
      {MODES.map((m) => (
        <button key={m.id} type="button" aria-pressed={mode === m.id} data-testid={`mode-${m.id}`} onClick={() => setMode(m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 切り替えのすぐ右に出す、地図での最初の操作の手がかり1行。
 * 「地点」で、まだ固定していないとき：地点の選び方。「断面」で、線を引く前（始点も置いていないとき）：線の引き方。
 * 固定したあと・線を引いたあと・始点を置いたあと（そのあとの案内は情報の列に出る）は出さない。
 */
function ModeHint() {
  const mode = useMapStore((s) => s.mode);
  const pinned = useMapStore((s) => s.probePinned);
  const line = useMapStore((s) => s.section);
  const start = useMapStore((s) => s.sectionStart);
  const text =
    mode === 'point' && !pinned ? '地図をクリックして地点を選ぶ' : mode === 'section' && !line && !start ? '地図の上で2点をクリックして線を引く' : null;
  if (!text) return null;
  return (
    <p className="mb-hint" data-testid="mode-hint" data-for={mode}>
      {text}
    </p>
  );
}

/**
 * 画面上端の帯。地図と情報の列の上にまたがって（右上のパネルの左側いっぱいに）重ね、左に題、その右に切り替えと手がかりを並べる。
 * 帯は地図の描画領域の大きさと位置を変えない。帯の空いたところのドラッグなどは、下の地図にそのまま届く。
 * mapWidth は描画領域の幅（`bandRows` が、題・切り替え・手がかりの何行への折り返しかを決める）。
 */
export default function ModeBand({ mapWidth, height, rightInset }: { mapWidth: number; height: number; rightInset: number }) {
  const rows = bandRows(mapWidth);
  const title = (
    <header className="mb-title" data-testid="page-title">
      <h1>東京23区の水害を読む地図</h1>
    </header>
  );
  const controls = (
    <>
      <ModeSwitch />
      <ModeHint />
    </>
  );
  return (
    <div
      className="mb"
      data-testid="mode-band"
      data-rows={rows}
      style={{ right: rightInset, height, padding: `${BAND.padTop}px ${BAND.pad}px ${BAND.padBottom}px`, gap: BAND.rowGap }}
    >
      {rows === 1 ? (
        <div className="mb-row">
          {title}
          {controls}
        </div>
      ) : (
        <>
          <div className="mb-row">{title}</div>
          {rows === 2 ? <div className="mb-row">{controls}</div> : <><div className="mb-row"><ModeSwitch /></div><div className="mb-row"><ModeHint /></div></>}
        </>
      )}
    </div>
  );
}
