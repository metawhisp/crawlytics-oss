import * as echarts from "echarts";
import { useEffect, useRef, useState } from "react";

import { getExplore } from "./api.js";
import type { ExploreRow } from "./api.js";
import { fmtNum } from "./format.js";

const METRICS = [
  ["hits", "Hits"],
  ["bots", "Unique bots"],
  ["pages", "Unique pages"],
  ["sessions", "Sessions"],
  ["bytes", "Bytes"],
  ["errors", "Errors 4xx/5xx"]
] as const;

const DIMENSIONS = [
  ["bot_id", "Bot"],
  ["operator", "Operator"],
  ["actor_type", "Actor type"],
  ["verification", "Verification"],
  ["country", "Country"],
  ["as_org", "Network (ASN org)"],
  ["path_group", "Page"],
  ["status", "Status class"],
  ["ai_referral", "AI referral"],
  ["hour", "Hour of day"],
  ["weekday", "Day of week"]
] as const;

const ACTOR_FILTER = ["", "ai_training", "ai_search", "ai_fetcher", "search_engine", "seo_tool", "social", "other_bot", "human"];
const VERIFICATION_FILTER = ["", "verified", "spoofed", "unverified", "na"];

const PALETTE = ["#60a5fa", "#a78bfa", "#f472b6", "#34d399", "#fbbf24", "#f87171", "#64748b", "#22d3ee", "#c084fc", "#94a3b8"];

export function Explore({ site, hours }: { site: string; hours: number }) {
  const [metric, setMetric] = useState("hits");
  const [dimension, setDimension] = useState("bot_id");
  const [view, setView] = useState<"bar" | "pie" | "table">("bar");
  const [actorType, setActorType] = useState("");
  const [verification, setVerification] = useState("");
  const [rows, setRows] = useState<ExploreRow[]>([]);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getExplore(site, hours, metric, dimension, { actor_type: actorType, verification })
      .then((result) => setRows(result.rows))
      .catch(() => setRows([]));
  }, [site, hours, metric, dimension, actorType, verification]);

  useEffect(() => {
    if (!chartRef.current || view === "table") {
      return;
    }
    const chart = echarts.init(chartRef.current);
    const top = rows.slice(0, 12);
    const common = {
      backgroundColor: "transparent",
      tooltip: { backgroundColor: "#161e30", borderColor: "#1f2937", textStyle: { color: "#e5e7eb" } }
    };
    if (view === "bar") {
      chart.setOption({
        ...common,
        grid: { left: 120, right: 24, top: 10, bottom: 24 },
        xAxis: { type: "value", splitLine: { lineStyle: { color: "#1f2937" } }, axisLabel: { color: "#8b95a7" } },
        yAxis: {
          type: "category",
          data: top.map((row) => row.key).reverse(),
          axisLabel: { color: "#e5e7eb", fontSize: 12, width: 110, overflow: "truncate" },
          axisLine: { lineStyle: { color: "#1f2937" } }
        },
        series: [{
          type: "bar",
          data: top.map((row, index) => ({ value: row.value, itemStyle: { color: PALETTE[index % PALETTE.length] } })).reverse(),
          barMaxWidth: 18
        }]
      });
    } else {
      chart.setOption({
        ...common,
        legend: { textStyle: { color: "#8b95a7", fontSize: 11 }, bottom: 0, type: "scroll" },
        series: [{
          type: "pie",
          radius: ["45%", "72%"],
          label: { color: "#e5e7eb", formatter: "{b}: {d}%" },
          data: top.map((row, index) => ({
            name: row.key,
            value: row.value,
            itemStyle: { color: PALETTE[index % PALETTE.length] }
          }))
        }]
      });
    }
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [rows, view]);

  const total = rows.reduce((sum, row) => sum + row.value, 0);

  function downloadCsv() {
    const csv = ["key,value", ...rows.map((row) => `"${row.key.replaceAll('"', '""')}",${row.value}`)].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `crawlytics-explore-${dimension}-${metric}.csv`;
    link.click();
  }

  return (
    <div className="card">
      <div className="cardhead" style={{ flexWrap: "wrap" }}>
        <h3>Explore</h3>
        <select value={metric} onChange={(event) => setMetric(event.target.value)}>
          {METRICS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="muted">by</span>
        <select value={dimension} onChange={(event) => setDimension(event.target.value)}>
          {DIMENSIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={actorType} onChange={(event) => setActorType(event.target.value)}>
          {ACTOR_FILTER.map((value) => <option key={value} value={value}>{value === "" ? "all actors" : value}</option>)}
        </select>
        <select value={verification} onChange={(event) => setVerification(event.target.value)}>
          {VERIFICATION_FILTER.map((value) => <option key={value} value={value}>{value === "" ? "any check" : value}</option>)}
        </select>
        <div className="seg">
          {(["bar", "pie", "table"] as const).map((kind) => (
            <button key={kind} className={view === kind ? "on" : ""} onClick={() => setView(kind)}>{kind}</button>
          ))}
        </div>
        <button className="csv" onClick={downloadCsv} style={{ background: "transparent", cursor: "pointer" }}>CSV</button>
      </div>

      {rows.length === 0 ? <div className="empty">Нет данных под эти условия</div> : null}
      {view !== "table" && rows.length > 0 ? <div ref={chartRef} style={{ width: "100%", height: 360 }} /> : null}
      {view === "table" && rows.length > 0 ? (
        <table>
          <thead><tr><th>{DIMENSIONS.find(([value]) => value === dimension)?.[1]}</th><th className="num">Value</th><th className="num">Share</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="path">{row.key}</td>
                <td className="num">{fmtNum(row.value)}</td>
                <td className="num muted">{total > 0 ? `${Math.round((row.value / total) * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
