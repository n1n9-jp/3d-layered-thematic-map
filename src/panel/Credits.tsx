import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import './Credits.css';

interface Source {
  /** 出典の文面の前半（リンクの直前まで）。 */
  before: string;
  url: string;
  /** 出典の文面の後半（リンクの直後から）。 */
  after: string;
}

interface Entry {
  name: string;
  sources: Source[];
  /** データの基準時点。 */
  asOf: string;
}

const ENTRIES: Entry[] = [
  {
    name: '区の境界',
    sources: [
      {
        before: '「国土数値情報（行政区域データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2026年1月1日',
  },
  {
    name: '標高',
    sources: [
      {
        before: '「標高タイル（基盤地図情報数値標高モデル）」（国土地理院）（',
        url: 'https://maps.gsi.go.jp/development/ichiran.html',
        after: '）をもとに作成',
      },
    ],
    asOf: '航空レーザ測量による5mメッシュ（DEM5A）',
  },
  {
    name: '人口',
    sources: [
      {
        before: '総務省統計局「令和2年国勢調査 地域メッシュ統計（250mメッシュ、世界測地系）」政府統計の総合窓口(e-Stat)（',
        url: 'https://www.e-stat.go.jp/',
        after: '）を加工して作成',
      },
    ],
    asOf: '2020年10月1日（国勢調査）',
  },
  {
    name: '道路',
    sources: [
      {
        before: '「国土数値情報（道路データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N13-2024.html',
        after: '）を加工して作成。',
      },
      {
        before: '高速道路の路線名は「国土数値情報（高速道路時系列データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2024年9月',
  },
  {
    name: '鉄道と駅',
    sources: [
      {
        before: '「国土数値情報（鉄道データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02-2025.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2025年12月31日',
  },
  {
    name: '学校',
    sources: [
      {
        before: '「国土数値情報（学校データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P29-2023.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2023年度',
  },
  {
    name: '病院',
    sources: [
      {
        before: '「国土数値情報（医療機関データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P04-2020.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2020年度',
  },
];

const TERMS = [
  { label: '国土数値情報の利用規約', url: 'https://nlftp.mlit.go.jp/ksj/other/agreement.html' },
  { label: '政府統計の総合窓口(e-Stat)の利用規約', url: 'https://www.e-stat.go.jp/terms-of-use' },
  { label: '国土地理院コンテンツ利用規約', url: 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html' },
];

const SUMMARY = '出典：国土数値情報（国土交通省）、国土地理院、e-Stat（総務省統計局）のデータを加工して作成';

const External = ({ href, children }: { href: string; children: string }) => (
  <a href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

export interface CreditsProps {
  /** 位置と大きさの指定。例: `{ position: 'absolute', right: 12, bottom: 12 }`。部品自身は位置を決めない。 */
  style?: CSSProperties;
  className?: string;
  /** 詳細を開く向き。画面の下端に置くなら 'up'（既定）、上端なら 'down'。 */
  opens?: 'up' | 'down';
}

/** 画面の隅に置く出典表示。常に1行の出典を見せ、押すと各データの出典と配布元へのリンクを開く。 */
export default function Credits({ style, className, opens = 'up' }: CreditsProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const barRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Esc で閉じたあとは、開閉ボタンへフォーカスを戻す
  useEffect(() => {
    if (!open && restoreFocus.current) {
      restoreFocus.current = false;
      barRef.current?.focus();
    }
  }, [open]);

  // フォーカスが部品の中にあるときの Esc は、ここで閉じるだけにする（探針の固定解除には伝えない）。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      restoreFocus.current = true;
      setOpen(false);
    }
  };

  const arrowUp = opens === 'up' ? !open : open;

  const detail = open && (
    <section id={detailId} className="cr-detail" aria-label="データの出典">
      <div className="cr-head">
        <h2 className="cr-title">データの出典</h2>
        <button type="button" className="cr-close" onClick={() => setOpen(false)}>
          閉じる
        </button>
      </div>
      <ul className="cr-list">
        {ENTRIES.map((e) => (
          <li key={e.name}>
            <div className="cr-name">{e.name}</div>
            <p className="cr-text">
              {e.sources.map((s) => (
                <span key={s.url}>
                  {s.before}
                  <External href={s.url}>{s.url}</External>
                  {s.after}
                </span>
              ))}
            </p>
            <div className="cr-asof">基準時点：{e.asOf}</div>
          </li>
        ))}
      </ul>
      <div className="cr-terms">
        利用規約
        <ul>
          {TERMS.map((t) => (
            <li key={t.url}>
              <External href={t.url}>{t.label}</External>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );

  return (
    <div className={className ? `cr ${className}` : 'cr'} style={style} onKeyDown={onKeyDown}>
      {opens === 'up' && detail}
      <button
        ref={barRef}
        type="button"
        className="cr-bar"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cr-bar-text">{SUMMARY}</span>
        <span className="cr-more" aria-hidden="true">
          詳細 {arrowUp ? '▴' : '▾'}
        </span>
      </button>
      {opens === 'down' && detail}
    </div>
  );
}
