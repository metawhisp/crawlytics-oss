import { useState } from "react";

import { getCrawlHealth, type CrawlHealth as CrawlHealthData } from "./api.js";
import { fmtNum, timeAgo } from "./format.js";
import { Placeholder } from "./Placeholder.js";
import { useRequest } from "./request.js";

const RANGES = [7, 30, 90];

/**
 * What to actually do about the row. `everOk` only says a 2xx exists somewhere
 * in the window, not that it came first, so the LATEST status leads — and the
 * status class matters: a 500 is not "no such page", it is a server that needs
 * looking at. 401 and 403 no longer arrive here at all — a refusal the owner
 * configured is not a broken page, and the query drops it (stats.ts).
 */
function whatHappened(row: { sampleStatus: number; everOk: boolean }): string {
  const status = row.sampleStatus;
  if (status < 400) {
    return "уже отвечает";
  }
  if (status === 429) {
    return "упёрся в лимит";
  }
  if (status >= 500) {
    return "ошибка сервера";
  }
  return row.everOk ? "страница сломалась" : "такой страницы нет";
}

/** Actionable crawl problems: broken pages AI keeps hitting + pages AI never sees. */
export function CrawlHealth({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const state = useRequest<CrawlHealthData>(() => getCrawlHealth(site, days, 50), [site, days]);
  const data = state.data;

  return (
    <div className="grid2">
      <div className="card">
        <div className="cardhead">
          <h3 title="Трафик подделок под AI-ботов исключён — иначе список забивают сканеры">
            Битые страницы для AI
          </h3>
          <div className="rangetabs">
            {RANGES.map((r) => (
              <button key={r} className={days === r ? "on" : ""} onClick={() => setDays(r)}>
                {r}d
              </button>
            ))}
          </div>
        </div>
        {data && data.broken.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th className="num">AI errors</th>
                <th className="num">Status</th>
                <th title="Была ли страница живой в этом периоде">Что случилось</th>
                <th className="num">Last hit</th>
              </tr>
            </thead>
            <tbody>
              {data.broken.map((row) => (
                <tr key={row.page}>
                  <td className="pathcell" title={row.page}>{row.page}</td>
                  <td className="num"><b>{fmtNum(row.aiErrors)}</b></td>
                  <td className="num">
                    <span className="badge b-spoofed">{row.sampleStatus}</span>
                  </td>
                  <td className="muted">{whatHappened(row)}</td>
                  <td className="num muted">{row.lastHit ? timeAgo(row.lastHit) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Placeholder state={state} empty="AI-боты не упирались в ошибки — отлично" />
        )}
      </div>

      <div className="card">
        <div className="cardhead">
          <h3 title="Считаются только сессии, которые вели себя как браузер — подтянули стили или скрипты. Сканер этого не делает">
            Слепые зоны AI
          </h3>
        </div>
        {data && data.blindSpots.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th className="num" title="Хиты от сессий, которые рендерили страницу">Просмотры</th>
                <th className="num" title="Сколько разных браузерных сессий читали страницу">Читатели</th>
              </tr>
            </thead>
            <tbody>
              {data.blindSpots.map((row) => (
                <tr key={row.page}>
                  <td className="pathcell" title={row.page}>{row.page}</td>
                  <td className="num">{fmtNum(row.humanHits)}</td>
                  <td className="num muted">{fmtNum(row.readers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Placeholder
            state={state}
            empty="Нет страниц, которые видят люди, но не видел AI (нужен человеческий трафик как база)"
          />
        )}
      </div>
    </div>
  );
}
