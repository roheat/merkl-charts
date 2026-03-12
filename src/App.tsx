import { useState, useEffect } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ReferenceLine, ResponsiveContainer, CartesianGrid,
} from "recharts";

const BASE = "https://api.merkl.xyz/v4";

interface Campaign {
  id: string;
  apr: number;
  dailyRewards: number;
  status: string;
  amount: string;
  startTimestamp: number;
  endTimestamp: number;
  params: {
    distributionMethodParameters?: {
      distributionSettings?: { apr?: string };
    };
  };
  rewardToken: {
    symbol: string;
    decimals: number;
    price: number;
  };
}

interface Opportunity {
  id: string;
  name: string;
  apr: number;
  tvl: number;
  status: string;
  campaigns: Campaign[];
}

type Strategy = "capped" | "variable";

interface ChartData {
  opportunityName: string;
  campaignId: string;
  liveAPR: number;
  aprCapPct: number | null;
  currentTVL: number;
  rewardTokenSymbol: string;
  annualRewardUSD: number;
  totalIncentivesUSD: number;
  dailyRewards: number;
  startTimestamp: number;
  endTimestamp: number;
  strategy: Strategy;
  yMax: number;
  pts: { tvl: number; apr: number }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmtUSD = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B`
    : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M`
      : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K`
        : `$${v.toFixed(0)}`;

const fmtTVL = fmtUSD;

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function niceMax(v: number): number {
  if (v >= 10) return Math.ceil(v / 5) * 5;
  if (v >= 2) return Math.ceil(v);
  if (v >= 1) return Math.ceil(v * 2) / 2;
  if (v >= 0.1) return Math.ceil(v * 10) / 10;
  return 0.1;
}

function calcTotalIncentives(campaigns: Campaign[]): number {
  let total = 0;
  for (const c of campaigns) {
    try {
      const rawAmount = BigInt(c.amount ?? "0");
      const tokenAmount = Number(rawAmount) / Math.pow(10, c.rewardToken.decimals ?? 18);
      total += tokenAmount * (c.rewardToken.price ?? 0);
    } catch { /* skip unparseable amounts */ }
  }
  return total;
}

function buildChartData(opps: Opportunity[]): ChartData[] {
  const results: ChartData[] = [];
  for (const opp of opps) {
    // Total incentives across ALL campaigns for this opportunity
    const totalIncentivesUSD = calcTotalIncentives(opp.campaigns);
    // For each opportunity, also log:
    const campaignBudget = opp.campaigns.map(c => ({
      id: c.id,
      start: new Date(c.startTimestamp * 1000).toLocaleDateString(),
      end: new Date(c.endTimestamp * 1000).toLocaleDateString(),
      budgetUSD: (Number(c.amount) / 1e18) * c.rewardToken.price
    }))
    console.log({ campaignBudget });


    for (const campaign of opp.campaigns) {
      if (!(campaign.dailyRewards > 0)) continue;
      if (campaign.apr < 0.1) continue;

      const currentTVL = opp.tvl || 1;
      if (currentTVL < 1e6) continue;

      const rawApr = campaign.params?.distributionMethodParameters?.distributionSettings?.apr;
      const annualRewardUSD = campaign.dailyRewards * 365;
      const isCapped = rawApr != null;
      const aprCapPct = isCapped ? parseFloat(rawApr!) * 100 : null;

      const pts = Array.from({ length: 60 }, (_, i) => {
        const t = currentTVL * 0.5 + currentTVL * 1.5 * (i / 59);
        const raw = (annualRewardUSD / t) * 100;
        const apr = isCapped ? Math.min(aprCapPct!, raw) : raw;
        return { tvl: t, apr: parseFloat(apr.toFixed(3)) };
      });

      const maxApr = isCapped ? aprCapPct! : pts[0].apr;

      results.push({
        opportunityName: opp.name,
        campaignId: campaign.id,
        liveAPR: campaign.apr,
        aprCapPct,
        currentTVL,
        rewardTokenSymbol: campaign.rewardToken.symbol,
        annualRewardUSD,
        totalIncentivesUSD,
        dailyRewards: campaign.dailyRewards,
        startTimestamp: campaign.startTimestamp,
        endTimestamp: campaign.endTimestamp,
        strategy: isCapped ? "capped" : "variable",
        yMax: niceMax(maxApr),
        pts,
      });
    }
  }
  // Log a clean summary for analysis (omits pts array to keep it readable)
  // console.log((results.map(({ pts: _pts, ...rest }) => rest), null, 2));
  return results;
}

async function fetchCharts(token: string): Promise<ChartData[]> {
  const listRes = await fetch(`${BASE}/opportunities?name=${token}&items=100`);
  if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
  const list: { id: string }[] = await listRes.json();
  const full = await Promise.all(
    list.map(async ({ id }) => {
      const r = await fetch(`${BASE}/opportunities/${id}?campaigns=true`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return { ...data, campaigns: data.campaigns ?? [] } as Opportunity;
    })
  );
  console.log(JSON.stringify(
    full.map(opp => ({
      opportunityName: opp.name,
      campaigns: (opp.campaigns || [])
        .sort((a, b) => a.startTimestamp - b.startTimestamp)
        .map(c => ({
          start: new Date(c.startTimestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          end: new Date(c.endTimestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          budgetTokens: (Number(c.amount) / Math.pow(10, c.rewardToken.decimals)).toFixed(2),
          budgetUSD: ((Number(c.amount) / Math.pow(10, c.rewardToken.decimals)) * c.rewardToken.price).toFixed(2),
          rewardToken: c.rewardToken.symbol,
          dailyRewards: c.dailyRewards,
          apr: c.apr
        }))
    })),
    null, 2
  ));
  return buildChartData(full);
}

// ── Custom chart components ───────────────────────────────────────────────────

function CurrentLabel({ viewBox }: { viewBox?: { x: number; y: number } }) {
  if (!viewBox) return null;
  return (
    <text x={viewBox.x + 5} y={viewBox.y + 13} fontSize={11} fill="#9b8ff5" fontFamily="system-ui">
      Current
    </text>
  );
}

function XTick({ x, y, payload, currentTVL }: {
  x?: number; y?: number;
  payload?: { value: number };
  currentTVL: number;
}) {
  const val = payload?.value ?? 0;
  const isCurrent = Math.abs(val - currentTVL) < 1;
  return (
    <text x={x} y={(y ?? 0) + 10} textAnchor="middle" fontSize={9}
      fill={isCurrent ? "#9b8ff5" : "#c0c4d8"}
      fontWeight={isCurrent ? 700 : 400}
      fontFamily="system-ui"
    >
      {fmtTVL(val)}
    </text>
  );
}

// ── Card subcomponents ────────────────────────────────────────────────────────

function Stat({ label, value, valueSize = 18 }: { label: string; value: string; valueSize?: number }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: "#a0a4cc", textTransform: "uppercase", letterSpacing: "0.7px", fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: valueSize, fontWeight: 700, color: "#4e4b8e", marginTop: 3 }}>
        {value}
      </div>
    </div>
  );
}

function CampaignProgress({ c, accentColor }: { c: ChartData; accentColor: string }) {
  const now = Date.now() / 1000;
  const start = c.startTimestamp;
  const end = c.endTimestamp;
  const pct = Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));

  return (
    <div style={{ marginTop: 14, padding: "12px 0 2px", borderTop: "1px solid #f0f0f8" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "#a0a4cc", textTransform: "uppercase", letterSpacing: "0.7px", fontWeight: 600 }}>
          Incentives Spent to Date
        </span>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#4e4b8e" }}>
          {fmtUSD(c.totalIncentivesUSD)}
        </span>
      </div>
      {/* Progress bar */}
      <div style={{ height: 5, background: "#f0f0f8", borderRadius: 3, overflow: "hidden", marginBottom: 5 }}>
        <div style={{ height: "100%", width: `${pct.toFixed(1)}%`, background: accentColor, borderRadius: 3, transition: "width 0.4s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#c0c4d8" }}>
        <span>{fmtDate(start)}</span>
        <span style={{ color: "#a0a4cc", fontWeight: 600 }}>{pct.toFixed(0)}% elapsed</span>
        <span>{fmtDate(end)}</span>
      </div>
    </div>
  );
}

function Card({ c, accentColor }: { c: ChartData; accentColor: string }) {
  const gid = `grad-${c.campaignId.replace(/\W/g, "")}`;
  return (
    <div style={{
      background: "white", borderRadius: 14, padding: "20px 24px",
      border: "1px solid #eaecf8", boxShadow: "0 2px 20px rgba(80,70,200,0.06)", marginBottom: 14,
    }}>
      <div style={{ fontWeight: 700, fontSize: 14, color: "#1e1e3f", marginBottom: 12 }}>
        {c.opportunityName}
      </div>

      <div style={{ display: "flex", gap: 20, marginBottom: 14, flexWrap: "wrap" }}>
        <Stat label="Strategy" value={c.strategy === "capped" ? "Capped Reward Rate" : "Variable Reward Rate"} valueSize={12} />
        <Stat label="Live APR" value={`${c.liveAPR.toFixed(2)}%`} valueSize={18} />
        {c.aprCapPct != null && <Stat label="APR Cap" value={`${c.aprCapPct.toFixed(2)}%`} valueSize={18} />}
        <Stat label="Current TVL" value={fmtTVL(c.currentTVL)} valueSize={18} />
        <Stat label="Daily Rewards" value={fmtUSD(c.dailyRewards)} valueSize={18} />
        <Stat label="Reward Token" value={c.rewardTokenSymbol} valueSize={18} />
      </div>


      <div style={{ fontSize: 11, fontWeight: 600, color: "#6c6c90", margin: "14px 0 6px" }}>APR over TVL</div>

      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={c.pts} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={accentColor} stopOpacity={0.3} />
              <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0fa" vertical={false} />
          <XAxis
            dataKey="tvl" type="number"
            domain={[c.pts[0].tvl, c.pts[c.pts.length - 1].tvl]}
            ticks={[c.pts[0].tvl, c.currentTVL, c.pts[c.pts.length - 1].tvl]}
            tick={<XTick currentTVL={c.currentTVL} />}
            tickLine={false} axisLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `${v.toFixed(v < 1 ? 1 : 0)}%`}
            tick={{ fontSize: 9, fill: "#c0c4d8" }}
            tickLine={false} axisLine={false} width={34}
            domain={[0, c.yMax]}
          />
          <Tooltip
            formatter={(v) => [`${Number(v).toFixed(2)}%`, "APR"]}
            labelFormatter={(label) => fmtTVL(label as number)}
            contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #eaecf8", boxShadow: "0 2px 12px rgba(0,0,0,0.08)" }}
          />
          <ReferenceLine x={c.currentTVL} stroke="#9b8ff5" strokeDasharray="5 4" label={<CurrentLabel />} />
          <Area type="monotone" dataKey="apr" stroke={accentColor} strokeWidth={2.5} fill={`url(#${gid})`} dot={false} activeDot={{ r: 4 }} />
        </AreaChart>
      </ResponsiveContainer>

      <CampaignProgress c={c} accentColor={accentColor} />

    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

const TOKENS: { token: string; badge: string; accent: string }[] = [
  { token: "RLUSD", badge: "linear-gradient(135deg,#6c5de8,#9f8ff8)", accent: "#6c5de8" },
  { token: "PYUSD", badge: "linear-gradient(135deg,#0070f3,#38bdf8)", accent: "#0070f3" },
];

export default function App() {
  const [charts, setCharts] = useState<Record<string, ChartData[] | null>>({ RLUSD: null, PYUSD: null });
  const [errors, setErrors] = useState<Record<string, string | null>>({ RLUSD: null, PYUSD: null });

  useEffect(() => {
    TOKENS.forEach(({ token }) => {
      fetchCharts(token.toLowerCase())
        .then((data) => setCharts((p) => ({ ...p, [token]: data })))
        .catch((e: Error) => setErrors((p) => ({ ...p, [token]: e.message })));
    });
  }, []);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", background: "linear-gradient(140deg,#f0f1ff,#f9f9ff)", minHeight: "100vh" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Top sticky: page title */}
      <div style={{
        position: "sticky", top: 0, zIndex: 20,
        background: "rgba(245,245,255,0.94)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #e4e4f4", padding: "10px 24px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
          <h1 style={{ fontSize: 17, fontWeight: 800, color: "#1e1e3f", margin: 0 }}>Distribution Charts</h1>
          <span style={{ fontSize: 12, color: "#a0a4cc" }}>APR over TVL · Live from Merkl API</span>
        </div>
      </div>

      {/* Second sticky: token column headers */}
      <div style={{
        position: "sticky", top: 41, zIndex: 19,
        background: "rgba(245,245,255,0.94)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #e4e4f4", padding: "10px 24px",
      }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", gap: 24 }}>
          {TOKENS.map(({ token, badge, accent }) => {
            const data = charts[token];
            return (
              <div key={token} style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ background: badge, borderRadius: 8, padding: "3px 11px", color: "white", fontSize: 12, fontWeight: 700 }}>
                  {token}
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, color: "#1e1e3f" }}>Distribution</span>
                {data && (
                  <span style={{ fontSize: 11, color: accent, background: `${accent}18`, borderRadius: 20, padding: "1px 7px", fontWeight: 600 }}>
                    {data.length} charts
                  </span>
                )}
                {!data && !errors[token] && (
                  <div style={{ width: 16, height: 16, borderRadius: "50%", border: `2px solid ${accent}33`, borderTopColor: accent, animation: "spin 0.8s linear infinite" }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Cards */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "20px 24px" }}>
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          {TOKENS.map(({ token, accent }) => (
            <div key={token} style={{ flex: 1, minWidth: 0 }}>
              {errors[token] && <pre style={{ color: "red", fontSize: 12 }}>{errors[token]}</pre>}
              {!charts[token] && !errors[token] && (
                <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", border: `3px solid ${accent}33`, borderTopColor: accent, animation: "spin 0.8s linear infinite" }} />
                </div>
              )}
              {charts[token]?.map((c) => <Card key={c.campaignId} c={c} accentColor={accent} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
