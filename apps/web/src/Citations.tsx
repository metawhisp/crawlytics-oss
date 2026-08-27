import { useEffect, useState } from "react";

import {
  exportDailyCsvUrl,
  getCitations,
  getCrawlToRefer,
  type Citations as CitationsData,
  type CrawlToReferRow
} from "./api.js";
import { fmtNum, timeAgo } from "./format.js";

const RANGES = [7, 30, 90];

const SOURCE_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
  copilot: "Copilot",
  deepseek: "DeepSeek",
  grok: "Grok",
  meta: "Meta AI",
  you: "You.com",
  mistral: "Mistral"
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function BarList({ rows }: { rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div>
      {rows.map((row) => (
        <div key={row.label} className="refrow">
          <span className="name" title={row.label}>{row.label}</span>
          <div className="bar" style={{ width: `${Math.max(4, (row.value / max) * 100)}%` }} />
          <span className="n">{fmtNum(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

// Take-vs-give verdict thresholds (clicks per crawl).
const TAKER_MAX_RATIO = 0.01;
const LOW_MAX_RATIO = 0.1;

function verdictFor(row: CrawlToReferRow): { cls: string; label: string } {
  if (!row.hasAssistant) {
    // No consumer assistant exists — zero clicks is expected, not a verdict.
    return { cls: "b-other", label: "no assistant" };
  }
  if (row.ratio === null) {
    // No observed crawls: clicks came anyway -> pure sender; no data at all -> dash.
    return row.clicks > 0 ? { cls: "b-verified", label: "sender" } : { cls: "b-other", label: "—" };
  }
  if (row.ratio < TAKER_MAX_RATIO) {
    return { cls: "b-spoofed", label: "taker" };
  }
  if (row.ratio < LOW_MAX_RATIO) {
    return { cls: "b-other", label: "low" };
  }
  return { cls: "b-verified", label: "sender" };
}

function TakeGive({ site, days }: { site: string; days: number }) {
  const [rows, setRows] = useState<CrawlToReferRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    getCrawlToRefer(site, days)
      .then((result) => {
        if (alive) {
          setRows(result.rows);
        }
      })
      .catch(() => {
        if (alive) {
          setRows(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [site, days]);

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Take vs Give · краулы против кликов по вендору</h3>
      </div>
      {rows && rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th className="num" title="AI crawl hits by this vendor's bots">Crawls</th>
              <th className="num" title="Human clicks from this vendor's assistant">Clicks</th>
              <th className="num" title="Clicks per crawl">Ratio</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const verdict = verdictFor(row);
              return (
                <tr key={row.vendor}>
                  <td>{row.vendor}</td>
                  <td className="num">{fmtNum(row.crawls)}</td>
                  <td className="num">{fmtNum(row.clicks)}</td>
                  <td className="num muted">{row.ratio === null ? "—" : row.ratio.toFixed(3)}</td>
                  <td>
                    <span className={`badge ${verdict.cls}`}>{verdict.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="empty">Нет данных по вендорам за период</div>
      )}
    </div>
  );
}

/** Pages AI actually cites — live fetches, answer-index hits and human click-throughs, from real logs. */
export function Citations({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<CitationsData | null>(null);

  useEffect(() => {
    let alive = true;
    getCitations(site, days, 50)
      .then((result) => {
        if (alive) {
          setData(result);
        }
      })
      .catch(() => {
        if (alive) {
          setData(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [site, days]);

  const hasPages = data !== null && data.pages.length > 0;

  return (
    <>
      <div className="card">
        <div className="cardhead">
          <h3>Что цитирует AI · измерено по реальному трафику</h3>
          <a className="csv" href={exportDailyCsvUrl(site, days, "citations")} download>
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
        {hasPages ? (
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th title="Live fetches by assistants answering a user (ai_fetcher)">Fetched live</th>
                <th title="AI search indexers that surface answers (ai_search)">Surfaced</th>
                <th title="Humans who clicked through from an AI assistant">Clicked</th>
                <th>Last cited</th>
              </tr>
            </thead>
            <tbody>
              {data.pages.map((p) => (
                <tr key={p.page}>
                  <td className="pathcell" title={p.page}>{p.page}</td>
                  <td>{fmtNum(p.fetched)}</td>
                  <td>{fmtNum(p.surfaced)}</td>
                  <td>{fmtNum(p.clicked)}</td>
                  <td className="muted">{p.lastCited ? timeAgo(p.lastCited) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">AI пока не цитировал сайт за этот период</div>
        )}
        {data && data.infra?.length ? (
          <p className="note">
            Не считается цитированием (служебные файлы и ассеты):{" "}
            {data.infra.map((row) => `${row.page} — ${String(row.hits)}`).join(", ")}
          </p>
        ) : null}
      </div>

      <div className="grid2">
        <div className="card">
          <div className="cardhead">
            <h3>Кто присылает людей</h3>
          </div>
          {data && data.bySource.length > 0 ? (
            <BarList rows={data.bySource.map((row) => ({ label: sourceLabel(row.source), value: row.clicks }))} />
          ) : (
            <div className="empty">Нет переходов из AI</div>
          )}
        </div>
        <div className="card">
          <div className="cardhead">
            <h3>Кто краулит</h3>
          </div>
          {data && data.byOperator.length > 0 ? (
            <BarList rows={data.byOperator.map((row) => ({ label: row.operator, value: row.crawls }))} />
          ) : (
            <div className="empty">Нет AI-краулов</div>
          )}
        </div>
      </div>

      <TakeGive site={site} days={days} />

      <div className="card">
        <div className="cardhead">
          <h3>Live: retrieval-боты сейчас</h3>
        </div>
        {data && data.feed.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Bot</th>
                <th>Type</th>
                <th>Path</th>
                <th>Geo</th>
              </tr>
            </thead>
            <tbody>
              {data.feed.map((row, index) => (
                <tr key={`${row.ts}|${row.actorType}|${row.botId}|${row.path}|${String(index)}`}>
                  <td className="muted">{timeAgo(row.ts)}</td>
                  <td>{row.botId || row.operator}</td>
                  <td>
                    <span className={`badge ${row.actorType === "ai_fetcher" ? "b-fetcher" : "b-search"}`}>
                      {row.actorType === "ai_fetcher" ? "fetcher" : "AI search"}
                    </span>
                  </td>
                  <td className="pathcell" title={row.path}>{row.path}</td>
                  <td className="muted">{row.country || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">Нет свежих обращений retrieval-ботов</div>
        )}
      </div>
    </>
  );
}
