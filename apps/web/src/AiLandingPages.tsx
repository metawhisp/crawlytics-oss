import { useState } from "react";

import { exportDailyCsvUrl, getAiLandingPages, type AiLandingPage } from "./api.js";
import { fmtNum } from "./format.js";
import { Placeholder } from "./Placeholder.js";
import { useRequest } from "./request.js";

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
  const state = useRequest<{ pages: AiLandingPage[] }>(
    () => getAiLandingPages(site, days, 50),
    [site, days]
  );
  const pages = state.data?.pages ?? null;

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Pages AI sends people to</h3>
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
                <th className="num" title="ai_training — bots collecting text to train models">Training</th>
                <th className="num" title="ai_search — answer indexers">AI search</th>
                <th className="num" title="ai_fetcher — fetched live while answering">Live-fetch</th>
                <th className="num" title="People who arrived through a link from an AI assistant">Arrived</th>
                <th className="num" title="Clicks per 100 bot hits">Per 100 hits</th>
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
            These are independent bot types, not stages of one path: clicks land on pages nobody crawled too.
          </p>
        </>
      ) : (
        <Placeholder state={state} empty="Nobody has arrived from AI in this period" />
      )}
    </div>
  );
}
