import { useCallback, useEffect, useMemo, useState } from "react";

import { createKey, createSite, getAlerts, getRobotsSuggestion, getSiteStatus, listSites, putAlerts, sendTestAlert } from "./api.js";
import { MCP_KEY_PLACEHOLDER, claudeCodeCommand, genericClientConfig, mcpEndpoint } from "./mcp.js";
import type { AlertsConfig, BotPolicy, Site, SiteStatus } from "./api.js";
import { timeAgo } from "./format.js";
import { curlSnippet, workerSnippet } from "./sensors.js";
import type { Sensor } from "./sensors.js";

function PolicyToggle({
  label,
  hint,
  value,
  onChange
}: {
  label: string;
  hint: string;
  value: BotPolicy;
  onChange: (next: BotPolicy) => void;
}) {
  return (
    <div className="wz-row">
      <span title={hint}>{label}</span>
      <div className="seg">
        <button className={value === "allow" ? "on" : ""} onClick={() => onChange("allow")}>Allow</button>
        <button className={value === "deny" ? "on" : ""} onClick={() => onChange("deny")}>Block</button>
      </div>
    </div>
  );
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <>
      <textarea
        className="code"
        readOnly
        value={text}
        rows={Math.min(text.split("\n").length + 1, 14)}
        style={{ width: "100%", resize: "vertical" }}
      />
      <button
        className="copy"
        onClick={() => {
          try {
            void navigator.clipboard.writeText(text).then(
              () => setCopied(true),
              () => undefined
            );
          } catch {
            // no clipboard in insecure contexts — text stays selectable
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </>
  );
}

const RULE_LABELS: Array<{ key: keyof AlertsConfig["rules"]; label: string }> = [
  { key: "spike", label: "Всплеск AI-трафика" },
  { key: "newBot", label: "Новый бот (впервые за 30д)" },
  { key: "spoof", label: "Спуфинг (бот-подделка)" },
  { key: "brokenCitation", label: "Цитируемая страница сломалась (4xx/5xx)" }
];

/** Webhook alerts. OFF until a URL is saved — the server never posts anywhere by default. */
function AlertsSettings() {
  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getAlerts()
      .then((next) => {
        if (alive) {
          setConfig(next);
        }
      })
      .catch(() => {
        if (alive) {
          setConfig(null);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (config === null) {
    return null;
  }

  async function save() {
    if (config === null) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      setConfig(await putAlerts(config));
      setNote("Сохранено ✓");
    } catch (cause) {
      setNote((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const result = await sendTestAlert();
      setNote(result.ok ? "Тестовый алерт доставлен ✓" : "Webhook не ответил 2xx");
    } catch (cause) {
      setNote((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="step"><span className="num">6</span><h3>Алерты (webhook)</h3></div>
      <p className="muted">
        Выключены, пока не указан URL. Подходит любой JSON-webhook (Slack-совместимый payload с полем text).
      </p>
      <div className="wz-row">
        <input
          placeholder="https://hooks.slack.com/services/… (пусто = выключено)"
          value={config.webhookUrl}
          onChange={(event) => setConfig({ ...config, webhookUrl: event.target.value })}
          style={{ flex: 1 }}
        />
      </div>
      {RULE_LABELS.map((rule) => (
        <label key={rule.key} className="wz-row" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={config.rules[rule.key]}
            onChange={(event) => setConfig({ ...config, rules: { ...config.rules, [rule.key]: event.target.checked } })}
          />
          <span>{rule.label}</span>
        </label>
      ))}
      <div className="wz-row">
        <span title="Fire when last-hour AI hits exceed factor x 7-day average">Порог всплеска ×</span>
        <input
          type="number"
          min={1}
          max={100}
          value={config.spikeFactor}
          onChange={(event) => setConfig({ ...config, spikeFactor: Number(event.target.value) || 1 })}
          style={{ width: 70 }}
        />
        <span title="Silence window per repeated alert">Кулдаун, мин</span>
        <input
          type="number"
          min={5}
          max={10080}
          value={config.cooldownMinutes}
          onChange={(event) => setConfig({ ...config, cooldownMinutes: Number(event.target.value) || 5 })}
          style={{ width: 90 }}
        />
      </div>
      <div className="wz-row">
        <button className="wz-btn" disabled={busy} onClick={() => void save()}>Сохранить</button>
        <button disabled={busy || config.webhookUrl === ""} onClick={() => void test()}>Send test</button>
        {note !== null ? <span className="muted">{note}</span> : null}
      </div>
    </div>
  );
}

/** robots.txt / llms.txt generator: block training bots, keep the citing ones. */
function RobotsGenerator({ site }: { site: string }) {
  const [train, setTrain] = useState<BotPolicy>("deny");
  const [search, setSearch] = useState<BotPolicy>("allow");
  const [fetchPolicy, setFetchPolicy] = useState<BotPolicy>("allow");
  const [result, setResult] = useState<{ robotsTxt: string; llmsTxt: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getRobotsSuggestion(site, train, search, fetchPolicy)
      .then((next) => {
        if (alive) {
          setResult(next);
        }
      })
      .catch(() => {
        if (alive) {
          setResult(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [site, train, search, fetchPolicy]);

  return (
    <div className="card">
      <div className="step"><span className="num">5</span><h3>robots.txt / llms.txt для <b>{site}</b></h3></div>
      <p className="muted">
        Рекомендация: блокировать обучающих ботов, но пускать поисковые и цитирующие — они приводят людей.
      </p>
      <PolicyToggle
        label="Training (GPTBot, ClaudeBot…)"
        hint="Collect data to train models"
        value={train}
        onChange={setTrain}
      />
      <PolicyToggle
        label="AI search (PerplexityBot…)"
        hint="Index pages to surface them in AI answers"
        value={search}
        onChange={setSearch}
      />
      <PolicyToggle
        label="Fetchers (ChatGPT-User…)"
        hint="Fetch pages live while answering a user"
        value={fetchPolicy}
        onChange={setFetchPolicy}
      />
      {result !== null ? (
        <>
          <h4>robots.txt</h4>
          <CopyBlock text={result.robotsTxt} />
          <h4>llms.txt (заготовка — допишите свои страницы)</h4>
          <CopyBlock text={result.llmsTxt} />
        </>
      ) : (
        <div className="empty">Не удалось получить рекомендацию</div>
      )}
    </div>
  );
}

/** MCP: point Claude at this site's own analytics. The key is read-scoped, so a
 * client can only ever read this one site and can never change anything. */
function McpSetup({ site }: { site: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const endpoint = mcpEndpoint(window.location.origin);
  // Shown before a key exists so the shape of the setup is clear; the real key
  // replaces the placeholder once minted.
  const shown = key ?? MCP_KEY_PLACEHOLDER;

  async function mint() {
    setBusy(true);
    setErr(null);
    try {
      const created = await createKey(site, "read");
      setKey(created.key);
    } catch {
      setErr("Не удалось создать ключ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="step"><span className="num">7</span><h3>MCP — спросить Claude про <b>{site}</b></h3></div>
      <p className="muted">
        Подключите Claude к этим данным: он сам достанет цитирования, битые страницы и слепые зоны — и починит сайт.
        Ключ даёт <b>только чтение</b> и только этого сайта; настройки и алерты через MCP менять нельзя.
      </p>
      <button className="primary" onClick={() => void mint()} disabled={busy}>
        {busy ? "Создаю…" : key === null ? "Создать MCP-ключ" : "Создать ещё один"}
      </button>
      {key !== null ? <p className="muted">Ключ создан. Сохраните его — отозвать можно там же, где ключи ингеста.</p> : null}
      <h4>Claude Code</h4>
      <CopyBlock text={claudeCodeCommand(endpoint, shown)} />
      <h4>Любой MCP-клиент с поддержкой заголовков</h4>
      <CopyBlock text={genericClientConfig(endpoint, shown)} />
      <p className="muted">
        Дальше просто спросите: «какие мои страницы цитирует ChatGPT за месяц?», «что сломано для AI-ботов?»,
        «каких страниц AI вообще не видит?».
      </p>
      {err !== null ? <div className="err">{err}</div> : null}
    </div>
  );
}

export function Onboarding() {
  const [sites, setSites] = useState<Site[]>([]);
  const [newId, setNewId] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [ingestKey, setIngestKey] = useState<string | null>(null);
  const [sensor, setSensor] = useState<Sensor>("curl");
  const [status, setStatus] = useState<SiteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const ingestUrl = useMemo(() => `${window.location.origin}/api/ingest`, []);

  const reloadSites = useCallback(() => {
    listSites()
      .then((result) => setSites(result.sites))
      .catch(() => setSites([]));
  }, []);

  useEffect(() => {
    reloadSites();
  }, [reloadSites]);

  // Poll the active site's ingest status so step 4 flips to ✓ on its own.
  useEffect(() => {
    if (active === null) {
      return;
    }
    let alive = true;
    const tick = () => {
      getSiteStatus(active)
        .then((next) => {
          if (alive) {
            setStatus(next);
          }
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active]);

  async function addSite() {
    setErr(null);
    setBusy(true);
    try {
      const site = await createSite(newId.trim(), newDomain.trim());
      setActive(site.id);
      setIngestKey(null);
      setStatus(null);
      setNewId("");
      setNewDomain("");
      reloadSites();
    } catch (cause) {
      setErr((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makeKey() {
    if (active === null) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const key = await createKey(active, "ingest");
      setIngestKey(key.key);
    } catch (cause) {
      setErr((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(id: string) {
    setActive(id);
    setIngestKey(null);
    setStatus(null);
  }

  const snippet = ingestKey ? (sensor === "curl" ? curlSnippet(ingestUrl, ingestKey) : workerSnippet(ingestUrl, ingestKey)) : "";

  // Clear the "Copied ✓" state on a timer (and on unmount), separate from the
  // copy action so the timeout never leaks.
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  function copy() {
    if (snippet === "") {
      return;
    }
    try {
      // clipboard throws synchronously in insecure contexts and may reject —
      // either way the snippet stays selectable, so just skip the ✓.
      void navigator.clipboard.writeText(snippet).then(
        () => setCopied(true),
        () => undefined
      );
    } catch {
      // no clipboard available
    }
  }

  const flowing = (status?.recentEvents ?? 0) > 0;

  return (
    <div className="wizard">
      <div className="card">
        <div className="step"><span className="num">1</span><h3>Add a site</h3></div>
        <div className="wz-row">
          <input placeholder="site id (e.g. acme)" value={newId} onChange={(event) => setNewId(event.target.value)} />
          <input placeholder="domain (optional)" value={newDomain} onChange={(event) => setNewDomain(event.target.value)} />
          <button disabled={busy || newId.trim() === ""} onClick={() => void addSite()}>Add</button>
        </div>
        {sites.length > 0 ? (
          <div className="wz-sites">
            {sites.map((site) => (
              <button key={site.id} className={`chip ${active === site.id ? "on" : ""}`} onClick={() => pick(site.id)}>
                {site.id}{site.domain ? ` · ${site.domain}` : ""}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {active !== null ? (
        <>
          <div className="card">
            <div className="step"><span className="num">2</span><h3>Create an ingest key for <b>{active}</b></h3></div>
            {ingestKey !== null ? (
              <div className="wz-key">
                <code>{ingestKey}</code>
                <span className="muted">Copy it now — it authorizes your sensor to send events.</span>
              </div>
            ) : (
              <button className="wz-btn" disabled={busy} onClick={() => void makeKey()}>Generate ingest key</button>
            )}
          </div>

          {ingestKey !== null ? (
            <div className="card">
              <div className="step"><span className="num">3</span><h3>Send your traffic</h3></div>
              <div className="seg">
                <button className={sensor === "curl" ? "on" : ""} onClick={() => setSensor("curl")}>Test event (curl)</button>
                <button className={sensor === "cloudflare" ? "on" : ""} onClick={() => setSensor("cloudflare")}>Cloudflare Worker</button>
              </div>
              <p className="muted">
                {sensor === "curl"
                  ? "Run this once to confirm the pipe — it posts a sample GPTBot hit."
                  : "Paste into a new Cloudflare Worker, then add a route your-domain.com/* . Fail-open: it never blocks or slows your site."}
              </p>
              <pre className="code">{snippet}</pre>
              <button className="copy" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
          ) : null}

          {ingestKey !== null ? (
            <div className={`card wz-wait ${flowing ? "ok" : ""}`}>
              <div className="step"><span className="num">4</span><h3>{flowing ? "Receiving events" : "Waiting for the first event…"}</h3></div>
              {flowing ? (
                <div className="wz-ok">
                  ✓ {status?.recentEvents} event{status?.recentEvents === 1 ? "" : "s"} received for <b>{active}</b>
                  {status?.lastEventAt ? `, last ${timeAgo(status.lastEventAt)}` : ""}. They’ll appear across the dashboard shortly.
                </div>
              ) : (
                <div className="muted">No events yet for <b>{active}</b>. Run the snippet above — this updates automatically.</div>
              )}
            </div>
          ) : null}

          <RobotsGenerator site={active} />

          <AlertsSettings />

          <McpSetup site={active} />
        </>
      ) : null}

      {err !== null ? <div className="card err">{err}</div> : null}
    </div>
  );
}
