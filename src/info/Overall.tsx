import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { wholeExposure } from '../aggregate/exposure';
import type { Exposure } from '../aggregate/exposure';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
import { shelterOverview } from '../layers/shelters/model';
import type { ShelterData } from '../layers/shelters/model';
import { useMapStore } from '../store';
import type { ElevationData } from '../types';
import type { CSSProperties } from 'react';
import { DEEP_SHARE_THRESHOLD } from '../aggregate/wardExposure';
import { DEEP_NONE_COLOR, HATCH_COLOR, SHALLOW_NONE_COLOR } from '../layers/shelters/model';
import { exposureTable, scenarioNote } from './exposureModel';
import type { ExposureTable as Model } from './exposureModel';
import { namesText, overallHeadline, wardSharesText } from './overallModel';

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** 数え方と、データの注意の折りたたみの開閉。カーソルを地図に置いて列が切り替わっても、開いたままにする。 */
export const useOverallUi = create<{ notesOpen: boolean; setNotesOpen: (v: boolean) => void }>((set) => ({
  notesOpen: false,
  setNotesOpen: (v) => set({ notesOpen: v }),
}));

/**
 * 「浸水が想定される区域に住む人」の表（深さの区分ごとの人口と65歳以上人口）。23区全体と、クローズアップの円の中で同じ表を使う。
 * variant='bars'（23区全体）は、区分ごとの人口を横棒（色は浸水の段の配色）で見せ、人口が 0 の深い区分は1行にまとめ、注記は出さない（折りたたみ側に出す）。
 */
export function ExposureTable({
  exposure,
  testId,
  caption,
  variant = 'plain',
}: {
  exposure: Exposure;
  testId: string;
  caption: string;
  variant?: 'plain' | 'bars';
}) {
  const t: Model = exposureTable(exposure);
  const bars = variant === 'bars';
  // 人口が 0 の区分（浸水なしを除く）は、棒にならないので1行にまとめる
  const shown = bars ? t.rows.filter((r) => r.peopleValue > 0 || r.key === '0') : t.rows;
  const empty = bars ? t.rows.filter((r) => r.peopleValue <= 0 && r.key !== '0') : [];
  return (
    <section className={`ex${bars ? ' ex-bars' : ''}`} data-testid={testId} data-scenario={exposure.scenario}>
      <h3 className="ex-title">{caption}</h3>
      <div className="ex-scenario" data-testid={`${testId}-scenario`}>
        想定：{t.scenario}
      </div>
      <table className="ex-table">
        <thead>
          <tr>
            <th scope="col">浸水の深さ</th>
            {bars && <th scope="col" aria-hidden="true" />}
            <th scope="col">人口（人）</th>
            <th scope="col">{bars ? 'うち65歳以上' : 'うち65歳以上（人）'}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.key} data-rank={r.key} data-testid={`${testId}-row`}>
              <th scope="row">
                <span className="ex-swatch" style={{ background: rgb(r.color) }} />
                {r.label}
              </th>
              {bars && (
                <td className="ex-barcell" aria-hidden="true">
                  <span className="ex-bar">
                    <span style={{ width: `${(r.barRatio * 100).toFixed(1)}%`, background: rgb(r.color) }} />
                  </span>
                </td>
              )}
              <td data-col="people">
                {r.people} <span className="ic-dim">{r.share}</span>
              </td>
              <td data-col="elderly">{r.elderly}</td>
            </tr>
          ))}
          {empty.length > 0 && (
            <tr className="ex-empty" data-testid={`${testId}-empty`} data-ranks={empty.map((r) => r.key).join(',')}>
              <th scope="row" colSpan={bars ? 4 : 3}>
                {empty
                  .map((r) => r.label)
                  .reverse()
                  .join('・')}
                ：想定される区域に住む人なし（0 人）
              </th>
            </tr>
          )}
          <tr className="ex-total" data-testid={`${testId}-total`}>
            <th scope="row">合計</th>
            {bars && <td />}
            <td data-col="people">{t.total.people}</td>
            <td data-col="elderly">{t.total.elderly}</td>
          </tr>
          {t.belowSea && (
            <tr className="ex-below" data-testid={`${testId}-below`}>
              <th scope="row">標高 0m 未満の土地</th>
              {bars && <td />}
              <td data-col="people">{t.belowSea.people}</td>
              <td data-col="elderly">{t.belowSea.elderly}</td>
            </tr>
          )}
        </tbody>
      </table>
      {!bars && (
        <div className="ex-notes">
          {t.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function Swatch({ kind }: { kind: 'hatch' | 'hatch-deep' | 'alert' | 'faint' }) {
  const color = kind === 'hatch' ? HATCH_COLOR : kind === 'faint' ? SHALLOW_NONE_COLOR : DEEP_NONE_COLOR;
  return <span className={`lp-swatch lp-swatch-${kind} ov-sw`} style={{ '--sw': color.join(',') } as CSSProperties} aria-hidden="true" />;
}

/**
 * 洪水・高潮用の避難場所が、このデータで区内に確認できない区。
 * 主題の枠は、浸水が深い区（指定がない区と、データ未公開の区を合わせた数）。内訳の2つは意味が違う（載っていて 0 件／載っていないので分からない）ので、数と区名を分けて出す。
 * 浸水が小さい区（データ未公開と、指定がない区）は、その下に小さく添える。
 */
function ShelterGaps({ o }: { o: ReturnType<typeof shelterOverview> }) {
  return (
    <>
      {o.deepWithoutShelter.length > 0 && (
        <section className="ov-alert" data-testid="overall-deep">
          <div className="ov-kicker">
            <Swatch kind="alert" />
            浸水が深く、このデータで区内に洪水・高潮用の避難場所が確認できない区
          </div>
          <div className="ov-alert-main">
            <span className="ov-num ov-num-alert" data-testid="overall-deep-count">
              {o.deepWithoutShelter.length}
            </span>
            <span className="ov-unit">区</span>
            <span className="ov-alert-sub">区名のあとの数字は、区の人口のうち深さ 3m 以上の区域に住む人の割合（どの区も {Math.round(DEEP_SHARE_THRESHOLD * 100)}% 以上）</span>
          </div>
          <ul className="ov-split">
            {o.deepNone.length > 0 && (
              <li data-testid="overall-deep-none">
                <Swatch kind="alert" />
                <span>
                  <b>
                    指定がない <span data-testid="overall-deep-none-count">{o.deepNone.length}</span> 区
                  </b>
                  ：<span data-testid="overall-deep-none-names">{wardSharesText(o.deepNone)}</span>
                  <span className="ov-split-note">
                    洪水・高潮用の指定が 0 件（地震・火事などの{o.deepNone.map((w) => `${w.total} か所`).join('・')}のみ）
                  </span>
                </span>
              </li>
            )}
            {o.unpublishedDeep.length > 0 && (
              <li data-testid="overall-deep-unpublished">
                <Swatch kind="hatch-deep" />
                <span>
                  <b>
                    データ未公開 <span data-testid="overall-deep-unpublished-count">{o.unpublishedDeep.length}</span> 区
                  </b>
                  ：<span data-testid="overall-deep-unpublished-names">{wardSharesText(o.unpublishedDeep)}</span>
                  <span className="ov-split-note">このデータに指定緊急避難場所が載っていないので、あるかどうかは分かりません</span>
                </span>
              </li>
            )}
          </ul>
        </section>
      )}
      <ul className="ov-gaps">
        {o.unpublishedShallow.length > 0 && (
          <li data-testid="overall-unpublished">
            <Swatch kind="hatch" />
            <span>
              <b>データ未公開で浸水が小さい</b>：{wardSharesText(o.unpublishedShallow)}（深さ 3m 以上の区域に住む人の割合）。「ない」とは限りません。
            </span>
          </li>
        )}
        {o.shallowNone.length > 0 && (
          <li data-testid="overall-shallow">
            <Swatch kind="faint" />
            <span>
              <b>指定がなく浸水が小さい</b>：{wardSharesText(o.shallowNone)}（同じ割合）。
            </span>
          </li>
        )}
      </ul>
    </>
  );
}

/** 数え方・データの注意。既定では折りたたむ。 */
function Notes({ exposure, shelters }: { exposure: Exposure | null; shelters: ShelterData | null }) {
  const open = useOverallUi((s) => s.notesOpen);
  const setOpen = useOverallUi((s) => s.setNotesOpen);
  const o = shelters ? shelterOverview(shelters) : null;
  const t = exposure ? exposureTable(exposure) : null;
  const root = useRef<HTMLElement>(null);
  const first = useRef(true);
  // 開いたときに、注記の頭が見える位置までスクロールする（開いたのに、画面の外に出たままにならないように）
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (open) root.current?.scrollIntoView({ block: 'start' });
  }, [open]);
  return (
    <section className="ov-notes" data-testid="overall-notes" data-open={open} ref={root}>
      <button type="button" className="ov-toggle" aria-expanded={open} aria-controls="overall-notes-body" onClick={() => setOpen(!open)} data-testid="overall-notes-toggle">
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> 数え方とデータの注意
      </button>
      {open && (
        <div id="overall-notes-body" className="ov-notes-body" data-testid="overall-notes-body">
          {t && (
            <>
              <h4>数え方</h4>
              {t.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
              <p>「大きいほう」は、洪水と高潮を足し合わせません。地点ごとに、深いほうの想定を採ります。</p>
              <p>標高 0m 未満の土地は、メッシュの中心を含む標高のセルが 0m 未満のメッシュの人口です（想定の切り替えによりません）。</p>
            </>
          )}
          {o && (
            <>
              <h4>避難場所の読み方</h4>
              <p>
                洪水・高潮で使える避難場所 {o.usable.toLocaleString('ja-JP')} か所のほか、地震・火事などの避難場所が {o.other.toLocaleString('ja-JP')} か所、病院が{' '}
                {o.hospitals.toLocaleString('ja-JP')} 院あります。
              </p>
              <p>指定緊急避難場所は、災害の種別ごとに指定されています。データは最新でない場合や、未掲載の場合があります（国土地理院、{o.updated} 更新分）。収容人数は含みません。</p>
              <p>
                「指定がない」ことは「避難できない」ことではありません。このデータから分かるのは、洪水・高潮で使える指定緊急避難場所が載っているかどうかまでで、各区の避難の計画は分かりません。
              </p>
              <p>
                洪水・高潮で使える避難場所が区内に確認できない区（洪水・高潮用の指定が 0 件の区と、データ未公開の区）は、どちらも、深さ 3m 以上の区域に住む人が区の人口の{' '}
                {Math.round(DEEP_SHARE_THRESHOLD * 100)}% 以上かどうかで、浸水が深い区と小さい区に分けています（洪水と高潮の大きいほうの想定。区の名前は決め打ちにせず、データから求めます）。
              </p>
              <p>
                分け方は 4 通りです。<b>指定がない</b>（データに載っていて、洪水・高潮用が 0 件）で浸水が深い区：
                {wardSharesText(o.deepNone) || '該当なし'}。<b>データ未公開</b>（このデータに指定緊急避難場所が載っていない。あるかどうかは分からない）で浸水が深い区：
                {wardSharesText(o.unpublishedDeep) || '該当なし'}。<b>データ未公開</b>で浸水が小さい区：{wardSharesText(o.unpublishedShallow) || '該当なし'}。
                <b>指定がない</b>で浸水が小さい区：{wardSharesText(o.shallowNone) || '該当なし'}。
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** 何も選んでいないときの、23区全体の集計。 */
export default function Overall() {
  const status = useMapStore((s) => s.status);
  const data = useMapStore((s) => s.data);
  const scenario = useMapStore((s) => s.options.floodScenario);
  const needed = (['population', 'flood'] as const).every((k) => status[k] === 'ready');
  const failed = (['population', 'flood'] as const).some((k) => status[k] === 'error');
  let exposure: Exposure | null = null;
  if (needed) {
    try {
      exposure = wholeExposure(
        data.population as PopulationData,
        data.flood as FloodData,
        scenario,
        status.elevation === 'ready' ? (data.elevation as ElevationData) : null,
      );
    } catch (e) {
      console.error('[overall] exposure', e);
    }
  }
  const shelters = status.shelters === 'ready' ? (data.shelters as ShelterData) : null;
  const o = shelters ? shelterOverview(shelters) : null;
  const head = exposure ? overallHeadline(exposure) : null;
  const table = exposure ? exposureTable(exposure) : null;
  return (
    <div className="ov" data-testid="overall">
      <h2 className="ov-title">23区全体：水害の想定と、避難できる場所</h2>
      {exposure && head && table ? (
        <>
          <section className="ov-scen" data-testid="overall-scenario">
            <span className="ov-chip">想定：{table.scenario}</span>
            <span className="ov-scen-note">{scenarioNote(exposure.scenario)}</span>
          </section>
          <section className="ov-hero" data-testid="overall-lead">
            <div className="ov-kicker">深さ 3m 以上の浸水が想定される区域に住む人</div>
            <div className="ov-hero-main">
              <span className="ov-bignum" data-testid="overall-severe" title={head.severe.people.exact}>
                {head.severe.people.approx}
              </span>
              <span className="ov-hero-sub">
                うち65歳以上 <b data-testid="overall-severe-elderly" title={head.severe.elderly.exact}>{head.severe.elderly.approx}</b>
              </span>
            </div>
            <p className="ov-note" data-testid="overall-flooded">
              浸水が想定される区域全体（0.5m 未満を含む）では {head.flooded.approx}。正確な値は下の表にあります。
            </p>
          </section>
          <div className="ov-pair">
            {head.belowSea && (
              <section className="ov-card" data-testid="overall-below">
                <div className="ov-kicker">標高 0m 未満の土地に住む人</div>
                <div className="ov-num" title={head.belowSea.exact}>
                  {head.belowSea.approx}
                </div>
                <div className="ov-note">想定の切り替えによりません</div>
              </section>
            )}
            {o && (
              <section className="ov-card" data-testid="overall-shelters">
                <div className="ov-kicker">洪水・高潮で使える避難場所</div>
                <div className="ov-num">
                  <span data-testid="overall-usable">{o.usable.toLocaleString('ja-JP')}</span>
                  <span className="ov-unit">か所</span>
                </div>
                <div className="ov-note">23区の合計。区による偏りが大きい</div>
              </section>
            )}
          </div>
        </>
      ) : (
        <p className="ic-dim">{failed ? '集計に使うデータの読み込みに失敗しました' : '集計中…（人口と浸水想定の読み込みを待っています）'}</p>
      )}
      {o ? <ShelterGaps o={o} /> : <p className="ic-dim">避難場所の読み込み中…</p>}
      {exposure && <ExposureTable exposure={exposure} testId="overall-exposure" caption="浸水の深さの区分ごとの人口" variant="bars" />}
      <Notes exposure={exposure} shelters={shelters} />
    </div>
  );
}
