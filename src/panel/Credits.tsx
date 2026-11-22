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
  /** 利用上の注意（データの前提、読み方）。出典の詳細に、データごとに添える。 */
  notes?: string[];
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
    name: '浸水想定（洪水）',
    sources: [
      {
        before: '「国土数値情報（洪水浸水想定区域データ）」（国土交通省）（',
        url: 'https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A31b-2025.html',
        after: '）を加工して作成',
      },
    ],
    asOf: '2025年度版（想定最大規模）',
    notes: [
      '想定最大規模の洪水の想定です。洪水予報河川・水位周知河川と、その他の河川を重ねた、セルごとの最大です。',
      '支川の氾濫・高潮・内水（下水・排水が追いつかない浸水）は含みません。区域の外が安全とは限りません。',
      '浸水継続時間は、浸水深 0.5m 以上が続く時間です。',
    ],
  },
  {
    name: '浸水想定（高潮）',
    sources: [
      {
        before: '「東京都港湾局『高潮浸水想定区域図』（令和6年12月改定）（',
        url: 'https://www.kouwan.metro.tokyo.lg.jp/jishin_kouwankyoku_oshirase/takashio/shinsuisoutei',
        after: '）を加工して作成」',
      },
    ],
    asOf: '令和6年12月改定（想定最大規模。堤防等の決壊を見込む）',
    notes: [
      '10m セルの浸水深の、50m セルの中の最大です。河川の氾濫・内水は含みません。',
      '浸水継続時間は、計算期間が約1週間なので、1週間以上は区別できません（「1週間以上」に上限はありません）。',
      '洪水と高潮は別々の災害の想定で、足し合わせていません。',
    ],
  },
  {
    name: '人口（65歳以上人口を含む）',
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
    name: '避難場所',
    sources: [
      {
        before: '「『指定緊急避難場所データ』（国土地理院）（',
        url: 'https://www.gsi.go.jp/bousaichiri/hinanbasho.html',
        after: '）を加工して作成」',
      },
    ],
    asOf: '区ごとに異なる（最終更新日は 2025年1月23日〜2026年10月19日）。データの取得は 2026年11月',
    notes: [
      '指定緊急避難場所は、災害の種別ごとに指定されています（洪水で使える場所が、高潮や地震でも使えるとは限りません）。',
      'データが最新でない場合や、未掲載の場合があります。収容人数は含みません。',
      '墨田区・江東区・渋谷区・葛飾区は、このデータに指定緊急避難場所を公開していません（0 件は「ない」ではなく「データがない」）。公開している区にも、洪水・高潮で使える指定が 0 件の区があります（画面は、その区の浸水の想定で、深い区と小さい区に分けて示します）。「指定がない」ことは、「避難できない」ことではありません。',
    ],
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
  { label: '東京都港湾局の高潮浸水想定区域図：クリエイティブ・コモンズ表示 4.0 国際（CC BY 4.0）', url: 'https://creativecommons.org/licenses/by/4.0/deed.ja' },
];

const SUMMARY = '出典：国土数値情報（国土交通省）、国土地理院、e-Stat（総務省統計局）、東京都港湾局のデータを加工して作成';

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
            {e.notes && (
              <ul className="cr-notes" data-testid="credits-notes">
                {e.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
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
