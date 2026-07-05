import * as echarts from "echarts";
import { useEffect, useRef } from "react";

const SERIES: Array<{ key: string; name: string; color: string }> = [
  { key: "ai_training", name: "AI training", color: "#60a5fa" },
  { key: "ai_search", name: "AI search", color: "#a78bfa" },
  { key: "ai_fetcher", name: "AI fetcher", color: "#f472b6" },
  { key: "search_engine", name: "Search engines", color: "#64748b" },
  { key: "seo_tool", name: "SEO tools", color: "#475569" },
  { key: "other_bot", name: "Other bots", color: "#334155" }
];

export function Chart({ data }: { data: Array<Record<string, number | string>> }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return;
    }
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const labels = data.map((row) => String(row["t"]).slice(5, 16));
    chart.setOption({
      backgroundColor: "transparent",
      grid: { left: 40, right: 12, top: 30, bottom: 28 },
      legend: { textStyle: { color: "#8b95a7", fontSize: 11 }, top: 0, icon: "circle" },
      tooltip: { trigger: "axis", backgroundColor: "#161e30", borderColor: "#1f2937", textStyle: { color: "#e5e7eb", fontSize: 12 } },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: "#1f2937" } },
        axisLabel: { color: "#8b95a7", fontSize: 11 }
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1f2937" } },
        axisLabel: { color: "#8b95a7", fontSize: 11 }
      },
      series: SERIES.map((series) => ({
        name: series.name,
        type: "bar",
        stack: "bots",
        emphasis: { focus: "series" },
        itemStyle: { color: series.color },
        data: data.map((row) => Number(row[series.key] ?? 0))
      }))
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
    };
  }, [data]);

  return <div ref={ref} style={{ width: "100%", height: 260 }} />;
}
