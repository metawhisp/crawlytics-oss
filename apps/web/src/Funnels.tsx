import { useEffect, useState } from "react";

import { getFunnels, type ReferralFunnel } from "./api.js";
import { fmtNum } from "./format.js";

const RANGES = [7, 30, 90];

const STAGES: Array<{ key: keyof Pick<ReferralFunnel, "crawled" | "surfaced" | "clicked">; label: string; kind: string }> = [
  { key: "crawled", label: "AI прочитал", kind: "crawled" },
  { key: "surfaced", label: "Показал в ответах", kind: "surfaced" },
  { key: "clicked", label: "Перешли люди", kind: "clicked" }
];

function FunnelStage({ label, value, max, kind }: { label: string; value: number; max: number; kind: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="funnel-stage">
      <span className="funnel-label">{label}</span>
      <div className="funnel-track">
        <div className={`funnel-fill ${kind}`} style={{ width: `${String(pct)}%` }} />
      </div>
      <span className="funnel-val">{fmtNum(value)}</span>
    </div>
  );
}

/** Landing pages that got AI referral click-throughs, each with its crawled->surfaced->clicked funnel. */
export function Funnels({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const [pages, setPages] = useState<ReferralFunnel[] | null>(null);

  useEffect(() => {
    let alive = true;
    getFunnels(site, days, 50)
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
        <h3>Переходы из AI → воронка по странице</h3>
        <div className="rangetabs">
          {RANGES.map((r) => (
            <button key={r} className={days === r ? "on" : ""} onClick={() => setDays(r)}>
              {r}d
            </button>
          ))}
        </div>
      </div>
      {pages && pages.length > 0 ? (
        <div className="funnels">
          {pages.map((p) => {
            const max = Math.max(p.crawled, p.surfaced, p.clicked, 1);
            return (
              <div key={p.page} className="funnel">
                <div className="funnel-path" title={p.page}>{p.page}</div>
                {STAGES.map((s) => (
                  <FunnelStage key={s.kind} label={s.label} value={p[s.key]} max={max} kind={s.kind} />
                ))}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty">Пока никто не переходил из AI за этот период</div>
      )}
    </div>
  );
}
