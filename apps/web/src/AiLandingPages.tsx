import { useEffect, useState } from "react";

import { exportDailyCsvUrl, getAiLandingPages, type AiLandingPage } from "./api.js";
import { fmtNum } from "./format.js";

const RANGES = [7, 30, 90];

/** Clicks per 100 AI hits. Null when no bot ever touched the page — a click can
 * land on a page nothing crawled, and "0" or "∞" would both be lies there. */
function clicksPerHundred(row: AiLandingPage): number | null {
  const botHits = row.training + row.search + row.fetch;
  return botHits > 0 ? Math.round((row.clicked / botHits) * 1000) / 10 : null;
}

/**
 * Landing pages AI sent people to, split by the bot class that visited.
 *
 * Deliberately a flat table: the columns count different actor types, so drawing
 * them as nested funnel stages would claim a relationship the data does not have.
 */
export function AiLandingPages({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const [pages, setPages] = useState<AiLandingPage[] | null>(null);

  useEffect(() => {
    let alive = true;
    getAiLandingPages(site, days, 50)
      .then((result) => {
        if (alive) {
          setPages(result.pages);
        }
      })
      .catch(() => {
        if (alive) {
          setPages(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [site, days]);

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Страницы, куда AI приводит людей</h3>
        <a className="csv" href={exportDailyCsvUrl(site, days, "funnels")} download>
          CSV
        </a>
        <div className="rangetabs">
          {RANGES.map((r) => (
            <button key={r} className={days === r ? "on" : ""} onClick={() => setDays(r)}>
              {r}d
            </button>
          ))}
        </div>
      </div>
      {pages && pages.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th className="num" title="ai_training — боты, собирающие текст для обучения">Обучение</th>
                <th className="num" title="ai_search — индексаторы ответов">AI-поиск</th>
                <th className="num" title="ai_fetcher — живая подгрузка во время ответа">Live-fetch</th>
                <th className="num" title="Люди, пришедшие по ссылке из AI-ассистента">Перешли люди</th>
                <th className="num" title="Кликов на 100 хитов ботов">На 100 хитов</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((row) => {
                const ratio = clicksPerHundred(row);
                return (
                  <tr key={row.page}>
                    <td className="pathcell" title={row.page}>{row.page}</td>
                    <td className="num">{fmtNum(row.training)}</td>
                    <td className="num">{fmtNum(row.search)}</td>
                    <td className="num">{fmtNum(row.fetch)}</td>
                    <td className="num"><b>{fmtNum(row.clicked)}</b></td>
                    <td className="num muted">{ratio === null ? "—" : ratio}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="note">
            Это независимые типы ботов, а не стадии одного пути: клики бывают и на страницах, которые никто не краулил.
          </p>
        </>
      ) : (
        <div className="empty">Пока никто не переходил из AI за этот период</div>
      )}
    </div>
  );
}
