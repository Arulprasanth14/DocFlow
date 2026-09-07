
import {
  FileText,
  GitBranch,
  Users,
  Clock,
  Check,
  X,
  TrendingUp,
  AlertCircle,
  ArrowUpRight,
  Circle,
  Activity,
  Zap,
  Upload,
  CheckCircle,
  UserPlus
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { useNavigate } from "react-router-dom";
import { useDashboardStats } from "@/hooks/useAnalytics";
import { useMyApprovalQueue, useApproveStep, useRejectStep } from "@/hooks/useApprovals";
import { useDocuments } from "@/hooks/useDocuments";
const C = {
  bg: "var(--bg-base)",
  secondBg: "var(--bg-overlay)",
  card: "var(--bg-elevated)",
  sidebar: "var(--bg-surface)",
  border: "var(--border-default)",
  primary: "var(--color-primary-500)",
  primaryHover: "var(--color-primary-400)",
  success: "var(--color-success-400)",
  danger: "var(--color-error-400)",
  warning: "var(--color-warning-400)",
  purple: "var(--color-accent-400)",
  heading: "var(--text-primary)",
  body: "var(--text-secondary)",
  secondary: "var(--text-muted)",
  disabled: "var(--text-disabled)",
};

// ── sample data ────────────────────────────────────────────────────
const pendingApprovals = [
  { doc: "Q4 Financial Report", owner: "Sarah Chen", avatar: "SC", time: "2h ago", status: "urgent" },
  { doc: "Product Roadmap 2025", owner: "Marcus Lee", avatar: "ML", time: "4h ago", status: "pending" },
  { doc: "HR Policy Update", owner: "Anika Patel", avatar: "AP", time: "6h ago", status: "pending" },
  { doc: "Vendor Contract — AWS", owner: "James Wright", avatar: "JW", time: "1d ago", status: "review" },
];

const recentDocs = [
  { name: "Annual Budget Draft", type: "Finance", modified: "Today, 10:42", progress: 78 },
  { name: "Brand Guidelines v3", type: "Design", modified: "Today, 09:15", progress: 100 },
  { name: "Security Audit Report", type: "IT", modified: "Yesterday", progress: 45 },
  { name: "Partnership MOU", type: "Legal", modified: "Yesterday", progress: 60 },
];

const timelineItems = [
  { user: "Sofia Reyes", avatar: "SR", action: "approved", doc: "Marketing Plan Q1", time: "12 min ago", color: C.success },
  { user: "David Kim", avatar: "DK", action: "uploaded", doc: "Tech Specs v2.4", time: "34 min ago", color: C.primary },
  { user: "Lena Müller", avatar: "LM", action: "rejected", doc: "Budget Revision", time: "1h ago", color: C.danger },
  { user: "Chris Obi", avatar: "CO", action: "commented on", doc: "Product Brief", time: "2h ago", color: C.warning },
  { user: "Yuki Tanaka", avatar: "YT", action: "shared", doc: "Investor Deck", time: "3h ago", color: C.purple },
];

const workflowNodes = [
  { label: "Draft", count: 12, color: C.secondary, done: true },
  { label: "Review", count: 8, color: C.warning, done: false },
  { label: "Approve", count: 5, color: C.primary, done: false },
  { label: "Sign", count: 3, color: C.purple, done: false },
  { label: "Archive", count: 24, color: C.success, done: true },
];

const statsData = [
  { label: "Active Docs", value: "148", change: "+12%", up: true, icon: FileText, color: C.primary },
  { label: "Pending", value: "37", change: "+3", up: false, icon: Clock, color: C.warning },
  { label: "Teams", value: "12", change: "2 new", up: true, icon: Users, color: C.purple },
  { label: "Completed", value: "94%", change: "+4%", up: true, icon: TrendingUp, color: C.success },
];

const chartData = [
  { day: "Mon", docs: 14 }, { day: "Tue", docs: 22 }, { day: "Wed", docs: 18 },
  { day: "Thu", docs: 31 }, { day: "Fri", docs: 27 }, { day: "Sat", docs: 9 }, { day: "Sun", docs: 15 },
];

// ── helpers ────────────────────────────────────────────────────────
function Avatar({ initials, size = 32, color = C.primary }: { initials: string; size?: number; color?: string }) {
  return (
    <div
      style={{ width: size, height: size, background: `color-mix(in srgb, ${color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, borderRadius: "50%", flexShrink: 0 }}
      className="flex items-center justify-center"
    >
      <span style={{ fontSize: size * 0.35, color, fontWeight: 600, fontFamily: "Inter, sans-serif" }}>
        {initials}
      </span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 20%, transparent)`, fontSize: 11, padding: "2px 8px", borderRadius: 20, fontWeight: 600, letterSpacing: 0.3 }}
    >
      {label}
    </span>
  );
}

function ProgressBar({ value, color = C.primary }: { value: number; color?: string }) {
  return (
    <div style={{ background: "var(--bg-overlay)", borderRadius: 99, height: 4, overflow: "hidden", flex: 1 }}>
      <div style={{ width: `${value}%`, height: "100%", background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 65%, transparent))`, borderRadius: 99, transition: "width 0.6s ease" }} />
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: stats } = useDashboardStats();
  const { data: myQueue } = useMyApprovalQueue();
  const { data: recentDocsData } = useDocuments({ page: 1, limit: 4, sort: '-updated_at' });
  const approveM = useApproveStep();
  const rejectM = useRejectStep();

  const realPendingApprovals = (myQueue || []).slice(0, 4).map(step => {
    const doc = step.workflow_instance?.document;
    const submitter = doc?.submitter_name || "Unknown";
    return {
      id: step.id,
      doc: doc?.title || `Step ${step.id}`,
      owner: submitter,
      avatar: submitter.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase() || "U",
      time: new Date(step.workflow_instance?.started_at || Date.now()).toLocaleDateString(),
      status: "pending",
    };
  });
  const displayPending = realPendingApprovals.length > 0 ? realPendingApprovals : pendingApprovals;

  const realRecentDocs = (recentDocsData?.items || []).map(doc => ({
    name: doc.title,
    type: doc.doc_type_name || "Document",
    modified: new Date(doc.updated_at).toLocaleDateString(),
    progress: doc.status === "approved" ? 100 : doc.status === "pending_approval" || doc.status === "under_review" ? 60 : 20,
  }));
  const displayRecent = realRecentDocs.length > 0 ? realRecentDocs : recentDocs;

  return (
    <div style={{ position: "relative", minHeight: "100%", overflow: "hidden" }}>
      {/* ══ BACKGROUND LAYERS (extracted for Dashboard specific effects) ══ */}
      {/* L2 — blue ambient glow */}
      <div className="bg-blob-blue" style={{
        position: "absolute", bottom: -220, left: -180,
        width: 900, height: 900, borderRadius: 9999,
        background: "radial-gradient(circle, rgba(37,99,235,0.20) 0%, transparent 68%)",
        filter: "blur(260px)",
        zIndex: 1, pointerEvents: "none",
      }} />

      {/* L3 — purple ambient glow */}
      <div className="bg-blob-purple" style={{
        position: "absolute", top: -200, right: -180,
        width: 850, height: 850, borderRadius: 9999,
        background: "radial-gradient(circle, rgba(124,58,237,0.18) 0%, transparent 65%)",
        filter: "blur(240px)",
        zIndex: 1, pointerEvents: "none",
      }} />

      {/* ── CONTENT ── */}
      <div
        style={{ position: "relative", zIndex: 10, padding: "32px", display: "flex", flexDirection: "column", gap: 24 }}
        className="scrollbar-hide"
      >
        {/* Welcome Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ color: C.heading, fontSize: 28, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
              Welcome back 👋
            </h1>
            <p style={{ color: C.secondary, fontSize: 15, marginTop: 6 }}>
              Here's what's happening across your workspace today
            </p>
          </div>
          <button
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: C.primary, border: "none", borderRadius: 12, color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
            className="hover:opacity-90 transition-opacity"
          >
            <Zap size={16} />
            New Workflow
          </button>
        </div>

        {/* ── QUICK ACTIONS ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
          {[
            { icon: Upload, label: "Upload Doc", sub: "Drag & drop files", color: C.primary, action: () => navigate('/documents/new') },
            { icon: GitBranch, label: "New Workflow", sub: "Automate approvals", color: C.purple, action: () => navigate('/workflows') },
            { icon: CheckCircle, label: "Pending Review", sub: `${myQueue?.length || 5} awaiting you`, color: C.warning, action: () => navigate('/approvals') },
            { icon: UserPlus, label: "Invite Team", sub: "Add collaborators", color: C.success, action: () => navigate('/admin/members') },
          ].map((a) => (
            <button
              key={a.label}
              onClick={a.action}
              style={{
                background: "var(--bg-elevated)",
                backdropFilter: "blur(20px)",
                border: `1px solid var(--border-default)`,
                borderRadius: 20,
                padding: "20px",
                display: "flex",
                alignItems: "center",
                gap: 14,
                cursor: "pointer",
                transition: "all 0.2s",
                textAlign: "left",
              }}
              className="quick-action-card hover:border-white/20 transition-all"
            >
              <div className="quick-action-icon" style={{ width: 44, height: 44, background: `color-mix(in srgb, ${a.color} 10%, transparent)`, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.25s ease" }}>
                <a.icon size={22} color={a.color} />
              </div>
              <div>
                <div style={{ color: C.heading, fontWeight: 600, fontSize: 15 }}>{a.label}</div>
                <div style={{ color: C.secondary, fontSize: 12, marginTop: 2 }}>{a.sub}</div>
              </div>
            </button>
          ))}
        </div>

        {/* ── MIDDLE ROW ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20 }}>
          {/* Pending Approvals */}
          <div style={{ background: "var(--bg-elevated)", border: `1px solid var(--border-default)`, borderRadius: 20, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Pending Approvals</h3>
              <Badge label="5 new" color={C.danger} />
            </div>
            <div style={{ height: 1, background: C.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {displayPending.map((row) => (
                <div key={row.doc} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar initials={row.avatar} size={32} color={row.status === "urgent" ? C.danger : C.primary} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: C.heading, fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.doc}</div>
                    <div style={{ color: C.secondary, fontSize: 11 }}>{row.owner} · {row.time}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button onClick={async () => { if (row.id) { await approveM.mutateAsync({ stepId: row.id }); } }} style={{ width: 28, height: 28, background: `${C.success}18`, border: `1px solid ${C.success}30`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                      <Check size={14} color={C.success} />
                    </button>
                    <button onClick={async () => { if (row.id) { await rejectM.mutateAsync({ stepId: row.id, note: "Rejected from dashboard" }); } }} style={{ width: 28, height: 28, background: `${C.danger}18`, border: `1px solid ${C.danger}30`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                      <X size={14} color={C.danger} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => navigate('/approvals')} style={{ width: "100%", padding: "10px", background: `${C.primary}12`, border: `1px solid ${C.primary}20`, borderRadius: 12, color: C.primary, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              View All Approvals →
            </button>
          </div>

          {/* Recent Documents */}
          <div style={{ background: "var(--bg-elevated)", border: `1px solid var(--border-default)`, borderRadius: 20, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Recent Documents</h3>
              <button onClick={() => navigate('/documents')} style={{ color: C.secondary, fontSize: 12, background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                All <ArrowUpRight size={12} />
              </button>
            </div>
            <div style={{ height: 1, background: C.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {displayRecent.map((doc) => (
                <div key={doc.name}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <FileText size={14} color={C.secondary} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: C.heading, fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{doc.name}</div>
                      <div style={{ color: C.secondary, fontSize: 11 }}>{doc.type} · {doc.modified}</div>
                    </div>
                    <span style={{ color: doc.progress === 100 ? C.success : C.body, fontSize: 12, fontWeight: 600 }}>{doc.progress}%</span>
                  </div>
                  <ProgressBar value={doc.progress} color={doc.progress === 100 ? C.success : C.primary} />
                </div>
              ))}
            </div>
          </div>

          {/* Activity Timeline */}
          <div style={{ background: "var(--bg-elevated)", border: `1px solid var(--border-default)`, borderRadius: 20, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Activity Timeline</h3>
            <div style={{ height: 1, background: C.border }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {timelineItems.map((item, i) => (
                <div key={i} style={{ display: "flex", gap: 12, paddingBottom: i < timelineItems.length - 1 ? 16 : 0, position: "relative" }}>
                  {i < timelineItems.length - 1 && (
                    <div style={{ position: "absolute", left: 16, top: 32, bottom: 0, width: 1, background: C.border }} />
                  )}
                  <Avatar initials={item.avatar} size={32} color={item.color} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                      <span style={{ color: C.heading, fontWeight: 600 }}>{item.user} </span>
                      <span style={{ color: C.secondary }}>{item.action} </span>
                      <span style={{ color: item.color, fontWeight: 500 }}>{item.doc}</span>
                    </div>
                    <div style={{ color: C.disabled, fontSize: 11, marginTop: 2 }}>{item.time}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── BOTTOM ROW ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(400px, 1fr))", gap: 20 }}>
          {/* Workflow Overview */}
          <div style={{ background: "var(--bg-elevated)", border: `1px solid var(--border-default)`, borderRadius: 20, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Workflow Overview</h3>
                <p style={{ color: C.secondary, fontSize: 12, marginTop: 4 }}>Document pipeline — current cycle</p>
              </div>
              <Badge label="Live" color={C.success} />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 24, overflowX: "auto" }}>
              {workflowNodes.map((node, i) => (
                <div key={node.label} style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 60 }}>
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                    <div
                      style={{
                        width: 48, height: 48, borderRadius: 14,
                        background: node.done ? `${node.color}22` : `${node.color}18`,
                        border: `${node.done ? 2 : 1}px solid ${node.color}${node.done ? "60" : "30"}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {node.done ? <Check size={20} color={node.color} /> : <Circle size={18} color={node.color} />}
                    </div>
                    <div style={{ color: C.heading, fontSize: 12, fontWeight: 600 }}>{node.label}</div>
                    <div style={{ color: node.color, fontSize: 12, fontWeight: 700 }}>{node.count}</div>
                  </div>
                  {i < workflowNodes.length - 1 && (
                    <div style={{ width: 24, height: 2, background: C.border, margin: "0 -12px" }} />
                  )}
                </div>
              ))}
            </div>

            <div>
              <div style={{ color: C.secondary, fontSize: 12, marginBottom: 8 }}>Documents processed — this week</div>
              <ResponsiveContainer width="100%" height={80}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.primary} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="day" tick={{ fill: C.disabled, fontSize: 10 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: C.secondBg, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, color: C.body }}
                    cursor={{ stroke: C.primary, strokeWidth: 1, strokeDasharray: "4 4" }}
                  />
                  <Area type="monotone" dataKey="docs" stroke={C.primary} strokeWidth={2} fill="url(#areaGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Statistics */}
          <div style={{ background: "var(--bg-elevated)", border: `1px solid var(--border-default)`, borderRadius: 20, padding: 24 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <h3 style={{ color: C.heading, fontWeight: 700, fontSize: 16, margin: 0 }}>Statistics</h3>
                <p style={{ color: C.secondary, fontSize: 12, marginTop: 4 }}>Workspace metrics — August 2026</p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {["Week", "Month", "Year"].map((t, i) => (
                  <button
                    key={t}
                    style={{
                      padding: "4px 10px", fontSize: 11, fontWeight: i === 1 ? 600 : 400,
                      background: i === 1 ? `${C.primary}20` : "transparent",
                      border: `1px solid ${i === 1 ? C.primary + "40" : C.border}`,
                      borderRadius: 8, color: i === 1 ? C.primary : C.secondary, cursor: "pointer",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {[
                { label: "Active Docs", value: stats?.documents_submitted.toString() || "0", change: "+0%", up: true, icon: FileText, color: C.primary },
                { label: "Pending", value: stats?.pending_approvals.toString() || "0", change: "+0", up: false, icon: Clock, color: C.warning },
                { label: "Teams", value: "12", change: "0 new", up: true, icon: Users, color: C.purple },
                { label: "Completed", value: `${stats ? Math.round((stats.documents_approved / Math.max(1, stats.documents_submitted)) * 100) : 0}%`, change: "+0%", up: true, icon: TrendingUp, color: C.success },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    background: "var(--bg-surface)",
                    border: `1px solid var(--border-default)`,
                    borderRadius: 16,
                    padding: "16px 18px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ width: 36, height: 36, background: `${s.color}18`, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <s.icon size={18} color={s.color} />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, color: s.up ? C.success : C.warning, fontSize: 11, fontWeight: 600 }}>
                      {s.up ? <TrendingUp size={12} /> : <AlertCircle size={12} />}
                      {s.change}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: C.heading, fontSize: 26, fontWeight: 700, lineHeight: 1 }}>{s.value}</div>
                    <div style={{ color: C.secondary, fontSize: 12, marginTop: 4 }}>{s.label}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 16, padding: "12px 16px", background: "var(--bg-surface)", border: `1px solid var(--border-default)`, borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <Activity size={16} color={C.primary} />
              <div style={{ flex: 1 }}>
                <div style={{ color: C.heading, fontSize: 13, fontWeight: 500 }}>System Health</div>
                <div style={{ color: C.secondary, fontSize: 11 }}>All services operational</div>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <div style={{ width: 8, height: 8, background: C.success, borderRadius: "50%", boxShadow: `0 0 6px ${C.success}` }} />
                <span style={{ color: C.success, fontSize: 11, fontWeight: 600 }}>Live</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <style>{`
        .bg-blob-blue { animation: blobDriftBlue 28s infinite ease-in-out; }
        .bg-blob-purple { animation: blobDriftPurple 34s 4s infinite ease-in-out; }

        @keyframes blobDriftBlue {
          0%   { transform: translate(0px,   0px)    scale(1);    }
          33%  { transform: translate(60px,  -40px)  scale(1.06); }
          66%  { transform: translate(-30px, -70px)  scale(0.97); }
          100% { transform: translate(0px,   0px)    scale(1);    }
        }
        @keyframes blobDriftPurple {
          0%   { transform: translate(0px,  0px)   scale(1);    }
          33%  { transform: translate(-50px, 35px) scale(1.05); }
          66%  { transform: translate(25px,  60px) scale(0.96); }
          100% { transform: translate(0px,  0px)   scale(1);    }
        }

        .quick-action-card:hover {
          transform: translateY(-4px) !important;
          box-shadow: 0 28px 72px rgba(0,0,0,0.55) !important;
        }
        .quick-action-card:hover .quick-action-icon {
          animation: iconPop 0.45s cubic-bezier(0.36,0.07,0.19,0.97) forwards;
          background: rgba(255,255,255,0.12) !important;
          filter: drop-shadow(0 0 10px currentColor);
        }
        @keyframes iconPop {
          0%   { transform: scale(1)    rotate(0deg);  }
          25%  { transform: scale(1.28) rotate(-10deg); }
          55%  { transform: scale(0.92) rotate(6deg);  }
          75%  { transform: scale(1.1)  rotate(-3deg); }
          100% { transform: scale(1)    rotate(0deg);  }
        }
      `}</style>
    </div>
  );
}
