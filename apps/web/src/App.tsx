import { useCallback, useEffect, useRef, useState } from "react";

import {
  exportCsvUrl,
  getBotDetail,
  getBots,
  getOverview,
  getPages,
  getSecurity,
  getSession,
  login,
  logout,
} from "./api.js";
import { listSites } from "./api.js";
import type { BotDetail, BotRow, Overview, PageRow, Security } from "./api.js";
import { Chart } from "./Chart.js";
import { Citations } from "./Citations.js";
import { CrawlHealth } from "./CrawlHealth.js";
import { AiLandingPages } from "./AiLandingPages.js";
import { Login } from "./Login.js";
import { PagesTrends } from "./PagesTrends.js";
import { Explore } from "./Explore.js";
import { Onboarding } from "./Onboarding.js";
import { Placeholder } from "./Placeholder.js";
import { useRequest } from "./request.js";
import type { RequestState } from "./request.js";
import { fmtNum, timeAgo, verifiedShare } from "./format.js";

const PERIODS = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" }
];

const TABS = ["Overview", "Explore", "Bots", "Pages", "Retrieval", "Referrals", "Security", "Setup"] as const;
type Tab = (typeof TABS)[number];

function actorBadge(actorType: string): { cls: string; label: string } {
  switch (actorType) {
    case "ai_training":
      return { cls: "b-training", label: "training" };
    case "ai_search":
      return { cls: "b-search", label: "AI search" };
    case "ai_fetcher":
      return { cls: "b-fetcher", label: "fetcher" };
    case "search_engine":
      return { cls: "b-engine", label: "search" };
    case "seo_tool":
      return { cls: "b-other", label: "SEO" };
    case "human":
      // NOT "a person": the classifier files every unrecognised user-agent here
      // (matcher.ts:132). On a real site most of it is automation wearing a
      // browser string. Rows that also carry an ai_referral show that separately,
      // and THAT is evidence of a human.
      return { cls: "b-other", label: "не опознан" };
    default:
      return { cls: "b-other", label: actorType.replace("_", " ") };
  }
}


const NAV_ICONS: Record<string, string> = {
  Overview: "M3 13h4v8H3zM10 7h4v14h-4zM17 3h4v18h-4z",
  Explore: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.35-4.35",
  Bots: "M12 3v3M8 9h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM9 13h.01M15 13h.01",
  Pages: "M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v6h6",
  Retrieval: "M7 7h10M7 11h6M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  Referrals: "M3 4h18M6 4l5 7v7l2-1v-6l5-7",
  Security: "M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z",
  Setup: "M12 9v6M9 12h6M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={NAV_ICONS[name] ?? ""} />
    </svg>
  );
}

function Delta({ now, prev, invert = false }: { now: number; prev: number; invert?: boolean }) {
  if (prev === 0 && now === 0) {
    return <span className="delta muted">—</span>;
  }
  if (prev === 0) {
    return <span className={`delta ${invert ? "down" : "up"}`}>new</span>;
  }
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) {
    return <span className="delta muted">0%</span>;
  }
  const good = invert ? pct < 0 : pct > 0;
  return (
    <span className={`delta ${good ? "up" : "down"}`}>
      {pct > 0 ? "↑" : "↓"}{Math.abs(pct)}%
    </span>
  );
}

function CsvButton({ site, hours, table }: { site: string; hours: number; table: string }) {
  return (
    <a className="csv" href={exportCsvUrl(site, hours, table)} download>
      CSV
    </a>
  );
}

export function App() {
  const [dashEnabled, setDashEnabled] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [site, setSite] = useState<string>("");
  const [hours, setHours] = useState(24);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);
  const autoRouted = useRef(false);

  const loadSession = useCallback(
    () =>
      getSession()
        .then((session) => {
          setSessionError(null);
          setDashEnabled(session.dashboardEnabled);
          setAuthed(session.dashboardEnabled ? session.authed ?? false : false);
          setPasswordRequired(session.dashboardEnabled ? session.passwordRequired ?? false : false);
        })
        .catch((cause: unknown) => {
          // A refused request is not an answer. This used to set dashEnabled to
          // false, which renders "Enter your license key to unlock the
          // dashboard" — so an unreachable server sent the operator hunting for
          // a key they already had. Leave the session unknown and say so.
          setSessionError(String(cause));
        }),
    []
  );

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const refresh = useCallback(() => {
    if (authed !== true) {
      return;
    }
    // Nothing selected yet: ask which sites exist rather than guessing a name.
    // The overview endpoint requires a non-empty site, so there is no id we
    // could send here that would not be a guess about someone else's install.
    if (!site) {
      listSites()
        .then((result) => {
          setError(null);
          const first = result.sites[0]?.id;
          if (first !== undefined) {
            setSite(first);
            return;
          }
          // First run, nothing ingested yet → send the operator to the wizard.
          if (!autoRouted.current) {
            autoRouted.current = true;
            setTab("Setup");
          }
        })
        .catch((cause: unknown) => setError(String(cause)));
      return;
    }

  }, [authed, site, hours]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The overview was the last panel still on hand-rolled state, and it is the
  // largest: switching site or period left the PREVIOUS subject's KPIs, chart
  // and tables on screen under the new label, and a refusal froze them there
  // with the error banner stacked above. The 60s tick is a poll — the same
  // question re-asked — so it keeps what is on screen; a site or period change
  // is a different question and drops it.
  const overview = useRequest<Overview | null>(
    () => (authed === true && site !== "" ? getOverview(site, hours) : Promise.resolve(null)),
    [authed, site, hours],
    60_000
  );

  // The list of sites is not part of "the overview of site X", so it must not
  // vanish from the selector while the overview of another site is in flight.
  const [knownSites, setKnownSites] = useState<string[]>([]);
  useEffect(() => {
    if (overview.status === "ready" && overview.data !== null) {
      setKnownSites(overview.data.sites);
    }
  }, [overview.status, overview.data]);

  async function submitLogin() {
    const ok = await login(password);
    setLoginError(!ok);
    if (ok) {
      setAuthed(true);
    }
  }

  async function submitLogout() {
    const ok = await logout();
    if (!ok) {
      return; // server did not confirm — keep the user in the dashboard
    }
    // Confirmed logout: drop the session and clear dashboard state so nothing
    // stale flashes on the next login.
    setAuthed(false);
    setPassword("");
    // The overview clears itself: `authed` is one of its dependencies, so the
    // request restarts and `started` drops the previous answer. The site list
    // is remembered outside it and has to be cleared by hand — the next person
    // at this browser must not be shown which sites the last one had.
    setKnownSites([]);
    setError(null);
    setTab("Overview");
    autoRouted.current = false;
  }

  if (sessionError !== null && dashEnabled === null) {
    return (
      <div className="login">
        <div className="wordmark">crawl<b>ytics</b></div>
        <div className="err">Could not reach the server to check this session: {sessionError}</div>
        <button onClick={() => void loadSession()}>Retry</button>
      </div>
    );
  }

  if (dashEnabled === null) {
    return <div className="app empty">Loading…</div>;
  }

  if (!dashEnabled) {
    // The license gate was cut for the open-source release (licensed is hard
    // coded true), so the only way to reach this screen is a production
    // instance with no TC_DASHBOARD_PASSWORD — a deliberate fail-closed. It
    // used to ask for a license key that has no issuer any more, sending the
    // operator looking for something that does not exist instead of naming the
    // one line they have to add.
    return (
      <div className="login">
        <div className="wordmark">crawl<b>ytics</b></div>
        <div className="login-hint">
          This instance has no dashboard password, so the dashboard is not served.
        </div>
        <div className="login-hint">
          Set <code>TC_DASHBOARD_PASSWORD</code> in <code>deploy/.env</code> and restart:
          <br />
          <code>docker compose -p crawlytics -f compose.prod.yml -f compose.tls.yml up -d</code>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <Login
        password={password}
        setPassword={setPassword}
        onSubmit={() => void submitLogin()}
        error={loginError}
      />
    );
  }

  const effectiveSite = site;

  return (
    <div className="shell">
      <aside className="side">
        <div className="wordmark">crawl<b>ytics</b></div>
        <nav className="nav">
          {TABS.map((name) => (
            <button key={name} className={tab === name ? "on" : ""} onClick={() => setTab(name)}>
              <NavIcon name={name} />
              {name}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <select value={site} onChange={(event) => setSite(event.target.value)} aria-label="Site">
            {(knownSites.length > 0 ? knownSites : effectiveSite ? [effectiveSite] : []).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          {passwordRequired ? (
            <button className="logout" onClick={() => void submitLogout()}>Выйти</button>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{tab}</h1>
          <div className="spacer" />
          <div className="seg">
            {PERIODS.map((period) => (
              <button
                key={period.hours}
                className={hours === period.hours ? "on" : ""}
                onClick={() => setHours(period.hours)}
              >
                {period.label}
              </button>
            ))}
          </div>
        </div>

        {error ?? (overview.status === "error" ? overview.message : null) ? (
          <div className="card err">{error ?? overview.message}</div>
        ) : null}

      {tab === "Overview" ? <OverviewTab state={overview} /> : null}
      {tab === "Explore" ? <Explore site={effectiveSite} hours={hours} /> : null}
      {tab === "Bots" ? <BotsTab site={effectiveSite} hours={hours} /> : null}
      {tab === "Pages" ? <PagesTab site={effectiveSite} hours={hours} /> : null}
        {tab === "Retrieval" ? <Citations site={effectiveSite} /> : null}
        {tab === "Referrals" ? <AiLandingPages site={effectiveSite} /> : null}
        {tab === "Security" ? <SecurityTab site={effectiveSite} hours={hours} /> : null}
        {tab === "Setup" ? <Onboarding /> : null}
      </main>
    </div>
  );
}

function OverviewTab({ state }: { state: RequestState<Overview | null> }) {
  const data = state.data;
  const kpis = data?.kpis;
  const prev = data?.prevKpis;
  // "0 AI hits" is a claim. Until an answer arrives, and after one is refused,
  // there is no number to show — the placeholder below names which it is.
  const num = (value: number | undefined) => (value === undefined ? "—" : fmtNum(value));

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="l" title="Подделки под AI-ботов сюда не входят — они в плитке Spoofed">
            AI hits
          </div>
          <div className="v">{num(kpis?.aiHits)}</div>
          {kpis && prev ? <Delta now={kpis.aiHits} prev={prev.aiHits} /> : null}
          <div className="kpi-split" title="Проверено по опубликованным вендором диапазонам или PTR · вендор не публикует способ проверки">
            {num(kpis?.aiVerified)} проверено · {num(kpis?.aiUnverified)} не проверяется
          </div>
        </div>
        <div className="kpi">
          <div className="l">Unique AI bots</div>
          <div className="v">{num(kpis?.uniqueBots)}</div>
          {kpis && prev ? <Delta now={kpis.uniqueBots} prev={prev.uniqueBots} /> : null}
        </div>
        <div className="kpi good">
          <div className="l">Verified share</div>
          <div className="v">{kpis ? verifiedShare(kpis.verified, kpis.spoofed) : "—"}</div>
        </div>
        <div className="kpi bad">
          <div className="l">Spoofed</div>
          <div className="v">{num(kpis?.spoofed)}</div>
          {kpis && prev ? <Delta now={kpis.spoofed} prev={prev.spoofed} invert /> : null}
        </div>
        <div className="kpi">
          <div className="l">AI referrals</div>
          <div className="v">{num(kpis?.aiReferrals)}</div>
          {kpis && prev ? <Delta now={kpis.aiReferrals} prev={prev.aiReferrals} /> : null}
        </div>
        <div className="kpi">
          <div className="l">Bot errors 4xx/5xx</div>
          <div className="v">{num(kpis?.botErrors)}</div>
          {kpis && prev ? <Delta now={kpis.botErrors} prev={prev.botErrors} invert /> : null}
        </div>
      </div>

      <div className="card">
        <h3>Bot traffic over time</h3>
        {data && data.timeseries.length > 0 ? <Chart data={data.timeseries} /> : <Placeholder state={state} empty="No data yet" />}
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Top bots</h3>
          {data && data.topBots.length > 0 ? (
            <table>
              <thead>
                <tr><th>Bot</th><th>Type</th><th className="num">Hits</th><th>Status</th><th className="num">Seen</th></tr>
              </thead>
              <tbody>
                {data.topBots.map((bot) => {
                  const badge = actorBadge(bot.actorType);
                  return (
                    <tr key={bot.botId}>
                      <td><b>{bot.botId}</b> <span className="muted">{bot.operator}</span></td>
                      <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                      <td className="num">{fmtNum(bot.hits)}</td>
                      <td>{bot.spoofed > 0 ? <span className="badge b-spoofed">spoofed ×{bot.spoofed}</span> : <span className="badge b-verified">ok</span>}</td>
                      <td className="num muted">{timeAgo(bot.lastSeen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Placeholder state={state} empty="Ботов пока не было" />}
        </div>

        <div className="card">
          <h3>Top pages (AI attention)</h3>
          {data && data.topPages.length > 0 ? (
            <table>
              <thead>
                <tr><th>Page</th><th className="num">AI hits</th><th className="num">AI bots</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {data.topPages.map((page) => (
                  <tr key={page.pathGroup}>
                    <td className="path">{page.pathGroup}</td>
                    <td className="num">{fmtNum(page.aiHits)}</td>
                    <td className="num">{fmtNum(page.bots)}</td>
                    <td className="num muted">{fmtNum(page.hits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Placeholder state={state} empty="Нет данных" />}
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Human traffic from AI assistants</h3>
          {data && data.referrals.length > 0 ? (
            <div>
              {data.referrals.map((referral) => {
                const max = data.referrals[0]?.hits ?? 1;
                return (
                  <div className="refrow" key={referral.source}>
                    <span className="name">{referral.source}</span>
                    <div className="bar" style={{ width: `${Math.max(4, (referral.hits / max) * 100)}%` }} />
                    <span className="n">{fmtNum(referral.hits)}</span>
                  </div>
                );
              })}
            </div>
          ) : <Placeholder state={state} empty="Переходов из AI пока нет" />}
        </div>

        <div className="card">
          <h3>Recent bot activity</h3>
          {data && data.recent.length > 0 ? (
            <div className="feed">
              {data.recent.map((event, index) => {
                const badge = actorBadge(event.actorType);
                return (
                  <div className="row" key={`${event.ts}-${index}`}>
                    <span className="t">{timeAgo(event.ts)}</span>
                    <span className={`badge ${badge.cls}`}>{event.botId || badge.label}</span>
                    {event.verification === "spoofed" ? <span className="badge b-spoofed">spoofed</span> : null}
                    {event.aiReferral ? <span className="badge b-referral">via {event.aiReferral}</span> : null}
                    <span className="path">{event.path.length > 48 ? `${event.path.slice(0, 48)}…` : event.path}</span>
                  </div>
                );
              })}
            </div>
          ) : <Placeholder state={state} empty="Тихо…" />}
        </div>
      </div>
    </>
  );
}

function BotsTab({ site, hours }: { site: string; hours: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const botsState = useRequest<{ bots: BotRow[]; truncated: boolean }>(
    () => getBots(site, hours),
    [site, hours]
  );
  const bots = botsState.data?.bots ?? [];
  // A bot with no name selected is not a request at all — stay in `loading`
  // rather than inventing a rejection the server never sent.
  const detailState = useRequest<BotDetail | null>(
    () => (selected === null ? Promise.resolve(null) : getBotDetail(site, hours, selected)),
    [site, hours, selected]
  );
  const detail = detailState.data ?? null;

  return (
    <>
      <div className="card">
        <div className="cardhead">
          {/* "All bots" over a LIMIT 100 ranked by hits: a busy site was shown a
              truncated list with nothing saying so. */}
          <h3>{botsState.data?.truncated === true ? "Top 100 bots by hits" : "All bots"}</h3>
          <CsvButton site={site} hours={hours} table="bots" />
        </div>
        {bots.length > 0 ? (
          <table>
            <thead>
              <tr><th>Bot</th><th>Type</th><th className="num">Hits</th><th className="num">Pages</th><th className="num">Errors</th><th>Status</th><th className="num">Seen</th></tr>
            </thead>
            <tbody>
              {bots.map((bot) => {
                const badge = actorBadge(bot.actorType);
                return (
                  <tr key={bot.botId} className={`click ${selected === bot.botId ? "sel" : ""}`} onClick={() => setSelected(bot.botId)}>
                    <td><b>{bot.botId}</b> <span className="muted">{bot.operator}</span></td>
                    <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                    <td className="num">{fmtNum(bot.hits)}</td>
                    <td className="num">{fmtNum(bot.pages)}</td>
                    <td className="num">{bot.errors > 0 ? <span className="errnum">{bot.errors}</span> : "0"}</td>
                    <td>{bot.spoofed > 0 ? <span className="badge b-spoofed">spoofed ×{bot.spoofed}</span> : <span className="badge b-verified">ok</span>}</td>
                    <td className="num muted">{timeAgo(bot.lastSeen)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <Placeholder state={botsState} empty="Нет данных за период" />}
      </div>

      {selected !== null && detail === null ? (
        <div className="card">
          <Placeholder state={detailState} empty={`Нет данных по ${selected}`} />
        </div>
      ) : null}

      {selected && detail ? (
        <>
          <div className="card">
            <h3>{selected} — activity</h3>
            {detail.timeseries.length > 0 ? (
              <Chart data={detail.timeseries.map((row) => ({ t: row.t, ai_training: row.hits }))} />
            ) : <Placeholder state={detailState} empty="Нет данных" />}
          </div>
          <div className="grid2">
            <div className="card">
              <h3>{selected} — pages</h3>
              <table>
                <thead><tr><th>Path</th><th className="num">Hits</th><th className="num">Errors</th><th className="num">Seen</th></tr></thead>
                <tbody>
                  {detail.topPages.map((page) => (
                    <tr key={page.path}>
                      <td className="path">{page.path.length > 56 ? `${page.path.slice(0, 56)}…` : page.path}</td>
                      <td className="num">{fmtNum(page.hits)}</td>
                      <td className="num">{page.errors > 0 ? <span className="errnum">{page.errors}</span> : "0"}</td>
                      <td className="num muted">{timeAgo(page.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3>{selected} — sources</h3>
              <table>
                <thead><tr><th>IP</th><th>Geo / Network</th><th className="num">Hits</th><th>Check</th></tr></thead>
                <tbody>
                  {detail.sources.map((source) => (
                    <tr key={source.ip}>
                      <td className="path">{source.ip}</td>
                      <td className="muted">{[source.country, source.asOrg].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="num">{fmtNum(source.hits)}</td>
                      <td><span className={`badge ${source.verification === "verified" ? "b-verified" : source.verification === "spoofed" ? "b-spoofed" : "b-other"}`}>{source.verification}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="statusrow">
                {detail.statuses.map((status) => (
                  <span key={status.statusClass} className="muted">{status.statusClass}: <b>{fmtNum(status.hits)}</b>&nbsp;&nbsp;</span>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function PagesTab({ site, hours }: { site: string; hours: number }) {
  const [query, setQuery] = useState("");
  // The 250 ms debounce is what the typist sees; it stays here, the request
  // state lives in the module.
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const pagesState = useRequest<{ pages: PageRow[] }>(
    () => getPages(site, hours, debounced),
    [site, hours, debounced]
  );
  const pages = pagesState.data?.pages ?? [];

  return (
    <>
      <PagesTrends site={site} />
      <CrawlHealth site={site} />
      <div className="card">
      <div className="cardhead">
        <h3>Pages by AI attention</h3>
        <input className="search" placeholder="Filter pages…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <CsvButton site={site} hours={hours} table="pages" />
      </div>
      {pages.length > 0 ? (
        <table>
          <thead>
            <tr><th>Page</th><th className="num">AI hits</th><th className="num">Training</th><th className="num">AI search</th><th className="num">Fetchers</th><th className="num">AI bots</th><th className="num">Last AI visit</th></tr>
          </thead>
          <tbody>
            {pages.map((page) => (
              <tr key={page.pathGroup}>
                <td className="path">{page.pathGroup}</td>
                <td className="num"><b>{fmtNum(page.aiHits)}</b></td>
                <td className="num">{fmtNum(page.trainingHits)}</td>
                <td className="num">{fmtNum(page.searchHits)}</td>
                <td className="num">{fmtNum(page.fetcherHits)}</td>
                <td className="num">{fmtNum(page.bots)}</td>
                <td className="num muted">{page.lastAiHit && !page.lastAiHit.startsWith("1970") ? timeAgo(page.lastAiHit) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Placeholder state={pagesState} empty="Нет страниц по фильтру" />}
      </div>
    </>
  );
}

function SecurityTab({ site, hours }: { site: string; hours: number }) {
  const state = useRequest<Security>(() => getSecurity(site, hours), [site, hours]);
  const security = state.data;

  return (
    <>
      <div className="card">
        <div className="cardhead"><h3>Spoofed bot identities</h3><CsvButton site={site} hours={hours} table="security" /></div>
        {security && security.spoofedByBot.length > 0 ? (
          <table>
            <thead><tr><th>Claimed identity</th><th className="num">Fake hits</th><th className="num">Unique IPs</th></tr></thead>
            <tbody>
              {security.spoofedByBot.map((row) => (
                <tr key={row.botId}>
                  <td><b>{row.botId}</b></td>
                  <td className="num"><span className="errnum">{fmtNum(row.hits)}</span></td>
                  <td className="num">{fmtNum(row.ips)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Placeholder state={state} empty="Спуферов за период не поймано" />}
      </div>

      <div className="card">
        <h3>Spoofing sources</h3>
        {security && security.spoofedSources.length > 0 ? (
          <table>
            <thead><tr><th>IP</th><th>Geo / Network</th><th title="Последняя использованная личина; +N = IP менял их">Pretends to be</th><th className="num">Hits</th><th className="num">Last seen</th></tr></thead>
            <tbody>
              {security.spoofedSources.map((source) => (
                <tr key={source.ip}>
                  <td className="path">{source.ip}</td>
                  <td className="muted">{[source.country, source.asOrg].filter(Boolean).join(" · ") || "—"}</td>
                  <td>
                    <span className="badge b-spoofed">{source.claimedBot}</span>
                    {source.claimedVariants > 1 ? (
                      <span className="muted" title="Этот IP менял личины — показана последняя">
                        {" "}+{source.claimedVariants - 1} UA
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{fmtNum(source.hits)}</td>
                  <td className="num muted">{timeAgo(source.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Placeholder state={state} empty="Пусто" />}
      </div>
    </>
  );
}
