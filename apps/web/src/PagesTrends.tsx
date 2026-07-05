import * as echarts from "echarts";
import { useEffect, useMemo, useRef, useState } from "react";

import { getPagesDaily, type PagesDaily } from "./api.js";
import { buildLineSeries, defaultSelected, type LineSeries, MAX_SELECTED, toggleSelected } from "./trends.js";

const PALETTE = [
  "#60a5fa", "#a78bfa", "#f472b6", "#34d399", "#fbbf24",
  "#f87171", "#22d3ee", "#c084fc", "#4ade80", "#fb923c"
];
const RANGES = [7, 30, 90];

function TrendChart({ dates, series }: { dates: string[]; series: LineSeries[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chart.setOption({
      backgroundColor: "transparent",
      color: PALETTE,
      grid: { left: 44, right: 16, top: 14, bottom: 64 },
      legend: { type: "scroll", bottom: 0, textStyle: { color: "#8b95a7", fontSize: 11 }, icon: "circle" },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#161e30",
        borderColor: "#1f2937",
        textStyle: { color: "#e5e7eb", fontSize: 12 }
      },
      xAxis: {
        type: "category",
        data: dates.map((d) => d.slice(5)),
        axisLine: { lineStyle: { color: "#1f2937" } },
        axisLabel: { color: "#8b95a7", fontSize: 11 }
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1f2937" } },
        axisLabel: { color: "#8b95a7", fontSize: 11 }
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line",
        smooth: true,
        symbol: "none",
        emphasis: { focus: "series" },
        data: s.data
      }))
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [dates, series]);

  return <div ref={ref} style={{ width: "100%", height: 300 }} />;
}

/** Daily AI-hits-per-page trends with a top-10 page selector (max 10 series). */
export function PagesTrends({ site }: { site: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PagesDaily | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    getPagesDaily(site, days, 30)
      .then((result) => {
        if (!alive) {
          return;
        }
        setData(result);
        setSelected(defaultSelected(result.pages));
      })
      .catch(() => {
        if (!alive) {
          return;
        }
        setData(null);
        setSelected([]);
      });
    return () => {
      alive = false;
    };
  }, [site, days]);

  const series = useMemo(() => (data ? buildLineSeries(data, selected) : []), [data, selected]);
  const atCap = selected.length >= MAX_SELECTED;

  return (
    <div className="card">
      <div className="cardhead">
        <h3>Daily AI hits per page</h3>
        <div className="rangetabs">
          {RANGES.map((r) => (
            <button key={r} className={days === r ? "on" : ""} onClick={() => setDays(r)}>
              {r}d
            </button>
          ))}
        </div>
      </div>
      {!data || data.dates.length === 0 ? (
        <div className="empty">Нет данных за период</div>
      ) : series.length === 0 ? (
        <div className="empty">Выберите страницы для графика</div>
      ) : (
        <TrendChart dates={data.dates} series={series} />
      )}
      {data && data.pages.length > 0 ? (
        <div className="pageselect">
          <div className="pageselect-head muted">
            Страницы (выбрано {selected.length}/{MAX_SELECTED}) — топ-10 показаны сразу
          </div>
          <div className="pageselect-list">
            {data.pages.map((p) => {
              const on = selected.includes(p.page);
              return (
                <label key={p.page} className={`pgchip${on ? " on" : ""}${!on && atCap ? " disabled" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && atCap}
                    onChange={() => setSelected((cur) => toggleSelected(cur, p.page))}
                  />
                  <span className="pgchip-path">{p.page}</span>
                  <span className="pgchip-total">{p.total}</span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
