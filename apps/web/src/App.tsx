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
  submitLicense
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
import { fmtNum, timeAgo, verifiedShare } from "./format.js";

const PERIODS = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" }
];

const TABS = ["Overview", "Explore", "Bots", "Pages", "Citations", "Referrals", "Security", "Setup"] as const;
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
  Citations: "M7 7h10M7 11h6M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
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
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [licenseKey, setLicenseKey] = useState("");
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [licenseNote, setLicenseNote] = useState<string | null>(null);
  const [site, setSite] = useState<string>("");
  const [hours, setHours] = useState(24);
  const [tab, setTab] = useState<Tab>("Overview");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoRouted = useRef(false);

  const loadSession = useCallback(
    () =>
      getSession()
        .then((session) => {
          setDashEnabled(session.dashboardEnabled);
          setAuthed(session.dashboardEnabled ? session.authed ?? false : false);
          setPasswordRequired(session.dashboardEnabled ? session.passwordRequired ?? false : false);
        })
        .catch(() => {
          setDashEnabled(false);
          setAuthed(false);
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

    getOverview(site, hours)
      .then((overview) => {
        setData(overview);
        setError(null);
      })
      .catch((cause: unknown) => setError(String(cause)));
  }, [authed, site, hours]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

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
    setData(null);
    setError(null);
    setTab("Overview");
    autoRouted.current = false;
  }

  async function submitLicenseKey() {
    const result = await submitLicense(licenseKey.trim());
    if (!result.ok) {
      setLicenseError(result.error ?? "invalid license key");
      setLicenseNote(null);
      return;
    }
    setLicenseError(null);
    if (result.dashboardEnabled) {
      setLicenseKey("");
      await loadSession(); // unlocked → flow to password login or the dashboard
    } else {
      // Valid key, but the gate stays closed (e.g. production needs a password).
      setLicenseNote(result.note ?? "License accepted. Set a dashboard password to serve the dashboard.");
    }
  }

  if (dashEnabled === null) {
    return <div className="app empty">Loading…</div>;
  }

  if (!dashEnabled) {
    return (
      <div className="login">
        <div className="wordmark">crawl<b>ytics</b></div>
        <div className="login-hint">Enter your license key to unlock the dashboard.</div>
        <input
          type="text"
          placeholder="Paste your license key"
          value={licenseKey}
          onChange={(event) => setLicenseKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submitLicenseKey();
            }
          }}
        />
        {licenseError ? <div className="err">{licenseError}</div> : null}
        {licenseNote ? <div className="login-hint">{licenseNote}</div> : null}
        <button onClick={() => void submitLicenseKey()}>Unlock</button>
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
            {(data?.sites ?? (effectiveSite ? [effectiveSite] : [])).map((name) => (
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

        {error ? <div className="card err">{error}</div> : null}

      {tab === "Overview" ? <OverviewTab data={data} /> : null}
      {tab === "Explore" ? <Explore site={effectiveSite} hours={hours} /> : null}
      {tab === "Bots" ? <BotsTab site={effectiveSite} hours={hours} /> : null}
      {tab === "Pages" ? <PagesTab site={effectiveSite} hours={hours} /> : null}
        {tab === "Citations" ? <Citations site={effectiveSite} /> : null}
        {tab === "Referrals" ? <AiLandingPages site={effectiveSite} /> : null}
        {tab === "Security" ? <SecurityTab site={effectiveSite} hours={hours} /> : null}
        {tab === "Setup" ? <Onboarding /> : null}
      </main>
    </div>
  );
}

function OverviewTab({ data }: { data: Overview | null }) {
  const kpis = data?.kpis;
  const prev = data?.prevKpis;

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="l">AI hits</div>
          <div className="v">{fmtNum(kpis?.aiHits ?? 0)}</div>
          <Delta now={kpis?.aiHits ?? 0} prev={prev?.aiHits ?? 0} />
        </div>
        <div className="kpi">
          <div className="l">Unique AI bots</div>
          <div className="v">{fmtNum(kpis?.uniqueBots ?? 0)}</div>
          <Delta now={kpis?.uniqueBots ?? 0} prev={prev?.uniqueBots ?? 0} />
        </div>
        <div className="kpi good">
          <div className="l">Verified share</div>
          <div className="v">{verifiedShare(kpis?.verified ?? 0, kpis?.spoofed ?? 0)}</div>
        </div>
        <div className="kpi bad">
          <div className="l">Spoofed</div>
          <div className="v">{fmtNum(kpis?.spoofed ?? 0)}</div>
          <Delta now={kpis?.spoofed ?? 0} prev={prev?.spoofed ?? 0} invert />
        </div>
        <div className="kpi">
          <div className="l">AI referrals</div>
          <div className="v">{fmtNum(kpis?.aiReferrals ?? 0)}</div>
          <Delta now={kpis?.aiReferrals ?? 0} prev={prev?.aiReferrals ?? 0} />
        </div>
        <div className="kpi">
          <div className="l">Bot errors 4xx/5xx</div>
          <div className="v">{fmtNum(kpis?.botErrors ?? 0)}</div>
          <Delta now={kpis?.botErrors ?? 0} prev={prev?.botErrors ?? 0} invert />
        </div>
      </div>

      <div className="card">
        <h3>Bot traffic over time</h3>
        {data && data.timeseries.length > 0 ? <Chart data={data.timeseries} /> : <div className="empty">No data yet</div>}
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
          ) : <div className="empty">Ботов пока не было</div>}
        </div>

        <div className="card">
          <h3>Top pages (AI attention)</h3>
          {data && data.topPages.length > 0 ? (
            <table>
              <thead>
                <tr><th>Page</th><th className="num">AI hits</th><th className="num">Bots</th><th className="num">Total</th></tr>
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
          ) : <div className="empty">Нет данных</div>}
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
          ) : <div className="empty">Переходов из AI пока нет</div>}
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
          ) : <div className="empty">Тихо…</div>}
        </div>
      </div>
    </>
  );
}

function BotsTab({ site, hours }: { site: string; hours: number }) {
  const [bots, setBots] = useState<BotRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<BotDetail | null>(null);

  useEffect(() => {
    getBots(site, hours).then((result) => setBots(result.bots)).catch(() => setBots([]));
  }, [site, hours]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    getBotDetail(site, hours, selected).then(setDetail).catch(() => setDetail(null));
  }, [site, hours, selected]);

  return (
    <>
      <div className="card">
        <div className="cardhead"><h3>All bots</h3><CsvButton site={site} hours={hours} table="bots" /></div>
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
        ) : <div className="empty">Нет данных за период</div>}
      </div>

      {selected && detail ? (
        <>
          <div className="card">
            <h3>{selected} — activity</h3>
            {detail.timeseries.length > 0 ? (
              <Chart data={detail.timeseries.map((row) => ({ t: row.t, ai_training: row.hits }))} />
            ) : <div className="empty">Нет данных</div>}
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
  const [pages, setPages] = useState<PageRow[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      getPages(site, hours, query).then((result) => setPages(result.pages)).catch(() => setPages([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [site, hours, query]);

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
            <tr><th>Page</th><th className="num">AI hits</th><th className="num">Training</th><th className="num">AI search</th><th className="num">Fetchers</th><th className="num">Bots</th><th className="num">Last AI visit</th></tr>
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
      ) : <div className="empty">Нет страниц по фильтру</div>}
      </div>
    </>
  );
}

function SecurityTab({ site, hours }: { site: string; hours: number }) {
  const [security, setSecurity] = useState<Security | null>(null);

  useEffect(() => {
    getSecurity(site, hours).then(setSecurity).catch(() => setSecurity(null));
  }, [site, hours]);

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
        ) : <div className="empty">Спуферов за период не поймано</div>}
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
        ) : <div className="empty">Пусто</div>}
      </div>
    </>
  );
}
