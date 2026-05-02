import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "";
const API = `${API_BASE_URL}/api`;

// ─── API HELPER ──────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}, token = null) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function getRiskColor(risk) { return { high: "#f87171", medium: "#fb923c", low: "#34d399" }[risk] || "#94a3b8"; }
function getRiskGlow(risk) { return { high: "0 0 20px rgba(248,113,113,0.4)", medium: "0 0 20px rgba(251,146,60,0.4)", low: "0 0 20px rgba(52,211,153,0.3)" }[risk] || "none"; }
function getMoodLabel(score) {
  if (typeof score !== "number") return "No data";
  if (score >= 8) return "Excellent";
  if (score >= 6) return "Good";
  if (score >= 4) return "Neutral";
  if (score >= 2) return "Low";
  return "Critical";
}
function getStressLevel(hrv, hr, eda) {
  if ([hrv, hr, eda].some(value => typeof value !== "number" || Number.isNaN(value))) {
    return { label: "No live data", color: "#94a3b8", value: null, available: false };
  }
  const h = hrv, r = hr, e = eda;
  const score = (100 - h) * 0.4 + (r - 60) * 0.4 + e * 3;
  if (score > 80) return { label: "High Stress", color: "#f87171", value: Math.min(score, 100), available: true };
  if (score > 50) return { label: "Moderate", color: "#fb923c", value: score, available: true };
  return { label: "Calm", color: "#34d399", value: score, available: true };
}
function formatMetricValue(value, suffix = "") {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return `${value}${suffix}`;
}
function formatHours(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return `${value}h`;
}
function formatScore(value, max = 10) {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return `${value}/${max}`;
}
function recentTrend(history, key) {
  return (history || [])
    .map(entry => entry?.[key])
    .filter(value => typeof value === "number" && !Number.isNaN(value));
}
function formatShortRangeLabel(date, range) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  if (range === "day") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "week") {
    return date.toLocaleDateString([], { weekday: "short", day: "numeric" });
  }
  if (range === "month") {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { month: "short" });
}
function getRangeWindowMs(range) {
  if (range === "day") return 24 * 60 * 60 * 1000;
  if (range === "week") return 7 * 24 * 60 * 60 * 1000;
  if (range === "month") return 30 * 24 * 60 * 60 * 1000;
  return 365 * 24 * 60 * 60 * 1000;
}
function getBucketCount(range) {
  if (range === "day") return 8;
  if (range === "week") return 7;
  if (range === "month") return 10;
  return 12;
}
function isSameLocalDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function startOfLocalMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}
function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}
function buildTrendSeries(history, key, range) {
  const cleaned = dedupeSensorHistory(history)
    .filter(entry => typeof entry?.[key] === "number" && !Number.isNaN(entry[key]) && entry.timestamp)
    .map(entry => ({ ...entry, date: new Date(entry.timestamp) }))
    .filter(entry => !Number.isNaN(entry.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  if (!cleaned.length) {
    return { points: [], values: [], populatedBuckets: 0, totalBuckets: 0 };
  }

  const now = new Date();

  if (range === "day") {
    const todaysReadings = cleaned.filter(entry => isSameLocalDay(entry.date, now)).slice(-8);
    const points = todaysReadings.map(entry => ({
      label: formatShortRangeLabel(entry.date, range),
      value: entry[key],
      timestamp: entry.timestamp
    }));
    const values = points.map(point => point.value).filter(value => typeof value === "number");
    return {
      points,
      values,
      populatedBuckets: points.length,
      totalBuckets: 8
    };
  }

  const bucketCount = getBucketCount(range);
  let buckets = [];

  if (range === "week") {
    const todayStart = startOfLocalDay(now);
    buckets = Array.from({ length: bucketCount }, (_, index) => {
      const bucketStart = addDays(todayStart, index - (bucketCount - 1));
      const bucketEnd = addDays(bucketStart, 1);
      return {
        label: formatShortRangeLabel(bucketStart, range),
        bucketStart,
        bucketEnd
      };
    });
  } else if (range === "month") {
    const rangeWindowMs = getRangeWindowMs(range);
    const windowStart = new Date(now.getTime() - rangeWindowMs);
    const bucketSizeMs = rangeWindowMs / bucketCount;
    buckets = Array.from({ length: bucketCount }, (_, index) => {
      const bucketStart = new Date(windowStart.getTime() + bucketSizeMs * index);
      const bucketEnd = new Date(windowStart.getTime() + bucketSizeMs * (index + 1));
      return {
        label: formatShortRangeLabel(bucketStart, range),
        bucketStart,
        bucketEnd
      };
    });
  } else {
    const currentMonthStart = startOfLocalMonth(now);
    buckets = Array.from({ length: bucketCount }, (_, index) => {
      const bucketStart = addMonths(currentMonthStart, index - (bucketCount - 1));
      const bucketEnd = addMonths(bucketStart, 1);
      return {
        label: formatShortRangeLabel(bucketStart, range),
        bucketStart,
        bucketEnd
      };
    });
  }

  const points = buckets.map(({ label, bucketStart, bucketEnd }, index) => {
    const bucketValues = cleaned
      .filter(entry => entry.date >= bucketStart && (index === bucketCount - 1 ? entry.date <= bucketEnd : entry.date < bucketEnd))
      .map(entry => entry[key]);
    const avg = bucketValues.length
      ? Number((bucketValues.reduce((sum, value) => sum + value, 0) / bucketValues.length).toFixed(1))
      : null;
    return {
      label,
      value: avg
    };
  });

  const values = points.map(point => point.value).filter(value => typeof value === "number");
  return {
    points,
    values,
    populatedBuckets: points.filter(point => typeof point.value === "number").length,
    totalBuckets: points.length
  };
}
function dedupeSensorHistory(history) {
  const seen = new Set();
  return (history || []).filter(entry => {
    const key = [entry?.timestamp, entry?.hr, entry?.hrv, entry?.eda, entry?.source].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function buildRecentVitalsSeries(history, key, limit = 24) {
  const cleaned = dedupeSensorHistory(history)
    .filter(entry => typeof entry?.[key] === "number" && !Number.isNaN(entry[key]) && entry.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(-limit);

  return cleaned.map(entry => ({
    label: new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    value: entry[key],
    timestamp: entry.timestamp
  }));
}
function buildLatestRecordedTrend(history, key, range) {
  const cleaned = dedupeSensorHistory(history)
    .filter(entry => typeof entry?.[key] === "number" && !Number.isNaN(entry[key]) && entry.timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .map(entry => ({ ...entry, date: new Date(entry.timestamp) }))
    .filter(entry => !Number.isNaN(entry.date.getTime()));

  if (!cleaned.length) return { points: [], count: 0 };

  const latestDate = cleaned[cleaned.length - 1].date;
  const windowStart = new Date(latestDate.getTime() - getRangeWindowMs(range));
  const limit = getBucketCount(range);
  const filtered = cleaned.filter(entry => entry.date >= windowStart && entry.date <= latestDate).slice(-limit);

  return {
    points: filtered.map(entry => ({
      label: formatShortRangeLabel(entry.date, range),
      value: entry[key],
      timestamp: entry.timestamp
    })),
    count: filtered.length
  };
}

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
function NeuralBg() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 80% 60% at 20% 20%, rgba(99,102,241,0.12) 0%, transparent 60%), radial-gradient(ellipse 60% 80% at 80% 80%, rgba(139,92,246,0.10) 0%, transparent 60%)" }} />
      <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.06 }}>
        <defs><pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M 60 0 L 0 0 0 60" fill="none" stroke="rgba(99,102,241,1)" strokeWidth="0.5" /></pattern></defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
      {[...Array(5)].map((_, i) => (
        <div key={i} style={{ position: "absolute", borderRadius: "50%", border: `1px solid rgba(99,102,241,${0.04 + i * 0.01})`, width: `${200 + i * 150}px`, height: `${200 + i * 150}px`, top: `${10 + i * 5}%`, left: `${5 + i * 8}%`, animation: `pulse-ring ${4 + i}s ease-in-out infinite alternate`, transform: "translate(-50%, -50%)" }} />
      ))}
      <style>{`
        @keyframes pulse-ring { from { opacity:0.3; transform:translate(-50%,-50%) scale(1); } to { opacity:0.7; transform:translate(-50%,-50%) scale(1.05); } }
        @keyframes float { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-8px); } }
        @keyframes glow-pulse { 0%,100% { opacity:0.6; } 50% { opacity:1; } }
        @keyframes breathe { 0%,100% { transform:scale(1); opacity:0.7; } 50% { transform:scale(1.15); opacity:1; } }
        @keyframes slide-in { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
        @keyframes wave { 0% { transform:translateX(0); } 100% { transform:translateX(-50%); } }
        @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
        @keyframes pop-in { from { opacity:0; transform:scale(0.85) translateY(20px); } to { opacity:1; transform:scale(1) translateY(0); } }
        @keyframes spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }
      `}</style>
    </div>
  );
}

function GlassCard({ children, style, glow, onClick, hover = true }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{
      background: "rgba(255,255,255,0.04)", backdropFilter: "blur(20px)",
      border: "1px solid rgba(255,255,255,0.09)", borderRadius: 20,
      boxShadow: hov && hover ? `0 8px 40px rgba(99,102,241,0.15), ${glow || "none"}` : `0 2px 20px rgba(0,0,0,0.3), ${glow || "none"}`,
      transition: "all 0.25s ease", cursor: onClick ? "pointer" : "default",
      transform: hov && hover && onClick ? "translateY(-2px)" : "none", ...style
    }}>{children}</div>
  );
}

function Badge({ label, color }) {
  return <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: `${color}22`, color, border: `1px solid ${color}44`, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</span>;
}

function SparkLine({ data, color = "#818cf8", height = 40, filled = false, width = 120 }) {
  if (!data || !data.length) return null;
  const w = width, h = height;
  const numericData = data.filter(value => typeof value === "number" && !Number.isNaN(value));
  if (!numericData.length) return null;
  const min = Math.min(...numericData), max = Math.max(...numericData);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    return { x, y };
  });
  const segments = [];
  let current = [];
  for (const point of points) {
    if (point) current.push(point);
    else if (current.length) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length) segments.push(current);
  if (!segments.length) return null;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ overflow: "visible", width: "100%", display: "block" }}>
      {filled && <defs><linearGradient id={`sg-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.3" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>}
      {filled && segments.map((segment, index) => {
        if (segment.length < 2) return null;
        const path = `M ${segment.map(point => `${point.x},${point.y}`).join(" L ")}`;
        const fillPath = `${path} L ${segment[segment.length - 1].x},${h} L ${segment[0].x},${h} Z`;
        return <path key={`fill-${index}`} d={fillPath} fill={`url(#sg-${color.replace("#","")})`} />;
      })}
      {segments.map((segment, index) => {
        if (segment.length === 1) {
          return <circle key={`dot-${index}`} cx={segment[0].x} cy={segment[0].y} r="3.5" fill={color} />;
        }
        const path = `M ${segment.map(point => `${point.x},${point.y}`).join(" L ")}`;
        return <path key={`line-${index}`} d={path} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />;
      })}
    </svg>
  );
}

function VitalsHistoryChart({ title, color, unit, points }) {
  const values = points.map(point => point.value);
  const latest = points[points.length - 1]?.value;
  return (
    <div style={{ padding: 18, borderRadius: 16, background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.42)", letterSpacing: 0.8, textTransform: "uppercase" }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color }}>{typeof latest === "number" ? latest : "--"}</div>
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>{unit}</div>
      </div>
      {values.length > 1 ? (
        <>
          <SparkLine data={values} color={color} height={76} width={320} filled={true} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, gap: 8 }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.24)" }}>{points[0]?.label || ""}</span>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.24)" }}>{points[points.length - 1]?.label || ""}</span>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", padding: "26px 0", textAlign: "center" }}>
          More live readings are needed to show movement.
        </div>
      )}
    </div>
  );
}

function BrainWave({ color = "#818cf8", width = 300, height = 60, speed = 6 }) {
  return (
    <div style={{ overflow: "hidden", width, height, position: "relative" }}>
      <svg width={width * 2} height={height} viewBox={`0 0 ${width * 2} ${height}`} style={{ animation: `wave ${speed}s linear infinite`, position: "absolute" }}>
        <defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor={color} stopOpacity="0" /><stop offset="30%" stopColor={color} stopOpacity="0.8" /><stop offset="70%" stopColor={color} stopOpacity="0.8" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {[0, width].map((offset, idx) => (
          <polyline key={idx} points={[...Array(40)].map((_, i) => { const x = offset + (i/39)*width; const y = height/2 + Math.sin((i/39)*Math.PI*4)*(height/3)*(0.5+0.5*Math.sin(i*0.7)); return `${x},${y}`; }).join(" ")} fill="none" stroke="url(#wg)" strokeWidth="2" strokeLinecap="round" />
        ))}
      </svg>
    </div>
  );
}

function MiniBar({ value, max = 100, color = "#818cf8" }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 8, height: 6, width: "100%", overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 8, transition: "width 0.6s ease" }} />
    </div>
  );
}

function useIsDesktop(minWidth = 1100) {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= minWidth : false
  );

  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= minWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minWidth]);

  return isDesktop;
}

// ─── LOGIN SCREEN (REAL AUTH) ─────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [role, setRole] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) { setError("Please fill in all fields."); return; }
    setLoading(true); setError("");
    try {
      const data = await apiFetch("/login", {
        method: "POST",
        body: JSON.stringify({ role, username, password })
      });
      localStorage.setItem("neuromind_token", data.token);
      onLogin(data.role, data.user, data.token);
    } catch (err) {
      setError(err.message || "Login failed. Check your credentials.");
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, position: "relative", zIndex: 1 }}>
      <div style={{ width: "100%", maxWidth: 420, animation: "pop-in 0.5s cubic-bezier(0.34,1.56,0.64,1) both" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", boxShadow: "0 0 40px rgba(99,102,241,0.5)", fontSize: 28 }}>🧠</div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>NeuroMind</div>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>Mental Health Intelligence Platform</div>
        </div>

        {!role ? (
          <GlassCard style={{ padding: 32 }}>
            <div style={{ fontSize: 16, fontWeight: 700, textAlign: "center", marginBottom: 8 }}>Welcome back</div>
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", textAlign: "center", marginBottom: 28 }}>Select your role to continue</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { key: "doctor", icon: "🩺", title: "I'm a Doctor", sub: "Manage patients, view reports & AI analysis" },
                { key: "patient", icon: "🫀", title: "I'm a Patient", sub: "Track your wellness & talk to your AI companion" },
              ].map(r => (
                <div key={r.key} onClick={() => setRole(r.key)} style={{ padding: "18px 20px", borderRadius: 16, cursor: "pointer", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)", display: "flex", alignItems: "center", gap: 16, transition: "all 0.2s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(99,102,241,0.15)"; e.currentTarget.style.border = "1px solid rgba(99,102,241,0.4)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.border = "1px solid rgba(255,255,255,0.09)"; }}>
                  <div style={{ width: 48, height: 48, borderRadius: 14, background: "rgba(99,102,241,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22 }}>{r.icon}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{r.title}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{r.sub}</div>
                  </div>
                  <div style={{ marginLeft: "auto", color: "rgba(255,255,255,0.3)", fontSize: 18 }}>›</div>
                </div>
              ))}
            </div>
          </GlassCard>
        ) : (
          <GlassCard style={{ padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
              <button onClick={() => { setRole(null); setError(""); setUsername(""); setPassword(""); }} style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 16 }}>←</button>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>Sign in as {role === "doctor" ? "Doctor" : "Patient"}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>{role === "doctor" ? "🩺 Clinical Portal" : "🫀 Wellness Portal"}</div>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" }}>Full Name</div>
                <input value={username} onChange={e => setUsername(e.target.value)} placeholder={role === "doctor" ? "Ananya Krishnan" : "Arjun Mehta"}
                  style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
                  onFocus={e => e.target.style.border = "1px solid rgba(99,102,241,0.6)"}
                  onBlur={e => e.target.style.border = "1px solid rgba(255,255,255,0.1)"} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, letterSpacing: 0.5, textTransform: "uppercase" }}>Password</div>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                  onKeyDown={e => e.key === "Enter" && handleLogin()}
                  style={{ width: "100%", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }}
                  onFocus={e => e.target.style.border = "1px solid rgba(99,102,241,0.6)"}
                  onBlur={e => e.target.style.border = "1px solid rgba(255,255,255,0.1)"} />
              </div>
              {error && <div style={{ fontSize: 12, color: "#f87171", padding: "10px 14px", background: "rgba(248,113,113,0.08)", borderRadius: 10, border: "1px solid rgba(248,113,113,0.2)" }}>{error}</div>}
              <button onClick={handleLogin} disabled={loading} style={{ padding: "14px", borderRadius: 14, border: "none", cursor: loading ? "wait" : "pointer", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontSize: 15, fontWeight: 700, boxShadow: "0 0 24px rgba(99,102,241,0.4)", transition: "all 0.2s", opacity: loading ? 0.7 : 1, fontFamily: "inherit" }}>
                {loading ? "Signing in..." : "Sign In →"}
              </button>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", textAlign: "center" }}>
                {role === "doctor" ? "Default: Ananya Krishnan / doc123" : "Default: Arjun Mehta / pat123"}
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}

// ─── PATIENT APP ──────────────────────────────────────────────────────────────
function PatientApp({ patient: initialPatient, onLogout, token }) {
  const isDesktop = useIsDesktop();
  const [tab, setTab] = useState("home");
  const [breatheActive, setBreatheActive] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [liveData, setLiveData] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [doctorMessages, setDoctorMessages] = useState([]);
  const [dailySummary, setDailySummary] = useState(null);
  const [latestAnalysis, setLatestAnalysis] = useState(null);
  const [promptSlot, setPromptSlot] = useState("day");
  const [patientProfile, setPatientProfile] = useState(initialPatient);
  const chatEndRef = useRef(null);

  const patient = { ...patientProfile, ...(liveData || {}) };
  const stress = getStressLevel(patient.hrv, patient.hr, patient.eda);

  // Fetch live ThingSpeak data
  useEffect(() => {
    const fetchLive = async () => {
      try {
        const data = await apiFetch("/thingspeak/latest", {}, token);
        setLiveData(data);
        setLiveError(null);
      } catch (e) { setLiveError(e.message); }
    };
    fetchLive();
    const interval = setInterval(fetchLive, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, [token]);

  // Fetch doctor messages
  useEffect(() => {
    apiFetch("/patient/messages", {}, token).then(setDoctorMessages).catch(() => {});
  }, [token]);

  useEffect(() => {
    apiFetch("/patient/checkin", {}, token).then(data => {
      if (data.messages?.length) setMessages(data.messages);
      else if (data.starter) setMessages([{ role: "assistant", text: data.starter, time: "Now" }]);
      if (data.profile) setPatientProfile(data.profile);
      setDailySummary(data.dailySummary || null);
      setLatestAnalysis(data.latestAnalysis || null);
      setPromptSlot(data.promptSlot || "day");
    }).catch(() => {});
  }, [token]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim()) return;
    const userMsg = { role: "user", text: input, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setMessages(m => [...m, userMsg]);
    setInput("");
    setIsTyping(true);

    const systemPrompt = `You are a compassionate mental health AI companion for a patient named ${patient.name}. Current vitals: HR ${patient.hr ?? "N/A"}bpm, HRV ${patient.hrv ?? "N/A"}ms, EDA ${patient.eda ?? "N/A"}uS, Mood ${typeof patient.mood === "number" ? `${patient.mood}/10` : "N/A"}, Sleep ${typeof patient.sleep === "number" ? `${patient.sleep}h` : "N/A"}. Condition: ${patient.condition}. Be warm, empathetic, brief (2-3 sentences). Never share clinical analysis or stress mismatch data.`;

    try {
      const data = await apiFetch("/ai/chat", {
        method: "POST",
        body: JSON.stringify({ systemPrompt, messages: [...messages, userMsg].slice(-10) })
      }, token);
      setLatestAnalysis(data.analysis || null);
      setDailySummary(data.summary || null);
      if (data.reset) {
        setMessages([{ role: "assistant", text: data.text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
      } else {
        setMessages(m => [...m, { role: "assistant", text: data.text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
      }
    } catch {
      setMessages(m => [...m, { role: "assistant", text: "I'm here with you. Take your time.", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }]);
    }
    setIsTyping(false);
  }, [input, messages, liveData, patient, token]);

  const tabs = [{ key: "home", label: "🏠 Home" }, { key: "chat", label: "💬 Talk" }, { key: "vitals", label: "📊 Vitals" }];
  const stateColor = stress.color;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #080814 0%, #0d0d24 40%, #080818 100%)", color: "white" }}>
      <NeuralBg />

      {/* Top Nav */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, background: "rgba(8,8,20,0.85)", backdropFilter: "blur(24px)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 60 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 9, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>🧠</div>
          <span style={{ fontWeight: 700, fontSize: 15 }}>NeuroMind</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: liveData ? "#34d399" : "#fb923c", boxShadow: `0 0 8px ${liveData ? "rgba(52,211,153,0.6)" : "rgba(251,146,60,0.6)"}` }} />
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{patient.name}</span>
          <button onClick={onLogout} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer" }}>Sign Out</button>
        </div>
      </div>

      {isDesktop ? (
        <div style={{ position: "fixed", top: 72, left: 0, right: 0, zIndex: 99 }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", padding: "0 24px" }}>
            <GlassCard style={{ padding: 8, display: "flex", gap: 8, background: "rgba(255,255,255,0.03)" }}>
              {tabs.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, padding: "12px 14px", borderRadius: 14, border: "none", background: tab === t.key ? "linear-gradient(135deg, rgba(99,102,241,0.35), rgba(139,92,246,0.35))" : "transparent", color: tab === t.key ? "#dbe4ff" : "rgba(255,255,255,0.45)", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }}>{t.label}</button>
              ))}
            </GlassCard>
          </div>
        </div>
      ) : (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, background: "rgba(8,8,20,0.9)", backdropFilter: "blur(24px)", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", padding: "8px 16px 16px" }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{ flex: 1, padding: "10px 8px", borderRadius: 12, border: "none", background: tab === t.key ? "rgba(99,102,241,0.2)" : "transparent", color: tab === t.key ? "#a5b4fc" : "rgba(255,255,255,0.35)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}>{t.label}</button>
          ))}
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, paddingTop: isDesktop ? 132 : 60, paddingBottom: isDesktop ? 36 : 80 }}>
        {tab === "home" && (
          <div style={{ maxWidth: isDesktop ? 1180 : 440, margin: "0 auto", padding: isDesktop ? "28px 24px" : "24px 16px", display: "grid", gridTemplateColumns: isDesktop ? "minmax(0, 1.25fr) minmax(320px, 0.75fr)" : "1fr", gap: 16, animation: "slide-in 0.3s ease" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <div style={{ fontSize: isDesktop ? 30 : 22, fontWeight: 800 }}>Hey, {patient.name.split(" ")[0]} 👋</div>
                <div style={{ fontSize: isDesktop ? 14 : 13, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>How are you doing today?</div>
              </div>

              {/* Live data status */}
              {liveData && (
                <div style={{ padding: "10px 16px", borderRadius: 12, background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", fontSize: 12, color: "#34d399", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399" }} />
                  Live sensor data connected · Updated {new Date(liveData.timestamp).toLocaleTimeString()}
                </div>
              )}
              {liveError && (
                <div style={{ padding: "10px 16px", borderRadius: 12, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)", fontSize: 12, color: "#fb923c" }}>
                  No real sensor reading is available right now.
                </div>
              )}

              {/* Brain State */}
              <GlassCard style={{ padding: isDesktop ? 28 : 24, textAlign: "center", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: `radial-gradient(ellipse at center, ${stateColor}15 0%, transparent 70%)` }} />
                <div style={{ width: 90, height: 90, borderRadius: "50%", margin: "0 auto 16px", border: `3px solid ${stateColor}`, boxShadow: `0 0 30px ${stateColor}40, 0 0 60px ${stateColor}20`, display: "flex", alignItems: "center", justifyContent: "center", animation: "breathe 4s ease-in-out infinite", background: `radial-gradient(circle, ${stateColor}20, transparent)` }}>
                  <div style={{ textAlign: "center" }}><div style={{ fontSize: 24 }}>🧠</div></div>
                </div>
                <BrainWave color={stateColor} width={isDesktop ? 420 : 280} height={40} speed={stress.available && stress.value > 60 ? 3 : 6} />
                <div style={{ marginTop: 12, fontSize: 16, fontWeight: 700, color: stateColor }}>{stress.label}</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>
                  {stress.available ? "Your Current State" : "Waiting for real sensor data"}
                </div>
              </GlassCard>

              <GlassCard style={{ padding: 18 }}>
                <div style={{ fontSize: 11, color: "#a5b4fc", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Structured Check-In</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>
                  {promptSlot === "morning" ? "Morning prompt" : promptSlot === "afternoon" ? "Afternoon prompt" : "Night prompt"}
                </div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.58)", lineHeight: 1.7 }}>
                  {messages[0]?.role === "assistant" ? messages[0].text : "Open the Talk tab and answer your guided check-in."}
                </div>
              </GlassCard>

              {(latestAnalysis || dailySummary) && (
                <GlassCard style={{ padding: 18 }}>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>AI Insight</div>
                  {latestAnalysis?.insight && (
                    <div style={{ fontSize: 14, color: "rgba(255,255,255,0.82)", lineHeight: 1.7, marginBottom: 12 }}>
                      {latestAnalysis.insight}
                    </div>
                  )}
                  {latestAnalysis && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: dailySummary ? 12 : 0 }}>
                      <Badge label={latestAnalysis.sentiment} color={latestAnalysis.sentiment === "negative" ? "#f87171" : latestAnalysis.sentiment === "positive" ? "#34d399" : "#fb923c"} />
                      <Badge label={latestAnalysis.emotion} color="#818cf8" />
                      <Badge label={`${latestAnalysis.stressLevel} stress`} color={latestAnalysis.stressLevel === "high" ? "#f87171" : latestAnalysis.stressLevel === "medium" ? "#fb923c" : "#34d399"} />
                    </div>
                  )}
                  {dailySummary?.text && (
                    <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", fontSize: 12, color: "rgba(255,255,255,0.55)", lineHeight: 1.7 }}>
                      {dailySummary.text}
                    </div>
                  )}
                </GlassCard>
              )}

              {/* Quick Stats */}
              <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "repeat(4, 1fr)" : "1fr 1fr", gap: 12 }}>
                {[
                  { label: "Mood Score", value: formatScore(patient.mood), sub: getMoodLabel(patient.mood), color: "#818cf8", icon: "◉" },
                  { label: "Heart Rate", value: formatMetricValue(patient.hr, " bpm"), sub: typeof patient.hr === "number" ? (patient.hr > 90 ? "Slightly elevated" : "Good") : "No data", color: "#f472b6", icon: "♥" },
                  { label: "Sleep Last Night", value: formatHours(patient.sleep), sub: typeof patient.sleep === "number" ? (patient.sleep < 6 ? "Could be better" : "Good rest") : "No data", color: "#38bdf8", icon: "◑" },
                  { label: "Check-in Streak", value: `${patient.streak || 0} days`, sub: patient.streak ? "Keep it up!" : "No streak yet", color: "#fbbf24", icon: "🔥" },
                ].map(s => (
                  <GlassCard key={s.label} style={{ padding: 16 }}>
                    <div style={{ fontSize: 18, marginBottom: 6 }}>{s.icon}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{s.label}</div>
                    <div style={{ fontSize: 10, color: s.color, marginTop: 4, fontWeight: 600 }}>{s.sub}</div>
                  </GlassCard>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Wellness Tools */}
              <GlassCard style={{ padding: 18 }}>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 12, letterSpacing: 1, textTransform: "uppercase" }}>Wellness Tools</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => setBreatheActive(!breatheActive)} style={{ flex: 1, padding: "12px 10px", borderRadius: 14, border: "none", cursor: "pointer", background: breatheActive ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "rgba(99,102,241,0.12)", color: "white", fontSize: 13, fontWeight: 600, transition: "all 0.3s" }}>
                    {breatheActive ? "🌬️ Breathing..." : "🌬️ Breathe"}
                  </button>
                  <button onClick={() => setTab("chat")} style={{ flex: 1, padding: "12px 10px", borderRadius: 14, border: "none", cursor: "pointer", background: "rgba(139,92,246,0.12)", color: "white", fontSize: 13, fontWeight: 600, transition: "all 0.3s" }}>💬 Talk to AI</button>
                </div>
                {breatheActive && (
                  <div style={{ marginTop: 16, textAlign: "center" }}>
                    <div style={{ width: 70, height: 70, borderRadius: "50%", margin: "0 auto 10px", border: "3px solid #818cf8", boxShadow: "0 0 30px rgba(129,140,248,0.4)", animation: "breathe 4s ease-in-out infinite", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🫧</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>Breathe in… hold… breathe out</div>
                  </div>
                )}
              </GlassCard>

              {/* Doctor messages */}
              {doctorMessages.length > 0 && (
                <GlassCard style={{ padding: 18 }}>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 12, letterSpacing: 1, textTransform: "uppercase" }}>Messages from Your Doctor</div>
                  {doctorMessages.slice(0, 4).map(m => (
                    <div key={m.id} style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)", marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: "#818cf8", marginBottom: 4 }}>{m.doctor_name} · {new Date(m.sent_at).toLocaleString()}</div>
                      <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)" }}>{m.content}</div>
                    </div>
                  ))}
                </GlassCard>
              )}

              <div style={{ padding: "12px 16px", borderRadius: 14, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.18)", fontSize: 12, color: "rgba(255,255,255,0.45)", textAlign: "center" }}>
                🔒 Your data is automatically shared with your care team to support your wellbeing.
              </div>
            </div>
          </div>
        )}

        {tab === "chat" && (
          <div style={{ maxWidth: isDesktop ? 1180 : 440, margin: "0 auto", height: isDesktop ? "calc(100vh - 180px)" : "calc(100vh - 140px)", display: "grid", gridTemplateColumns: isDesktop ? "320px minmax(0, 1fr)" : "1fr", gap: 16, padding: isDesktop ? "0 24px" : "0 16px" }}>
            {isDesktop && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <GlassCard style={{ padding: 18 }}>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 10, letterSpacing: 1, textTransform: "uppercase" }}>Session Snapshot</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: stateColor, marginBottom: 6 }}>{stress.label}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", lineHeight: 1.7 }}>{latestAnalysis?.insight || "Use the chat to share how you're feeling and the assistant will respond with your recent sensor context in mind."}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
                    <div style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Mood</div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{formatScore(patient.mood)}</div>
                    </div>
                    <div style={{ padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Sleep</div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>{formatHours(patient.sleep)}</div>
                    </div>
                  </div>
                </GlassCard>
                {doctorMessages.length > 0 && (
                  <GlassCard style={{ padding: 18 }}>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 12, letterSpacing: 1, textTransform: "uppercase" }}>Care Team Notes</div>
                    {doctorMessages.slice(0, 3).map(m => (
                      <div key={m.id} style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)", marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: "#818cf8", marginBottom: 4 }}>{m.doctor_name}</div>
                        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.8)", lineHeight: 1.6 }}>{m.content}</div>
                      </div>
                    ))}
                  </GlassCard>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ padding: "20px 0 16px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 42, height: 42, borderRadius: 14, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, boxShadow: "0 0 20px rgba(99,102,241,0.3)", animation: "glow-pulse 3s ease-in-out infinite" }}>🧠</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>NeuroAI Companion</div>
                    <div style={{ fontSize: 11, color: "rgba(99,102,241,0.9)" }}>Responding using your saved check-ins and any available real sensor data</div>
                  </div>
                </div>
                {latestAnalysis && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                    <Badge label={latestAnalysis.sentiment} color={latestAnalysis.sentiment === "negative" ? "#f87171" : latestAnalysis.sentiment === "positive" ? "#34d399" : "#fb923c"} />
                    <Badge label={latestAnalysis.emotion} color={latestAnalysis.emotion === "crisis" ? "#f87171" : "#818cf8"} />
                    <Badge label={`${latestAnalysis.stressLevel} stress`} color={latestAnalysis.stressLevel === "high" ? "#f87171" : latestAnalysis.stressLevel === "medium" ? "#fb923c" : "#34d399"} />
                  </div>
                )}
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: "16px 0", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
                {messages.map((m, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                    <div style={{ maxWidth: isDesktop ? "72%" : "82%", padding: "12px 16px", borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px", background: m.role === "user" ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "rgba(255,255,255,0.06)", fontSize: 14, lineHeight: 1.6, color: "rgba(255,255,255,0.9)" }}>
                      {m.text}
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4, textAlign: "right" }}>{m.time}</div>
                    </div>
                  </div>
                ))}
                {isTyping && (
                  <div style={{ display: "flex", gap: 6, padding: "12px 16px", borderRadius: 18, background: "rgba(255,255,255,0.06)", width: "fit-content" }}>
                    {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#818cf8", animation: `breathe ${0.8 + i * 0.15}s ease-in-out infinite` }} />)}
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div style={{ padding: "12px 0", borderTop: "1px solid rgba(255,255,255,0.07)", display: "flex", gap: 10 }}>
                <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()} placeholder="How are you feeling?" style={{ flex: 1, padding: "13px 18px", borderRadius: 16, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "white", fontSize: 14, outline: "none", fontFamily: "inherit" }} />
                <button onClick={sendMessage} style={{ width: 48, height: 48, borderRadius: 14, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontSize: 20, boxShadow: "0 0 15px rgba(99,102,241,0.4)" }}>↑</button>
              </div>
            </div>
          </div>
        )}

        {tab === "vitals" && (
          <div style={{ maxWidth: isDesktop ? 1180 : 440, margin: "0 auto", padding: isDesktop ? "28px 24px" : "24px 16px", display: "grid", gridTemplateColumns: isDesktop ? "minmax(0, 1fr) minmax(0, 1fr)" : "1fr", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 800 }}>Your Vitals</div>
              {liveData ? (
                <GlassCard style={{ padding: 20 }}>
                  <div style={{ fontSize: 12, color: "#34d399", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>⬤ Live from ThingSpeak</div>
                  <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "repeat(3, 1fr)" : "1fr 1fr 1fr", gap: 12 }}>
                    {[
                      { label: "Heart Rate", value: liveData.hr ? `${liveData.hr}` : "--", unit: "bpm", color: "#f472b6" },
                      { label: "SpO2", value: liveData.hrv ? `${liveData.hrv}` : "--", unit: "ms", color: "#818cf8" },
                      { label: "HRV", value: liveData.eda ? `${liveData.eda}` : "--", unit: "μS", color: "#22d3ee" },
                    ].map(v => (
                      <div key={v.label} style={{ padding: "14px 12px", borderRadius: 14, background: "rgba(255,255,255,0.04)", textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: v.color }}>{v.value}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{v.unit}</div>
                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{v.label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 12, textAlign: "center" }}>Last updated: {new Date(liveData.timestamp).toLocaleTimeString()}</div>
                </GlassCard>
              ) : (
                <GlassCard style={{ padding: 20, textAlign: "center" }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>📡</div>
                  <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>No real sensor data yet</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>{liveError || "Connect ThingSpeak or ingest a real reading to populate this screen."}</div>
                </GlassCard>
              )}
            </div>
            <GlassCard style={{ padding: 20 }}>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>Wellness Scores</div>
              {[
                { label: "Mood", value: patient.mood, max: 10, color: "#818cf8" },
                { label: "Sleep Quality", value: patient.sleep, max: 10, color: "#38bdf8" },
                { label: "Stress Level", value: stress.available ? Math.round(stress.value) : null, max: 100, color: stress.color },
              ].map(v => (
                <div key={v.label} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "rgba(255,255,255,0.7)" }}>{v.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: v.color }}>{typeof v.value === "number" ? `${v.value}/${v.max}` : "--"}</span>
                  </div>
                  <MiniBar value={typeof v.value === "number" ? v.value : 0} max={v.max} color={v.color} />
                </div>
              ))}
            </GlassCard>

            {isDesktop && (
              <GlassCard style={{ padding: 20 }}>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>Trend Notes</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.75 }}>
                  Use this screen to compare your current physiology with your self-reported mood. On desktop, this wider layout keeps the latest readings, scores, and notes visible without feeling like a stretched phone screen.
                </div>
              </GlassCard>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DOCTOR DASHBOARD ─────────────────────────────────────────────────────────
function DoctorDashboard({ doctor, onLogout, token }) {
  const [patients, setPatients] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  // FIX 4: Removed dead `tab` state — overview/detail switching is handled by selectedPatient truthiness
  const [patientTab, setPatientTab] = useState("vitals");
  const [note, setNote] = useState("");
  const [notesSaved, setNotesSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [msgSent, setMsgSent] = useState(false);
  const [aiReport, setAiReport] = useState("");
  const [loadingReport, setLoadingReport] = useState(false);
  const [liveData, setLiveData] = useState(null);
  const [showAddPatient, setShowAddPatient] = useState(false);
  const [newPatient, setNewPatient] = useState({ name: "", age: "", condition: "", risk: "medium", password: "" });
  const [addError, setAddError] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [savedNotes, setSavedNotes] = useState([]);
  const [filter, setFilter] = useState("all");
  const [patientInsight, setPatientInsight] = useState(null);
  const [trendRange, setTrendRange] = useState("day");

  // Fetch patients
  const fetchPatients = useCallback(() => {
    apiFetch("/doctor/patients", {}, token).then(setPatients).catch(console.error);
  }, [token]);

  useEffect(() => { fetchPatients(); }, [fetchPatients]);

  // Fetch live ThingSpeak data
  useEffect(() => {
    const fetchLive = async () => {
      try {
        const data = await apiFetch(`/thingspeak/latest${selectedPatient ? `?patient_id=${selectedPatient.id}` : ""}`, {}, token);
        setLiveData(data);
      } catch {}
    };
    fetchLive();
    const interval = setInterval(fetchLive, 30000);
    return () => clearInterval(interval);
  }, [token, selectedPatient]);

  // Fetch notes when patient selected
  useEffect(() => {
    if (selectedPatient) {
      apiFetch(`/doctor/notes/${selectedPatient.id}`, {}, token).then(setSavedNotes).catch(() => {});
      apiFetch(`/doctor/patient-insights/${selectedPatient.id}`, {}, token).then(setPatientInsight).catch(() => setPatientInsight(null));
    }
  }, [selectedPatient, token]);

  const handleAddPatient = async () => {
    if (!newPatient.name || !newPatient.age || !newPatient.condition || !newPatient.password) {
      setAddError("All fields are required"); return;
    }
    setAddLoading(true); setAddError("");
    try {
      await apiFetch("/doctor/patients", { method: "POST", body: JSON.stringify(newPatient) }, token);
      fetchPatients();
      setShowAddPatient(false);
      setNewPatient({ name: "", age: "", condition: "", risk: "medium", password: "" });
    } catch (e) { setAddError(e.message); }
    setAddLoading(false);
  };

  const handleDeletePatient = async (pid) => {
    if (!window.confirm("Remove this patient from your care?")) return;
    await apiFetch(`/doctor/patients/${pid}`, { method: "DELETE" }, token);
    if (selectedPatient?.id === pid) setSelectedPatient(null);
    fetchPatients();
  };

  const handleSaveNote = async () => {
    if (!note.trim()) return;
    await apiFetch("/doctor/notes", { method: "POST", body: JSON.stringify({ patient_id: selectedPatient.id, note }) }, token);
    setNotesSaved(true);
    setNote("");
    setTimeout(() => setNotesSaved(false), 2500);
    apiFetch(`/doctor/notes/${selectedPatient.id}`, {}, token).then(setSavedNotes).catch(() => {});
  };

  const handleSendMessage = async () => {
    if (!message.trim()) return;
    await apiFetch("/doctor/message", { method: "POST", body: JSON.stringify({ patient_id: selectedPatient.id, content: message }) }, token);
    setMessage("");
    setMsgSent(true);
    setTimeout(() => setMsgSent(false), 2500);
  };

  const generateReport = async () => {
    setLoadingReport(true); setAiReport("");
    try {
      const data = await apiFetch("/ai/report", { method: "POST", body: JSON.stringify({ patient: selectedPatient, thingspeakData: liveData }) }, token);
      setAiReport(data.report);
    } catch (e) { setAiReport("Failed to generate report: " + e.message); }
    setLoadingReport(false);
  };

  const closePatientDetail = useCallback(() => {
    setSelectedPatient(null);
    setPatientInsight(null);
    setSavedNotes([]);
    setLiveData(null);
    setAiReport("");
    setPatientTab("vitals");
    setNote("");
    setMessage("");
  }, []);

  const filteredPatients = patients.filter(p => filter === "all" || p.risk === filter);
  const highRisk = patients.filter(p => p.risk === "high").length;
  const moodPatients = patients.filter(entry => typeof entry.mood === "number");
  const avgMood = moodPatients.length ? (moodPatients.reduce((a, b) => a + b.mood, 0) / moodPatients.length).toFixed(1) : "--";

  const p = patientInsight?.patient || selectedPatient;

  if (p) {
    const trendRows = [
      { label: "Heart Rate", series: buildTrendSeries(patientInsight?.sensorHistory, "hr", trendRange), fallback: buildLatestRecordedTrend(patientInsight?.sensorHistory, "hr", trendRange), color: "#f472b6", unit: "bpm" },
      { label: "SpO2", series: buildTrendSeries(patientInsight?.sensorHistory, "hrv", trendRange), fallback: buildLatestRecordedTrend(patientInsight?.sensorHistory, "hrv", trendRange), color: "#818cf8", unit: "ms" },
      { label: "HRV", series: buildTrendSeries(patientInsight?.sensorHistory, "eda", trendRange), fallback: buildLatestRecordedTrend(patientInsight?.sensorHistory, "eda", trendRange), color: "#22d3ee", unit: "uS" },
    ];
    const recentVitalsCharts = [
      { title: "Heart Rate", color: "#f472b6", unit: "bpm", points: buildRecentVitalsSeries(patientInsight?.sensorHistory, "hr") },
      { title: "SpO2", color: "#818cf8", unit: "ms", points: buildRecentVitalsSeries(patientInsight?.sensorHistory, "hrv") },
      { title: "HRV", color: "#22d3ee", unit: "uS", points: buildRecentVitalsSeries(patientInsight?.sensorHistory, "eda") },
    ];

    return (
      <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #080814 0%, #0d0d24 40%, #080818 100%)", color: "white" }}>
        <NeuralBg />
        {/* Header */}
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, background: "rgba(8,8,20,0.9)", backdropFilter: "blur(24px)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", gap: 12, padding: "0 20px", height: 60 }}>
          <button onClick={closePatientDetail} style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", cursor: "pointer", color: "rgba(255,255,255,0.6)", fontSize: 16 }}>←</button>
          <div style={{ width: 36, height: 36, borderRadius: 12, background: `${getRiskColor(p.risk)}22`, border: `1px solid ${getRiskColor(p.risk)}44`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, color: getRiskColor(p.risk) }}>{p.avatar}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>{p.condition} · Age {p.age}</div>
          </div>
          <Badge label={p.risk} color={getRiskColor(p.risk)} />
        </div>

        {/* Patient Tabs — now includes Trends + Discrepancy */}
        <div style={{ position: "fixed", top: 60, left: 0, right: 0, zIndex: 99, background: "rgba(8,8,20,0.85)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", gap: 0, padding: "0 16px", overflowX: "auto" }}>
          {[["vitals","📊 Vitals"],["trends","📈 Trends"],["discrepancy","⚠ Discrepancy"],["ai","🤖 AI Report"],["actions","⚡ Actions"]].map(([k, l]) => (
            <button key={k} onClick={() => { setPatientTab(k); if (k === "ai" && !aiReport && !loadingReport) generateReport(); }} style={{ padding: "14px 16px", border: "none", background: "transparent", color: patientTab === k ? "#a5b4fc" : "rgba(255,255,255,0.4)", fontSize: 13, fontWeight: patientTab === k ? 700 : 400, cursor: "pointer", borderBottom: patientTab === k ? "2px solid #818cf8" : "2px solid transparent", whiteSpace: "nowrap", transition: "all 0.2s" }}>{l}</button>
          ))}
        </div>

        <div style={{ position: "relative", zIndex: 1, paddingTop: 120, paddingBottom: 30 }}>
          <div style={{ maxWidth: 800, margin: "0 auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16 }}>

            {patientTab === "vitals" && (
              <>
                {patientInsight?.dailySummary?.text && (
                  <GlassCard style={{ padding: 18, border: "1px solid rgba(99,102,241,0.2)", background: "rgba(99,102,241,0.04)" }}>
                    <div style={{ fontSize: 12, color: "#a5b4fc", marginBottom: 10, letterSpacing: 1, textTransform: "uppercase" }}>Daily Summary</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.68)", lineHeight: 1.8 }}>{patientInsight.dailySummary.text}</div>
                  </GlassCard>
                )}

                {/* Live ThingSpeak data for this patient */}
                <GlassCard style={{ padding: 20 }}>
                  <div style={{ fontSize: 12, color: liveData ? "#34d399" : "#fb923c", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>
                    {liveData ? "⬤ Live Sensor Data (ThingSpeak)" : "○ Sensor Offline"}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
                    {recentVitalsCharts.map(chart => (
                      <VitalsHistoryChart
                        key={chart.title}
                        title={chart.title}
                        color={chart.color}
                        unit={chart.unit}
                        points={chart.points}
                      />
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                    {[
                      { label: "Heart Rate", value: liveData?.hr || "--", unit: "bpm", color: "#f472b6" },
                      { label: "SpO2", value: liveData?.hrv || "--", unit: "ms", color: "#818cf8" },
                      { label: "HRV", value: liveData?.eda || "--", unit: "μS", color: "#22d3ee" },
                    ].map(v => (
                      <div key={v.label} style={{ padding: "16px", borderRadius: 14, background: "rgba(255,255,255,0.04)", textAlign: "center" }}>
                        <div style={{ fontSize: 26, fontWeight: 700, color: v.color }}>{v.value}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>{v.unit}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 4 }}>{v.label}</div>
                      </div>
                    ))}
                  </div>
                  {liveData && <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 12, textAlign: "center" }}>Updated: {new Date(liveData.timestamp).toLocaleString()}</div>}
                </GlassCard>

                {/* Patient profile data */}
                <GlassCard style={{ padding: 20 }}>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>Patient Profile</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    {[
                      { label: "Mood Score", value: formatScore(p.mood), color: "#818cf8" },
                      { label: "Sleep", value: formatHours(p.sleep), color: "#38bdf8" },
                      { label: "Check-in Streak", value: `${p.streak || 0} days`, color: "#fbbf24" },
                      { label: "Risk Level", value: p.risk, color: getRiskColor(p.risk) },
                    ].map(v => (
                      <div key={v.label} style={{ padding: "14px", borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: v.color }}>{v.value}</div>
                        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{v.label}</div>
                      </div>
                    ))}
                  </div>
                </GlassCard>

                {patientInsight?.latestAnalysis && (
                  <GlassCard style={{ padding: 20 }}>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>Latest NLP Analysis</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                      <Badge label={patientInsight.latestAnalysis.sentiment} color={patientInsight.latestAnalysis.sentiment === "negative" ? "#f87171" : patientInsight.latestAnalysis.sentiment === "positive" ? "#34d399" : "#fb923c"} />
                      <Badge label={patientInsight.latestAnalysis.emotion} color="#818cf8" />
                      <Badge label={`${patientInsight.latestAnalysis.stressLevel} stress`} color={patientInsight.latestAnalysis.stressLevel === "high" ? "#f87171" : patientInsight.latestAnalysis.stressLevel === "medium" ? "#fb923c" : "#34d399"} />
                    </div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.72)", lineHeight: 1.7 }}>{patientInsight.latestAnalysis.insight}</div>
                  </GlassCard>
                )}

                {/* Saved clinical notes */}
                {savedNotes.length > 0 && (
                  <GlassCard style={{ padding: 20 }}>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 16, letterSpacing: 1, textTransform: "uppercase" }}>Previous Clinical Notes</div>
                    {savedNotes.map(n => (
                      <div key={n.id} style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 8 }}>
                        <div style={{ fontSize: 11, color: "#818cf8", marginBottom: 4 }}>{new Date(n.created_at).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", lineHeight: 1.6 }}>{n.note}</div>
                      </div>
                    ))}
                  </GlassCard>
                )}
              </>
            )}

            {patientTab === "trends" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <GlassCard style={{ padding: 22 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", letterSpacing: 1, textTransform: "uppercase" }}>Recorded Sensor Trends</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {[
                        ["day", "Day"],
                        ["week", "Week"],
                        ["month", "Month"],
                        ["year", "Year"]
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => setTrendRange(key)}
                          style={{
                            padding: "7px 12px",
                            borderRadius: 999,
                            border: "1px solid rgba(255,255,255,0.1)",
                            background: trendRange === key ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)",
                            color: trendRange === key ? "#c7d2fe" : "rgba(255,255,255,0.55)",
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: "inherit"
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {trendRows.map(row => (
                    <div key={row.label} style={{ marginBottom: 18 }}>
                      {(() => {
                        const activePoints = row.series.points;
                        const activeValues = activePoints.map(point => point.value).filter(value => typeof value === "number");
                        const noDataIntervals = activePoints.filter(point => typeof point.value !== "number").length;
                        const latestValue = activeValues.length ? activeValues[activeValues.length - 1] : null;
                        const statusText = trendRange === "day"
                          ? row.series.populatedBuckets > 0
                            ? `Showing last ${row.series.populatedBuckets} reading${row.series.populatedBuckets === 1 ? "" : "s"} from today`
                            : "No readings recorded today"
                          : noDataIntervals > 0
                            ? `${row.series.populatedBuckets} populated intervals, ${noDataIntervals} no-data intervals`
                            : `${row.series.populatedBuckets} populated intervals`;

                        return (
                          <>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div>
                          <span style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", fontWeight: 600 }}>{row.label}</span>
                          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginLeft: 8 }}>
                            {statusText}
                          </span>
                        </div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: row.color }}>
                          {typeof latestValue === "number" ? `${latestValue} ${row.unit}` : "--"}
                        </span>
                      </div>
                      <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 12, padding: "10px 12px" }}>
                        {activeValues.length >= 1 ? (
                          <>
                            <SparkLine data={activePoints.map(point => point.value)} color={row.color} height={48} width={680} filled={true} />
                            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, gap: 8 }}>
                              {activePoints.map((point, index) => (
                                <span key={`${row.label}-${index}`} style={{ fontSize: 10, color: typeof point.value === "number" ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.14)", minWidth: 0 }}>
                                  {point.label}
                                </span>
                              ))}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", textAlign: "center", padding: "16px 0" }}>
                            No data has been recorded in this {trendRange} range yet.
                          </div>
                        )}
                      </div>
                          </>
                        );
                      })()}
                    </div>
                  ))}
                </GlassCard>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {[
                    { label: "Latest Mood", value: formatScore(p.mood), color: "#818cf8", sub: getMoodLabel(p.mood) },
                    { label: "Latest Sleep", value: formatHours(p.sleep), color: "#38bdf8", sub: typeof p.sleep === "number" ? (p.sleep < 6 ? "Below target" : "On track") : "No data" },
                    { label: "Stress Level", value: getStressLevel(p.hrv,p.hr,p.eda).label, color: getStressLevel(p.hrv,p.hr,p.eda).color, sub: getStressLevel(p.hrv,p.hr,p.eda).available ? "Based on vitals" : "Needs real vitals" },
                    { label: "Risk Level", value: p.risk, color: getRiskColor(p.risk), sub: "Clinician-set" },
                  ].map(s => (
                    <GlassCard key={s.label} style={{ padding: 16 }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
                      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 3 }}>{s.label}</div>
                      <div style={{ fontSize: 10, color: s.color, marginTop: 4, fontWeight: 600 }}>{s.sub}</div>
                    </GlassCard>
                  ))}
                </div>
              </div>
            )}

            {/* FIX 5: Discrepancy Analysis Panel — new, was missing */}
            {patientTab === "discrepancy" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <GlassCard style={{ padding: 22 }}>
                  <div style={{ fontSize: 12, color: "#fb923c", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>⚠ Self-Report vs Physiological Mismatch</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginBottom: 20, lineHeight: 1.6 }}>
                    This view compares what the patient said in chat with what the body was showing at the same time. It highlights whether the words and vitals were aligned, mixed, or meaningfully different.
                  </div>

                  {patientInsight?.comparisons?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
                      {patientInsight.comparisons.map(entry => (
                        <div key={entry.id} style={{ padding: "16px 18px", borderRadius: 14, border: `1px solid ${entry.severity === "high" ? "rgba(248,113,113,0.3)" : entry.severity === "medium" ? "rgba(251,146,60,0.3)" : "rgba(52,211,153,0.25)"}`, background: entry.severity === "high" ? "rgba(248,113,113,0.05)" : entry.severity === "medium" ? "rgba(251,146,60,0.05)" : "rgba(52,211,153,0.04)" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8 }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: entry.severity === "high" ? "#f87171" : entry.severity === "medium" ? "#fb923c" : "#34d399" }}>{entry.relationTitle}</div>
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 3 }}>{entry.time}</div>
                            </div>
                            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", whiteSpace: "nowrap" }}>
                              {entry.stressLevel} stress · {entry.stressScore}/10
                            </div>
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
                            <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Chat Signal</div>
                              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", lineHeight: 1.55, marginBottom: 6 }}>"{entry.excerpt}"</div>
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.58)", lineHeight: 1.55 }}>{entry.patientTone}</div>
                            </div>
                            <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(255,255,255,0.04)" }}>
                              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Body Signal</div>
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.82)", lineHeight: 1.6, marginBottom: 6 }}>{entry.vitalsSummary}</div>
                              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.58)", lineHeight: 1.55 }}>{entry.bodyState}</div>
                            </div>
                          </div>

                          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.72)", lineHeight: 1.65 }}>
                            {entry.relationDetail}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {(() => {
                    if (patientInsight?.discrepancies?.length) {
                      return patientInsight.discrepancies.map((ev, i) => (
                        <div key={i} style={{ padding: "16px 18px", borderRadius: 14, marginBottom: 12, border: `1px solid ${ev.severity === "high" ? "rgba(248,113,113,0.3)" : ev.severity === "medium" ? "rgba(251,146,60,0.3)" : "rgba(52,211,153,0.25)"}`, background: ev.severity === "high" ? "rgba(248,113,113,0.05)" : ev.severity === "medium" ? "rgba(251,146,60,0.05)" : "rgba(52,211,153,0.04)", position: "relative", overflow: "hidden" }}>
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: ev.severity === "high" ? "#f87171" : ev.severity === "medium" ? "#fb923c" : "#34d399", borderRadius: "2px 0 0 2px" }} />
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6, paddingLeft: 6 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: ev.severity === "high" ? "#f87171" : ev.severity === "medium" ? "#fb923c" : "#34d399", flex: 1, lineHeight: 1.4 }}>{ev.title}</div>
                            {ev.confidence !== "N/A" && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 8, background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.4)", whiteSpace: "nowrap", marginLeft: 10 }}>Confidence: {ev.confidence}</span>}
                          </div>
                          <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.65, paddingLeft: 6 }}>{ev.desc}</div>
                          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 8, paddingLeft: 6 }}>{ev.time}</div>
                        </div>
                      ));
                    }

                    return [(
                      <div key="no-discrepancy-events" style={{ padding: "16px 18px", borderRadius: 14, marginBottom: 12, border: "1px solid rgba(52,211,153,0.25)", background: "rgba(52,211,153,0.04)", position: "relative", overflow: "hidden" }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#34d399", lineHeight: 1.4 }}>No major mismatch events were detected</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", lineHeight: 1.65, marginTop: 6 }}>
                          The comparisons above still show how the patient’s words and physiology related at each important moment, even when they were broadly aligned.
                        </div>
                      </div>
                    )];
                  })()}
                </GlassCard>

                <GlassCard style={{ padding: 20, border: "1px solid rgba(99,102,241,0.2)", background: "rgba(99,102,241,0.04)" }}>
                  <div style={{ fontSize: 12, color: "#a5b4fc", marginBottom: 10, fontWeight: 600 }}>Clinical Interpretation</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.8 }}>
                    Use this panel to judge whether the patient’s self-report is <strong style={{ color: "rgba(255,255,255,0.85)" }}>open and consistent</strong>, emotionally distressed without strong body activation, or calmer in words than the body suggests.
                    Repeated hidden-stress patterns may point toward emotional suppression, low interoceptive awareness, or difficulty naming distress.
                    Repeated emotional-over-physiology patterns may reflect cognitive strain or verbal distress without strong autonomic activation.
                  </div>
                </GlassCard>
              </div>
            )}

            {patientTab === "ai" && (
              <GlassCard style={{ padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>AI Clinical Report — {p.name}</div>
                  <button onClick={generateReport} disabled={loadingReport} style={{ padding: "8px 16px", borderRadius: 10, border: "none", cursor: "pointer", background: "rgba(99,102,241,0.2)", color: "#a5b4fc", fontSize: 12, fontWeight: 600 }}>{loadingReport ? "Generating..." : "↻ Regenerate"}</button>
                </div>
                {loadingReport ? (
                  <div style={{ textAlign: "center", padding: "40px 0" }}>
                    <div style={{ width: 40, height: 40, borderRadius: "50%", border: "3px solid rgba(99,102,241,0.3)", borderTop: "3px solid #818cf8", animation: "spin 1s linear infinite", margin: "0 auto 16px" }} />
                    <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)" }}>Generating clinical report…</div>
                  </div>
                ) : aiReport ? (
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.85, color: "rgba(255,255,255,0.82)", fontFamily: "'Georgia', serif" }}>{aiReport}</div>
                ) : (
                  <div style={{ padding: "24px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)" }}>Click Regenerate to create a structured clinical report using the patient profile, recent chat analysis, and sensor trends.</div>
                  </div>
                )}
              </GlassCard>
            )}

            {patientTab === "actions" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <GlassCard style={{ padding: 22 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Add Clinical Note</div>
                  <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Clinical observations, session notes, treatment adjustments…" rows={5} style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "14px 16px", color: "white", fontSize: 14, resize: "vertical", outline: "none", lineHeight: 1.6, boxSizing: "border-box", fontFamily: "inherit" }} />
                  <button onClick={handleSaveNote} style={{ marginTop: 12, padding: "11px 24px", borderRadius: 12, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                    {notesSaved ? "✓ Saved" : "Save Note"}
                  </button>
                </GlassCard>

                <GlassCard style={{ padding: 22 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Send Patient Message</div>
                  <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Message to patient…" rows={3} style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "14px 16px", color: "white", fontSize: 14, resize: "vertical", outline: "none", lineHeight: 1.6, boxSizing: "border-box", fontFamily: "inherit" }} />
                  <button onClick={handleSendMessage} style={{ marginTop: 12, padding: "11px 24px", borderRadius: 12, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>
                    {msgSent ? "✓ Sent!" : "Send Message →"}
                  </button>
                </GlassCard>

                {/* Update risk */}
                <GlassCard style={{ padding: 22 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 14 }}>Update Risk Level</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    {["low", "medium", "high"].map(r => (
                      <button key={r} onClick={async () => {
                        await apiFetch(`/doctor/patients/${p.id}`, { method: "PATCH", body: JSON.stringify({ risk: r }) }, token);
                        fetchPatients();
                        setSelectedPatient(prev => ({ ...prev, risk: r }));
                      }} style={{ flex: 1, padding: "10px", borderRadius: 12, border: `1px solid ${getRiskColor(r)}44`, background: p.risk === r ? `${getRiskColor(r)}22` : "transparent", color: getRiskColor(r), fontSize: 13, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{r}</button>
                    ))}
                  </div>
                </GlassCard>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── DOCTOR MAIN DASHBOARD ──────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #080814 0%, #0d0d24 40%, #080818 100%)", color: "white" }}>
      <NeuralBg />

      {/* Add Patient Modal */}
      {showAddPatient && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <GlassCard style={{ padding: 32, maxWidth: 440, width: "100%", animation: "pop-in 0.4s ease" }}>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 20 }}>Add New Patient</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { label: "Full Name", key: "name", placeholder: "Patient full name" },
                { label: "Age", key: "age", placeholder: "Age", type: "number" },
                { label: "Condition", key: "condition", placeholder: "e.g. Generalized Anxiety" },
                { label: "Login Password", key: "password", placeholder: "Patient's login password", type: "password" },
              ].map(f => (
                <div key={f.key}>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{f.label}</div>
                  <input type={f.type || "text"} value={newPatient[f.key]} onChange={e => setNewPatient(n => ({ ...n, [f.key]: e.target.value }))} placeholder={f.placeholder}
                    style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "white", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
                </div>
              ))}
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Risk Level</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {["low", "medium", "high"].map(r => (
                    <button key={r} onClick={() => setNewPatient(n => ({ ...n, risk: r }))} style={{ flex: 1, padding: "9px", borderRadius: 10, border: `1px solid ${getRiskColor(r)}44`, background: newPatient.risk === r ? `${getRiskColor(r)}22` : "transparent", color: getRiskColor(r), fontSize: 12, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{r}</button>
                  ))}
                </div>
              </div>
              {addError && <div style={{ fontSize: 12, color: "#f87171", padding: "8px 12px", background: "rgba(248,113,113,0.08)", borderRadius: 8 }}>{addError}</div>}
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button onClick={() => setShowAddPatient(false)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                <button onClick={handleAddPatient} disabled={addLoading} style={{ flex: 2, padding: "12px", borderRadius: 12, border: "none", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{addLoading ? "Adding..." : "Add Patient"}</button>
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Top Nav */}
      <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 100, background: "rgba(8,8,20,0.9)", backdropFilter: "blur(24px)", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", height: 64 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>🧠</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>NeuroMind</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)" }}>Clinical Dashboard</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: liveData ? "#34d399" : "#fb923c" }} />
          <span style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>{doctor.name}</span>
          <button onClick={onLogout} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)", fontSize: 12, cursor: "pointer" }}>Sign Out</button>
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 1, paddingTop: 80, maxWidth: 900, margin: "0 auto", padding: "80px 20px 40px" }}>

        {/* Stats Row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
          {[
            { label: "Total Patients", value: patients.length, color: "#818cf8", icon: "👥" },
            { label: "High Risk", value: highRisk, color: "#f87171", icon: "⚠" },
            { label: "Avg Mood", value: avgMood + "/10", color: "#34d399", icon: "◉" },
            { label: "ThingSpeak", value: liveData ? "Live" : "Offline", color: liveData ? "#34d399" : "#fb923c", icon: "📡" },
          ].map(s => (
            <GlassCard key={s.label} style={{ padding: "18px 16px" }}>
              <div style={{ fontSize: 22, marginBottom: 8 }}>{s.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{s.label}</div>
            </GlassCard>
          ))}
        </div>

        {/* Patients Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Your Patients</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>{filteredPatients.length} showing</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Risk filter */}
            <div style={{ display: "flex", gap: 6 }}>
              {["all", "high", "medium", "low"].map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 12px", borderRadius: 8, border: `1px solid ${f === "all" ? "rgba(255,255,255,0.1)" : getRiskColor(f) + "44"}`, background: filter === f ? (f === "all" ? "rgba(255,255,255,0.08)" : `${getRiskColor(f)}22`) : "transparent", color: f === "all" ? "rgba(255,255,255,0.6)" : getRiskColor(f), fontSize: 11, fontWeight: 600, cursor: "pointer", textTransform: "capitalize" }}>{f}</button>
              ))}
            </div>
            <button onClick={() => setShowAddPatient(true)} style={{ padding: "9px 18px", borderRadius: 12, border: "none", cursor: "pointer", background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "white", fontSize: 13, fontWeight: 700, boxShadow: "0 0 15px rgba(99,102,241,0.3)" }}>+ Add Patient</button>
          </div>
        </div>

        {/* Patient Cards Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {filteredPatients.map(pat => {
            const rc = getRiskColor(pat.risk);
            return (
              <GlassCard key={pat.id} glow={getRiskGlow(pat.risk)} style={{ padding: 20, cursor: "pointer", position: "relative" }} onClick={() => setSelectedPatient(pat)}>
                <button onClick={e => { e.stopPropagation(); handleDeletePatient(pat.id); }} style={{ position: "absolute", top: 12, right: 12, width: 26, height: 26, borderRadius: 7, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(248,113,113,0.1)", color: "#f87171", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 14, background: `${rc}22`, border: `1px solid ${rc}44`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, color: rc }}>{pat.avatar}</div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{pat.name}</div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>{pat.condition}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <Badge label={pat.risk} color={rc} />
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>Age {pat.age}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  {[
                    { l: "Mood", v: formatScore(pat.mood), c: "#818cf8" },
                    { l: "Sleep", v: formatHours(pat.sleep), c: "#38bdf8" },
                    { l: "Streak", v: `${pat.streak || 0}d`, c: "#fbbf24" },
                  ].map(s => (
                    <div key={s.l} style={{ padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,0.04)", textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: s.c }}>{s.v}</div>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{s.l}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)" }}>ID: {pat.id}</div>
                  <div style={{ fontSize: 12, color: "#818cf8", fontWeight: 600 }}>View Details →</div>
                </div>
              </GlassCard>
            );
          })}
          {filteredPatients.length === 0 && (
            <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "60px 0", color: "rgba(255,255,255,0.3)" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
              <div style={{ fontSize: 14 }}>{filter !== "all" ? `No ${filter}-risk patients` : "No patients yet — add your first patient"}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);

  // FIX 1: Properly restore session from localStorage on mount
  useEffect(() => {
    const token = localStorage.getItem("neuromind_token");
    const savedSession = localStorage.getItem("neuromind_session");
    if (token && savedSession) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (payload.exp * 1000 > Date.now()) {
          // Token still valid — restore session without re-login
          const { role, user } = JSON.parse(savedSession);
          setSession({ role, user, token });
        } else {
          // Token expired — clear storage
          localStorage.removeItem("neuromind_token");
          localStorage.removeItem("neuromind_session");
        }
      } catch {
        localStorage.removeItem("neuromind_token");
        localStorage.removeItem("neuromind_session");
      }
    }
    setRestoring(false);
  }, []);

  const handleLogin = (role, user, token) => {
    // Persist role + user alongside the token so we can restore on refresh
    localStorage.setItem("neuromind_session", JSON.stringify({ role, user }));
    setSession({ role, user, token });
  };

  const handleLogout = () => {
    localStorage.removeItem("neuromind_token");
    localStorage.removeItem("neuromind_session");
    setSession(null);
  };

  // Show nothing while restoring to avoid flash of login screen
  if (restoring) return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #080814 0%, #0d0d24 40%, #080818 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", border: "3px solid rgba(99,102,241,0.3)", borderTop: "3px solid #818cf8", animation: "spin 1s linear infinite" }} />
      <style>{`@keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #080814 0%, #0d0d24 40%, #080818 100%)", color: "white" }}>
      <NeuralBg />
      {!session && <LoginScreen onLogin={handleLogin} />}
      {session?.role === "patient" && <PatientApp patient={session.user} onLogout={handleLogout} token={session.token} />}
      {session?.role === "doctor" && <DoctorDashboard doctor={session.user} onLogout={handleLogout} token={session.token} />}
    </div>
  );
}
