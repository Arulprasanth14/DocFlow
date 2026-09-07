import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, Check, X, MoreHorizontal, FileText,
  TrendingUp, TrendingDown,
  Plus, Clock, Users, CheckCircle2, XCircle, Search, ChevronDown,
  ArrowUpDown, AlignJustify
} from "lucide-react";
import { toast, Toaster } from "sonner";
import { useNavigate } from "react-router-dom";
import { useMyApprovalQueue, useApprovals, useApproveStep, useRejectStep } from "@/hooks/useApprovals";
import type { WorkflowStepInstance } from "@/types";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "pending" | "approved" | "rejected";
type TabKey  = "pending" | "approved" | "rejected" | "all";

interface Approval {
  id: string;
  title: string;
  requester: string;
  initials: string;
  avatarBg: string;
  type: string;
  stage: string;
  stageSub: string;
  requestedAt: string;
  status: Status;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  bg:          "#0B0D12",
  surface:     "#12141C",
  hover:       "#161923",
  text:        "#F5F6F8",
  muted:       "#8B90A0",
  accent:      "#6366F1",
  accentHover: "#5457E5",
  accentTint:  "rgba(99,102,241,0.12)",
  accentSel:   "rgba(99,102,241,0.08)",
  green:       "#22C55E",
  greenTint:   "rgba(34,197,94,0.12)",
  red:         "#EF4444",
  redTint:     "rgba(239,68,68,0.12)",
  amber:       "#F59E0B",
  amberTint:   "rgba(245,158,11,0.12)",
  blue:        "#3B82F6",
  blueTint:    "rgba(59,130,246,0.12)",
  border:      "rgba(255,255,255,0.06)",
};

// ─── Mock data ────────────────────────────────────────────────────────────────

function mapStepToApproval(step: WorkflowStepInstance): Approval {
  const doc = step.workflow_instance?.document;
  const submitter = doc?.submitter_name || "Unknown";
  const initials = submitter.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase() || "U";
  const avatarBg = "#6366F1";
  const title = doc?.title || `Document for Step ${step.id}`;
  const type = doc?.doc_type_name || "Document";
  const stage = `Stage ${step.step_order}`;
  const stageSub = step.step_type;
  const requestedAt = new Date(step.workflow_instance?.started_at || Date.now()).toLocaleDateString();
  
  let status: Status = "pending";
  if (step.status === "completed") {
     if (step.decision === "approved") status = "approved";
     else if (step.decision === "rejected") status = "rejected";
  }

  return {
    id: step.id,
    title,
    requester: submitter,
    initials,
    avatarBg,
    type,
    stage,
    stageSub,
    requestedAt,
    status
  };
}

// ─── Small shared components ──────────────────────────────────────────────────

function Avatar({ initials, bg, size = 32 }: { initials: string; bg: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, background: bg,
      borderRadius: "50%", display: "flex", alignItems: "center",
      justifyContent: "center", flexShrink: 0,
      fontWeight: 600, color: "#fff", fontSize: size * 0.36,
    }}>
      {initials}
    </div>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const cfg = {
    pending:  { label: "Pending",  color: C.amber, bg: C.amberTint },
    approved: { label: "Approved", color: C.green, bg: C.greenTint },
    rejected: { label: "Rejected", color: C.red,   bg: C.redTint   },
  }[status];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "5px 10px", borderRadius: 999,
      fontSize: 12, fontWeight: 500,
      color: cfg.color, background: cfg.bg,
    }}>
      {cfg.label}
    </span>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string }[] = [
  { key: "pending",  label: "Pending"  },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all",      label: "All"      },
];

const PER_PAGE = 6;

// Grid template for table columns
const GRID_COLS = "40px minmax(240px,1fr) 120px 200px 110px 110px 90px";

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ApprovalsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabKey>("pending");
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [search, setSearch]       = useState("");
  const [page, setPage]           = useState(1);
  const [hovered, setHovered]     = useState<string | null>(null);
  const [exiting, setExiting]     = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ open: boolean; type: "approved"|"rejected"; id?: string; bulk?: boolean }>({ open: false, type: "approved" });
  const [note, setNote] = useState("");

  const myQueueQ = useMyApprovalQueue();
  const allApprovalsQ = useApprovals({ page: 1, limit: 100 });
  const approveM = useApproveStep();
  const rejectM = useRejectStep();

  const approvals = useMemo(() => {
    if (activeTab === "pending") {
      return (myQueueQ.data || []).map(mapStepToApproval);
    } else {
      return (allApprovalsQ.data?.items || []).map(mapStepToApproval);
    }
  }, [activeTab, myQueueQ.data, allApprovalsQ.data]);

  const counts = useMemo(() => {
    const pendCount = (myQueueQ.data || []).length;
    const allCount = (allApprovalsQ.data?.items || []).length;
    return {
      pending:  pendCount,
      approved: (allApprovalsQ.data?.items || []).filter(a => a.status === "completed" && a.decision === "approved").length,
      rejected: (allApprovalsQ.data?.items || []).filter(a => a.status === "completed" && a.decision === "rejected").length,
      all:      allCount,
    };
  }, [myQueueQ.data, allApprovalsQ.data]);

  const filtered = useMemo(() => {
    let list = activeTab === "all" ? approvals : approvals.filter(a => a.status === activeTab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.requester.toLowerCase().includes(q) ||
        a.type.toLowerCase().includes(q)
      );
    }
    return list;
  }, [approvals, activeTab, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  function switchTab(tab: TabKey) {
    setActiveTab(tab); setSelected(new Set()); setPage(1);
  }

  function toggleRow(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(prev => {
      const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
    });
  }

  function toggleAll() {
    setSelected(prev => prev.size === paged.length ? new Set() : new Set(paged.map(a => a.id)));
  }

  function act(id: string, next: Status) {
    setActionModal({ open: true, type: next as "approved" | "rejected", id, bulk: false });
    setNote("");
  }

  function bulkAct(next: Status) {
    if (selected.size === 0) return;
    setActionModal({ open: true, type: next as "approved" | "rejected", bulk: true });
    setNote("");
  }

  async function confirmAction() {
    const { type, id, bulk } = actionModal;
    const isApprove = type === "approved";
    const m = isApprove ? approveM : rejectM;
    
    if (!bulk && id) {
      await m.mutateAsync({ stepId: id, note: note || undefined });
      toast[isApprove ? "success" : "error"](`Document ${type}`);
    } else if (bulk) {
      for (const selId of selected) {
         try { await m.mutateAsync({ stepId: selId, note: note || undefined }); } catch {}
      }
      toast[isApprove ? "success" : "error"](`${selected.size} items ${type}`);
      setSelected(new Set());
    }
    setActionModal({ open: false, type: "approved" });
  }

  const allPageSelected = paged.length > 0 && selected.size >= paged.length;

  return (
    <div style={{
      background: C.bg,
      minHeight: "100%",
      fontFamily: "'Inter', sans-serif",
      color: C.text,
    }}>
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: C.surface, color: C.text,
            border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${C.accent}`,
            fontSize: 14,
          },
        }}
      />

      <div style={{ padding: "32px", maxWidth: "100%" }}>

        {/* ── Page header ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: C.text, margin: 0, lineHeight: 1.2 }}>
              Approvals
            </h1>
            <p style={{ fontSize: 14, color: C.muted, margin: "6px 0 0" }}>
              Review and act on requests waiting for you
            </p>
          </div>
          <button
            onClick={() => navigate('/documents/new')}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 18px", borderRadius: 10,
              background: C.accent, color: "#fff",
              border: "none", cursor: "pointer",
              fontSize: 14, fontWeight: 600,
              fontFamily: "'Inter', sans-serif",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = C.accentHover)}
            onMouseLeave={e => (e.currentTarget.style.background = C.accent)}
          >
            <Plus size={16} />
            New Approval Request
          </button>
        </div>

        {/* ── Stat cards ── */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 16,
          marginBottom: 24,
        }}>
          {[
            { icon: Clock,        label: "Awaiting You",        value: counts.pending,       color: C.amber, tint: C.amberTint, trend: "+2 today", up: false, goodWhenDown: true  },
            { icon: Users,        label: "Awaiting Others",     value: 14,                   color: C.blue,  tint: C.blueTint,  trend: "+5 today", up: true,  goodWhenDown: false },
            { icon: CheckCircle2, label: "Approved This Month", value: counts.approved + 44, color: C.green, tint: C.greenTint, trend: "+12%",     up: true,  goodWhenDown: false },
            { icon: XCircle,      label: "Rejected This Month", value: counts.rejected + 4,  color: C.red,   tint: C.redTint,   trend: "−3%",      up: false, goodWhenDown: true  },
          ].map(({ icon: Icon, label, value, color, tint, trend, up, goodWhenDown }) => {
            const isPositive = goodWhenDown ? !up : up;
            return (
              <div key={label} style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderRadius: 16, padding: 24,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8,
                    background: tint,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Icon size={18} style={{ color }} />
                  </div>
                  <span style={{
                    fontSize: 12, fontWeight: 500,
                    display: "flex", alignItems: "center", gap: 3,
                    color: isPositive ? C.green : C.red,
                  }}>
                    {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                    {trend}
                  </span>
                </div>
                <p style={{ fontSize: 26, fontWeight: 700, color: C.text, margin: 0, lineHeight: 1 }}>{value}</p>
                <p style={{ fontSize: 12, color: C.muted, margin: "6px 0 0" }}>{label}</p>
              </div>
            );
          })}
        </div>

        {/* ── Main card ── */}
        <div style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 16, overflow: "hidden",
        }}>

          {/* ── Tabs ── */}
          <div style={{
            display: "flex", alignItems: "flex-end",
            padding: "0 24px",
            borderBottom: `1px solid ${C.border}`,
          }}>
            {TABS.map(({ key, label }) => {
              const active = activeTab === key;
              return (
                <button
                  key={key}
                  onClick={() => switchTab(key)}
                  style={{
                    position: "relative",
                    padding: "16px 20px 14px",
                    fontSize: 14, fontWeight: 500,
                    color: active ? C.text : C.muted,
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "'Inter', sans-serif",
                    display: "flex", alignItems: "center", gap: 6,
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                  <span style={{ fontSize: 12, color: C.muted }}>{counts[key]}</span>
                  {active && (
                    <span style={{
                      position: "absolute", bottom: 0, left: 0, right: 0,
                      height: 2, borderRadius: "2px 2px 0 0",
                      background: C.accent,
                    }} />
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Toolbar ── */}
          <div style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
            padding: "14px 24px",
            borderBottom: `1px solid ${C.border}`,
          }}>
            {/* Search */}
            <div style={{ position: "relative", width: 300, flexShrink: 0 }}>
              <Search
                size={14}
                style={{
                  position: "absolute", left: 12, top: "50%",
                  transform: "translateY(-50%)", color: C.muted, pointerEvents: "none",
                }}
              />
              <input
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder="Search approvals..."
                style={{
                  width: "100%", boxSizing: "border-box",
                  padding: "8px 14px 8px 36px",
                  background: C.hover, border: `1px solid ${C.border}`,
                  borderRadius: 10, color: C.text,
                  fontSize: 14, fontFamily: "'Inter', sans-serif",
                  outline: "none",
                }}
              />
            </div>

            {/* Filter chips */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {["Requester", "Type", "Department", "Date"].map(f => (
                <button
                  key={f}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "7px 12px",
                    border: `1px solid ${C.border}`,
                    borderRadius: 10, color: C.muted,
                    background: "transparent", cursor: "pointer",
                    fontSize: 12, fontWeight: 500,
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  {f}
                  <ChevronDown size={11} />
                </button>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              <button style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 12px",
                border: `1px solid ${C.border}`,
                borderRadius: 10, color: C.muted,
                background: "transparent", cursor: "pointer",
                fontSize: 12, fontWeight: 500,
                fontFamily: "'Inter', sans-serif",
              }}>
                <ArrowUpDown size={13} />
                Newest first
              </button>
              <button style={{
                width: 34, height: 34, borderRadius: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: `1px solid ${C.border}`, color: C.muted,
                background: "transparent", cursor: "pointer",
              }}>
                <AlignJustify size={15} />
              </button>
            </div>
          </div>

          {/* ── Bulk action bar ── */}
          <AnimatePresence>
            {selected.size > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                style={{
                  display: "flex", alignItems: "center", gap: 12,
                  padding: "12px 24px",
                  background: C.hover,
                  borderLeft: `4px solid ${C.accent}`,
                  borderBottom: `1px solid ${C.border}`,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>
                  {selected.size} selected
                </span>
                <button
                  onClick={() => setSelected(new Set())}
                  style={{
                    fontSize: 12, color: C.muted,
                    background: "none", border: "none",
                    cursor: "pointer", textDecoration: "underline",
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  Clear
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                  <button
                    onClick={() => bulkAct("approved")}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 16px", borderRadius: 10,
                      background: C.green, color: "#fff", border: "none",
                      cursor: "pointer", fontSize: 14, fontWeight: 600,
                      fontFamily: "'Inter', sans-serif",
                    }}
                  >
                    <Check size={14} />
                    Approve Selected
                  </button>
                  <button
                    onClick={() => bulkAct("rejected")}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 16px", borderRadius: 10,
                      background: C.redTint, color: C.red,
                      border: `1px solid ${C.red}`,
                      cursor: "pointer", fontSize: 14, fontWeight: 600,
                      fontFamily: "'Inter', sans-serif",
                    }}
                  >
                    <X size={14} />
                    Reject Selected
                  </button>
                  <button style={{
                    width: 34, height: 34, borderRadius: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1px solid ${C.border}`, color: C.muted,
                    background: "transparent", cursor: "pointer",
                  }}>
                    <MoreHorizontal size={16} />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Table ── */}
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 960 }}>

              {/* Table header */}
              <div style={{
                display: "grid",
                gridTemplateColumns: GRID_COLS,
                alignItems: "center",
                padding: "12px 24px",
                fontSize: 11, fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: C.muted,
                borderBottom: `1px solid ${C.border}`,
              }}>
                <div>
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleAll}
                    style={{ accentColor: C.accent, width: 15, height: 15, cursor: "pointer" }}
                  />
                </div>
                <div>Document</div>
                <div>Type</div>
                <div>Stage</div>
                <div>Requested</div>
                <div>Status</div>
                <div>Actions</div>
              </div>

              {/* Rows */}
              <div>
                {paged.length === 0 ? (
                  <div style={{
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center",
                    padding: "80px 24px", gap: 12,
                  }}>
                    <div style={{
                      width: 56, height: 56, borderRadius: 16,
                      background: C.hover,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <CheckCircle2 size={28} style={{ color: C.muted, opacity: 0.5 }} />
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <p style={{ fontWeight: 600, fontSize: 14, color: C.text, margin: 0 }}>
                        {activeTab === "pending" ? "You're all caught up 🎉" : `No ${activeTab} approvals`}
                      </p>
                      <p style={{ fontSize: 14, color: C.muted, margin: "4px 0 0" }}>
                        {activeTab === "pending"
                          ? "Nothing needs your attention right now."
                          : `No documents have been ${activeTab} yet.`}
                      </p>
                    </div>
                  </div>
                ) : (
                  paged.map((item, idx) => {
                    const isSelected = selected.has(item.id);
                    const isHovered  = hovered === item.id;
                    const isExiting  = exiting.has(item.id);

                    const stageBg =
                      item.status === "rejected" ? C.redTint
                      : item.status === "approved" ? C.greenTint
                      : "rgba(255,255,255,0.06)";
                    const stageColor =
                      item.status === "rejected" ? C.red
                      : item.status === "approved" ? C.green
                      : C.muted;

                    return (
                      <motion.div
                        key={item.id}
                        animate={{ opacity: isExiting ? 0 : 1, x: isExiting ? 20 : 0 }}
                        transition={{ duration: 0.25 }}
                        style={{
                          display: "grid",
                          gridTemplateColumns: GRID_COLS,
                          alignItems: "center",
                          padding: "0 24px",
                          minHeight: 72,
                          background: isSelected ? C.accentSel : isHovered ? C.hover : "transparent",
                          borderLeft: isSelected ? `3px solid ${C.accent}` : "3px solid transparent",
                          borderBottom: idx < paged.length - 1 ? `1px solid ${C.border}` : "none",
                          transition: "background 0.15s, border-color 0.15s",
                          cursor: "pointer",
                        }}
                        onMouseEnter={() => setHovered(item.id)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={() => toast("Opening document detail…", { description: item.title })}
                      >
                        {/* Checkbox */}
                        <div onClick={e => toggleRow(item.id, e)}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            style={{ accentColor: C.accent, width: 15, height: 15, cursor: "pointer" }}
                          />
                        </div>

                        {/* Document */}
                        <div style={{
                          display: "flex", alignItems: "center", gap: 12,
                          padding: "16px 16px 16px 0", minWidth: 0,
                        }}>
                          <div style={{
                            width: 40, height: 40, borderRadius: 8, flexShrink: 0,
                            background: C.accentTint,
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            <FileText size={17} style={{ color: C.accent }} />
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                            <p style={{
                              fontSize: 14, fontWeight: 600, color: C.text,
                              margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>
                              {item.title}
                            </p>
                            <p style={{
                              fontSize: 12, color: C.muted, margin: "3px 0 0",
                              display: "flex", alignItems: "center", gap: 6,
                            }}>
                              <Avatar initials={item.initials} bg={item.avatarBg} size={15} />
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {item.requester} · {item.requestedAt}
                              </span>
                            </p>
                          </div>
                        </div>

                        {/* Type */}
                        <div style={{ fontSize: 14, color: C.muted }}>{item.type}</div>

                        {/* Stage */}
                        <div>
                          <span style={{
                            display: "inline-flex", alignItems: "center",
                            padding: "5px 10px", borderRadius: 999,
                            fontSize: 11, fontWeight: 500, whiteSpace: "nowrap",
                            background: stageBg, color: stageColor,
                          }}>
                            {item.stage} · {item.stageSub}
                          </span>
                        </div>

                        {/* Requested */}
                        <div style={{ fontSize: 13, color: C.muted }}>{item.requestedAt}</div>

                        {/* Status */}
                        <div><StatusBadge status={item.status} /></div>

                        {/* Actions */}
                        <div style={{
                          display: "flex", alignItems: "center", gap: 6,
                          opacity: item.status === "pending" ? (isHovered ? 1 : 0.55) : 0,
                          transition: "opacity 0.15s",
                        }}>
                          {item.status === "pending" && (
                            <>
                              <button
                                onClick={e => { e.stopPropagation(); act(item.id, "approved"); }}
                                title="Approve"
                                style={{
                                  width: 32, height: 32, borderRadius: "50%",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  background: C.greenTint, color: C.green,
                                  border: "none", cursor: "pointer",
                                  transition: "transform 0.15s",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.1)")}
                                onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
                              >
                                <Check size={14} />
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); act(item.id, "rejected"); }}
                                title="Reject"
                                style={{
                                  width: 32, height: 32, borderRadius: "50%",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  background: C.redTint, color: C.red,
                                  border: "none", cursor: "pointer",
                                  transition: "transform 0.15s",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.1)")}
                                onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
                              >
                                <X size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>

            </div>
          </div>

          {/* ── Pagination ── */}
          {filtered.length > PER_PAGE && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "16px 24px",
              borderTop: `1px solid ${C.border}`,
            }}>
              <span style={{ fontSize: 14, color: C.muted }}>
                Showing {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} of {filtered.length}
              </span>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  style={{
                    width: 36, height: 36, borderRadius: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1px solid ${C.border}`, color: C.muted,
                    background: "transparent", cursor: safePage === 1 ? "not-allowed" : "pointer",
                    opacity: safePage === 1 ? 0.3 : 1,
                  }}
                >
                  <ChevronLeft size={15} />
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map(n => (
                  <button
                    key={n}
                    onClick={() => setPage(n)}
                    style={{
                      width: 36, height: 36, borderRadius: 10,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 14, fontWeight: 500,
                      background: safePage === n ? C.accent : "transparent",
                      color:      safePage === n ? "#fff"   : C.muted,
                      border:     safePage === n ? "none"   : `1px solid ${C.border}`,
                      cursor: "pointer",
                      fontFamily: "'Inter', sans-serif",
                    }}
                  >
                    {n}
                  </button>
                ))}

                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  style={{
                    width: 36, height: 36, borderRadius: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    border: `1px solid ${C.border}`, color: C.muted,
                    background: "transparent",
                    cursor: safePage === totalPages ? "not-allowed" : "pointer",
                    opacity: safePage === totalPages ? 0.3 : 1,
                  }}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}

        </div>

        {/* bottom breathing room */}
        <div style={{ height: 32 }} />
      </div>

      <ConfirmDialog
        open={actionModal.open}
        title={actionModal.type === "approved" ? "Approve Request" : "Reject Request"}
        message={actionModal.bulk ? `Are you sure you want to ${actionModal.type} ${selected.size} requests?` : `Are you sure you want to ${actionModal.type} this request?`}
        confirmLabel={actionModal.type === "approved" ? "Approve" : "Reject"}
        onConfirm={confirmAction}
        onCancel={() => setActionModal({ open: false, type: "approved" })}
      />
    </div>
  );
}
