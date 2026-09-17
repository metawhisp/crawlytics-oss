import { useState } from "react";

import {
  exportDailyCsvUrl,
  getCitations,
  getCrawlToRefer,
  type Citations as CitationsData,
  type CrawlToReferRow
} from "./api.js";
import { fmtNum, timeAgo } from "./format.js";
import { classifyVendors, perVisitorText, type Verdict } from "./takeGive.js";
import { Placeholder } from "./Placeholder.js";
import { useRequest } from "./request.js";

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

/** The words the panel shows, and how loud each one is.
 *
 * "only takes" and "sent nobody" are both candidates for a block, and both are
 * red so the eye lands on them; the distinction — one cannot ever send anyone,
 * the other could and did not — is carried by the words. The previous version
 * put the first of those in a neutral grey badge reading "no assistant", which
 * muted the single clearest row on the page: a quarter of one site's crawl
 * budget that can only ever cost it. */
function verdictLabel(verdict: Verdict): { cls: string; label: string; title: string } {
  switch (verdict.kind) {
    case "only-takes":
      return {
        cls: "b-spoofed",
        label: "only takes",
        title: "This vendor has no assistant that could send anyone. Zero referrals here is by design, not a failure."
      };
    case "sent-nobody":
      return {
        cls: "b-spoofed",
        label: "sent nobody",
        title: "It has an assistant, it crawled enough, and it sent zero people."
      };
    case "not-enough":
      return {
        cls: "b-other",
        label: "not enough data",
        title: `Fewer than ${String(verdict.needed)} crawls: at this site's best rate of return, zero referrals would still be the likeliest outcome here, through no fault of the vendor.`
      };
    case "sends-without-crawling":
      return {
        cls: "b-verified",
        label: "sends without crawling",
        title: "People arrive from an assistant whose crawler this site has never seen."
      };
    default:
      return {
        cls: "b-verified",
        label: "sends people",
        title: "Sends people."
      };
  }
}

function TakeGive({ site, days }: { site: string; days: number }) {
  const state = useRequest<{ rows: CrawlToReferRow[] }>(() => getCrawlToRefer(site, days), [site, days]);
  const rows = state.data?.rows ?? null;

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Take vs Give · crawls against clicks, by vendor</h3>
      </div>
      {rows && rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th className="num" title="AI crawl hits by this vendor's bots">Crawls</th>
              <th className="num" title="Human clicks from this vendor's assistant">Clicks</th>
              <th className="num" title="How many of this vendor's crawls it takes to get one visitor">Price per visitor</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {classifyVendors(rows).map((row) => {
              const verdict = verdictLabel(row.verdict);
              return (
                <tr key={row.vendor}>
                  <td>{row.vendor}</td>
                  <td className="num">{fmtNum(row.crawls)}</td>
                  <td className="num">{fmtNum(row.clicks)}</td>
                  <td className="num muted">
                    {row.verdict.kind === "sends" && row.ratio !== null ? perVisitorText(row.ratio) : "—"}
                  </td>
                  <td>
                    <span className={`badge ${verdict.cls}`} title={verdict.title}>{verdict.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Placeholder state={state} empty="No vendor data for this period" />
      )}
    </div>
  );
}

/** Pages AI retrieves — live fetches, answer-index hits and human click-throughs, from real logs. */
export function Citations({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const state = useRequest<CitationsData>(() => getCitations(site, days, 50), [site, days]);
  const data = state.data;


  const hasPages = data !== null && data.pages.length > 0;

  return (
    <>
      <div className="card">
        <div className="cardhead">
          <h3>What AI takes and where people arrive from · from real traffic</h3>
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
                <th title="People who arrived through a link in an assistant's answer. Counted from the browser Referer, the only signal that the link was shown, and one we cannot verify">Clicked</th>
                <th>Last hit</th>
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
          <Placeholder state={state} empty="In this period AI took no pages and sent nobody" />
        )}
        {data && data.infra?.length ? (
          <p className="note">
            Not pages, but service files and assets:{" "}
            {data.infra.map((row) => `${row.page} — ${String(row.hits)}`).join(", ")}
          </p>
        ) : null}
      </div>

      <div className="grid2">
        <div className="card">
          <div className="cardhead">
            <h3>Who sends people</h3>
          </div>
          {data && data.bySource.length > 0 ? (
            <BarList rows={data.bySource.map((row) => ({ label: sourceLabel(row.source), value: row.clicks }))} />
          ) : (
            <Placeholder state={state} empty="No AI referrals" />
          )}
        </div>
        <div className="card">
          <div className="cardhead">
            <h3>Who crawls</h3>
          </div>
          {data && data.byOperator.length > 0 ? (
            <BarList rows={data.byOperator.map((row) => ({ label: row.operator, value: row.crawls }))} />
          ) : (
            <Placeholder state={state} empty="No AI crawls" />
          )}
        </div>
      </div>

      <TakeGive site={site} days={days} />

      <div className="card">
        <div className="cardhead">
          <h3>Live: retrieval bots right now</h3>
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
          <Placeholder state={state} empty="No recent hits from retrieval bots" />
        )}
      </div>
    </>
  );
}
