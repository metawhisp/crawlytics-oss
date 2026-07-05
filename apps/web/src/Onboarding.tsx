import { useCallback, useEffect, useMemo, useState } from "react";

import { createKey, createSite, getSiteStatus, listSites } from "./api.js";
import type { Site, SiteStatus } from "./api.js";
import { timeAgo } from "./format.js";
import { curlSnippet, workerSnippet } from "./sensors.js";
import type { Sensor } from "./sensors.js";

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
        </>
      ) : null}

      {err !== null ? <div className="card err">{err}</div> : null}
    </div>
  );
}
