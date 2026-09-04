import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Search, Bell, ChevronDown, Plus, Clock, Users, CheckCircle2, XCircle,
  LayoutDashboard, CheckSquare, FileStack, GitBranch, BarChart2, Settings,
  ChevronLeft, ChevronRight, Check, X, MoreHorizontal, FileText,
  TrendingUp, TrendingDown, AlignJustify, ArrowUpDown,
} from "lucide-react";
import { toast, Toaster } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "pending" | "approved" | "rejected";
type TabKey = "pending" | "approved" | "rejected" | "all";

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

const SEED: Approval[] = [
  { id: "1",  title: "Q4 Financial Report 2024",              requester: "Sarah Chen",      initials: "SC", avatarBg: "#6366F1", type: "Finance",     stage: "Stage 2 of 3", stageSub: "Review",            requestedAt: "2h ago",  status: "pending"  },
  { id: "2",  title: "Legal Services Agreement — Renewal",    requester: "Marcus Webb",     initials: "MW", avatarBg: "#F59E0B", type: "Legal",        stage: "Stage 1 of 2", stageSub: "Initial Review",    requestedAt: "4h ago",  status: "pending"  },
  { id: "3",  title: "Product Roadmap H1 2025",               requester: "Priya Nair",      initials: "PN", avatarBg: "#22C55E", type: "Product",      stage: "Stage 3 of 3", stageSub: "Final Approval",    requestedAt: "6h ago",  status: "pending"  },
  { id: "4",  title: "Vendor Contract — Accenture",           requester: "Tom Bradley",     initials: "TB", avatarBg: "#3B82F6", type: "Procurement",  stage: "Stage 1 of 3", stageSub: "Review",            requestedAt: "1d ago",  status: "pending"  },
  { id: "5",  title: "HR Policy Update 2024",                 requester: "Aisha Patel",     initials: "AP", avatarBg: "#EC4899", type: "HR",           stage: "Stage 2 of 2", stageSub: "Final Sign-off",    requestedAt: "2d ago",  status: "pending"  },
  { id: "6",  title: "Annual Budget Allocation FY2025",       requester: "James Liu",       initials: "JL", avatarBg: "#8B5CF6", type: "Finance",      stage: "Stage 1 of 4", stageSub: "Department Review", requestedAt: "3d ago",  status: "pending"  },
  { id: "7",  title: "Software License Agreement — Adobe",    requester: "Elena Costa",     initials: "EC", avatarBg: "#F97316", type: "IT",           stage: "Stage 2 of 2", stageSub: "Sign-off",          requestedAt: "5d ago",  status: "pending"  },
  { id: "8",  title: "Marketing Campaign Brief Q1",           requester: "Noah Williams",   initials: "NW", avatarBg: "#14B8A6", type: "Marketing",    stage: "Stage 1 of 2", stageSub: "Creative Review",   requestedAt: "1w ago",  status: "pending"  },
  { id: "9",  title: "Board Resolution — Dividend Declaration", requester: "Sophia Martinez", initials: "SM", avatarBg: "#6366F1", type: "Finance",   stage: "Stage 3 of 3", stageSub: "Executive Sign-off", requestedAt: "2w ago",  status: "approved" },
  { id: "10", title: "Partnership Agreement — TechVentures",  requester: "Daniel Kim",      initials: "DK", avatarBg: "#22C55E", type: "Legal",        stage: "Stage 2 of 2", stageSub: "Final Approval",    requestedAt: "3w ago",  status: "approved" },
  { id: "11", title: "Data Privacy Compliance Report",        requester: "Chloe Osei",      initials: "CO", avatarBg: "#A78BFA", type: "Legal",        stage: "Stage 2 of 3", stageSub: "Compliance Check",  requestedAt: "1mo ago", status: "approved" },
  { id: "12", title: "Office Lease Renewal — HQ",             requester: "Rachel Thomas",   initials: "RT", avatarBg: "#F59E0B", type: "Facilities",   stage: "Stage 1 of 3", stageSub: "Initial Review",    requestedAt: "1mo ago", status: "rejected" },
  { id: "13", title: "Cloud Infrastructure Budget Increase",  requester: "Kevin Okafor",    initials: "KO", avatarBg: "#3B82F6", type: "IT",           stage: "Stage 2 of 3", stageSub: "Finance Review",    requestedAt: "2mo ago", status: "rejected" },
];

// ─── Small shared components ──────────────────────────────────────────────────

function Avatar({ initials, bg, size = 32 }: { initials: string; bg: string; size?: number }) {
  return (
    <div
      className="rounded-full flex items-center justify-center flex-shrink-0 font-semibold text-white"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.36 }}
    >
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
    <span
      className="inline-flex items-center px-2.5 py-[5px] rounded-full text-xs font-medium"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      {cfg.label}
    </span>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

const NAV = [
  { icon: LayoutDashboard, label: "Dashboard",  active: false },
  { icon: CheckSquare,     label: "Approvals",  active: true  },
  { icon: FileStack,       label: "Documents",  active: false },
  { icon: GitBranch,       label: "Workflows",  active: false },
  { icon: BarChart2,       label: "Reports",    active: false },
  { icon: Settings,        label: "Settings",   active: false },
];

function Sidebar() {
  return (
    <aside
      className="flex flex-col h-full flex-shrink-0 w-[240px]"
      style={{ background: C.surface, borderRight: `1px solid ${C.border}` }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 py-[18px]" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: C.accent }}>
          <FileStack size={15} color="#fff" />
        </div>
        <span className="font-bold text-[15px] tracking-tight" style={{ color: C.text }}>DocFlow</span>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4">
        <p className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-[0.05em]" style={{ color: C.muted }}>
          Main Menu
        </p>
        {NAV.map(({ icon: Icon, label, active }) => (
          <button
            key={label}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium mb-0.5 transition-colors"
            style={{
              background: active ? C.accentTint : "transparent",
              color:      active ? C.accent    : C.muted,
            }}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>

      {/* User profile */}
      <div className="px-3 pb-4 pt-2" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-colors" style={{ color: C.text }}>
          <Avatar initials="AJ" bg={C.accent} size={34} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate" style={{ color: C.text }}>Alex Johnson</p>
            <p className="text-[12px] truncate" style={{ color: C.muted }}>Senior Manager</p>
          </div>
          <ChevronDown size={14} style={{ color: C.muted }} />
        </div>
      </div>
    </aside>
  );
}

// ─── Top bar ──────────────────────────────────────────────────────────────────

function TopBar() {
  return (
    <header
      className="flex items-center gap-4 px-8 h-16 flex-shrink-0"
      style={{ background: C.surface, borderBottom: `1px solid ${C.border}` }}
    >
      {/* Search */}
      <div className="relative" style={{ width: 280 }}>
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
        <input
          placeholder="Search..."
          className="w-full pl-9 pr-14 py-2 rounded-[10px] text-sm outline-none"
          style={{ background: C.hover, border: `1px solid ${C.border}`, color: C.text }}
        />
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] px-1.5 py-0.5 rounded"
          style={{ color: C.muted, background: C.bg, border: `1px solid ${C.border}` }}
        >
          ⌘K
        </span>
      </div>

      <div className="flex items-center gap-2.5 ml-auto">
        {/* Bell */}
        <button
          className="relative w-9 h-9 rounded-[10px] flex items-center justify-center"
          style={{ background: C.hover }}
        >
          <Bell size={17} style={{ color: C.muted }} />
          <span className="absolute top-[9px] right-[9px] w-1.5 h-1.5 rounded-full" style={{ background: C.accent }} />
        </button>

        {/* User chip */}
        <button
          className="flex items-center gap-2 px-3 py-1.5 rounded-[10px]"
          style={{ background: C.hover }}
        >
          <Avatar initials="AJ" bg={C.accent} size={26} />
          <span className="text-sm font-medium" style={{ color: C.text }}>Alex Johnson</span>
          <ChevronDown size={13} style={{ color: C.muted }} />
        </button>
      </div>
    </header>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string }[] = [
  { key: "pending",  label: "Pending"  },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all",      label: "All"      },
];

const PER_PAGE = 6;

export default function App() {
  const [approvals, setApprovals]       = useState<Approval[]>(SEED);
  const [activeTab, setActiveTab]       = useState<TabKey>("pending");
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [search, setSearch]             = useState("");
  const [page, setPage]                 = useState(1);
  const [hovered, setHovered]           = useState<string | null>(null);
  const [exiting, setExiting]           = useState<Set<string>>(new Set());

  // Counts per tab
  const counts = useMemo(() => ({
    pending:  approvals.filter(a => a.status === "pending").length,
    approved: approvals.filter(a => a.status === "approved").length,
    rejected: approvals.filter(a => a.status === "rejected").length,
    all:      approvals.length,
  }), [approvals]);

  // Filtered list for current tab + search
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

  // Tab switch
  function switchTab(tab: TabKey) {
    setActiveTab(tab);
    setSelected(new Set());
    setPage(1);
  }

  // Row selection
  function toggleRow(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev =>
      prev.size === paged.length ? new Set() : new Set(paged.map(a => a.id))
    );
  }

  // Single approve / reject with exit animation
  function act(id: string, nextStatus: Status) {
    setExiting(prev => new Set(prev).add(id));
    setTimeout(() => {
      setApprovals(prev => prev.map(a => a.id === id ? { ...a, status: nextStatus } : a));
      setExiting(prev => { const n = new Set(prev); n.delete(id); return n; });
      setSelected(prev => { const n = new Set(prev); n.delete(id); return n; });
      toast[nextStatus === "approved" ? "success" : "error"](
        nextStatus === "approved" ? "Document approved" : "Document rejected"
      );
    }, 260);
  }

  // Bulk actions
  function bulkAct(nextStatus: Status) {
    const count = selected.size;
    setApprovals(prev => prev.map(a => selected.has(a.id) ? { ...a, status: nextStatus } : a));
    setSelected(new Set());
    toast[nextStatus === "approved" ? "success" : "error"](
      `${count} item${count !== 1 ? "s" : ""} ${nextStatus}`
    );
  }

  const allPageSelected = paged.length > 0 && selected.size >= paged.length;

  return (
    <div
      className="flex h-screen overflow-hidden"
      style={{ fontFamily: "'Inter', sans-serif", background: C.bg, color: C.text }}
    >
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: C.surface,
            color: C.text,
            border: `1px solid ${C.border}`,
            borderLeft: `4px solid ${C.accent}`,
            fontSize: 14,
          },
        }}
      />

      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar />

        <main className="flex-1 overflow-y-auto" style={{ padding: "32px" }}>

          {/* ── Page header ── */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="font-bold leading-tight" style={{ fontSize: 28, color: C.text }}>
                Approvals
              </h1>
              <p className="mt-1 text-sm" style={{ color: C.muted }}>
                Review and act on requests waiting for you
              </p>
            </div>
            <button
              className="flex items-center gap-2 px-4 py-2.5 rounded-[10px] text-sm font-semibold transition-colors"
              style={{ background: C.accent, color: "#fff" }}
              onMouseEnter={e => (e.currentTarget.style.background = C.accentHover)}
              onMouseLeave={e => (e.currentTarget.style.background = C.accent)}
            >
              <Plus size={16} />
              New Approval Request
            </button>
          </div>

          {/* ── Stat strip ── */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            {[
              { icon: Clock,        label: "Awaiting You",        value: counts.pending,       color: C.amber, tint: C.amberTint, trend: "+2 today", up: false, goodWhenDown: true  },
              { icon: Users,        label: "Awaiting Others",     value: 14,                   color: C.blue,  tint: C.blueTint,  trend: "+5 today", up: true,  goodWhenDown: false },
              { icon: CheckCircle2, label: "Approved This Month", value: counts.approved + 44, color: C.green, tint: C.greenTint, trend: "+12%",     up: true,  goodWhenDown: false },
              { icon: XCircle,      label: "Rejected This Month", value: counts.rejected + 4,  color: C.red,   tint: C.redTint,   trend: "−3%",      up: false, goodWhenDown: true  },
            ].map(({ icon: Icon, label, value, color, tint, trend, up, goodWhenDown }) => {
              // A metric marked goodWhenDown treats decreases as positive (green) and increases as negative (red)
              const isPositive = goodWhenDown ? !up : up;
              return (
                <div
                  key={label}
                  className="rounded-2xl p-6"
                  style={{ background: C.surface, border: `1px solid ${C.border}` }}
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: tint }}>
                      <Icon size={18} style={{ color }} />
                    </div>
                    <span className="text-xs font-medium flex items-center gap-0.5" style={{ color: isPositive ? C.green : C.red }}>
                      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                      {trend}
                    </span>
                  </div>
                  <p className="font-bold" style={{ fontSize: 26, color: C.text, lineHeight: 1 }}>{value}</p>
                  <p className="text-[12px] mt-1.5" style={{ color: C.muted }}>{label}</p>
                </div>
              );
            })}
          </div>

          {/* ── Main card ── */}
          <div className="rounded-2xl overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.border}` }}>

            {/* Status tabs */}
            <div className="flex items-end px-6" style={{ borderBottom: `1px solid ${C.border}` }}>
              {TABS.map(({ key, label }) => {
                const active = activeTab === key;
                return (
                  <button
                    key={key}
                    onClick={() => switchTab(key)}
                    className="relative px-5 pt-4 pb-3.5 text-sm font-medium transition-colors"
                    style={{ color: active ? C.text : C.muted }}
                  >
                    {label}
                    <span className="ml-1.5 text-xs" style={{ color: C.muted }}>{counts[key]}</span>
                    {active && (
                      <span
                        className="absolute bottom-0 left-0 right-0 h-[2px] rounded-t"
                        style={{ background: C.accent }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Toolbar */}
            <div
              className="flex flex-wrap items-center gap-3 px-6 py-3.5"
              style={{ borderBottom: `1px solid ${C.border}` }}
            >
              {/* Search */}
              <div className="relative flex-shrink-0" style={{ width: 300 }}>
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: C.muted }} />
                <input
                  value={search}
                  onChange={e => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search approvals..."
                  className="w-full pl-9 pr-4 py-2 rounded-[10px] text-sm outline-none transition-colors"
                  style={{ background: C.hover, border: `1px solid ${C.border}`, color: C.text }}
                />
              </div>

              {/* Filter chips */}
              <div className="flex flex-wrap items-center gap-2">
                {["Requester", "Type", "Department", "Date"].map(f => (
                  <button
                    key={f}
                    className="flex items-center gap-1.5 px-3 py-[7px] rounded-[10px] text-xs font-medium transition-colors"
                    style={{ border: `1px solid ${C.border}`, color: C.muted, background: "transparent" }}
                  >
                    {f}
                    <ChevronDown size={11} />
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 ml-auto">
                <button
                  className="flex items-center gap-1.5 px-3 py-[7px] rounded-[10px] text-xs font-medium"
                  style={{ border: `1px solid ${C.border}`, color: C.muted, background: "transparent" }}
                >
                  <ArrowUpDown size={13} />
                  Newest first
                </button>
                <button
                  className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center"
                  style={{ border: `1px solid ${C.border}`, color: C.muted }}
                >
                  <AlignJustify size={15} />
                </button>
              </div>
            </div>

            {/* Bulk action bar */}
            <AnimatePresence>
              {selected.size > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                  className="flex items-center gap-3 px-6 py-3"
                  style={{
                    background: C.hover,
                    borderLeft: `4px solid ${C.accent}`,
                    borderBottom: `1px solid ${C.border}`,
                  }}
                >
                  <span className="text-sm font-medium" style={{ color: C.text }}>
                    {selected.size} selected
                  </span>
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-xs underline"
                    style={{ color: C.muted }}
                  >
                    Clear
                  </button>
                  <div className="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => bulkAct("approved")}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] text-sm font-semibold"
                      style={{ background: C.green, color: "#fff" }}
                    >
                      <Check size={14} />
                      Approve Selected
                    </button>
                    <button
                      onClick={() => bulkAct("rejected")}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-[10px] text-sm font-semibold"
                      style={{ background: C.redTint, color: C.red, border: `1px solid ${C.red}` }}
                    >
                      <X size={14} />
                      Reject Selected
                    </button>
                    <button
                      className="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center"
                      style={{ border: `1px solid ${C.border}`, color: C.muted }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Table — horizontally scrollable so columns never clip */}
            <div className="overflow-x-auto">
              <div style={{ minWidth: 960 }}>

                {/* Table header */}
                <div
                  className="grid items-center px-6 py-3 text-[11px] font-semibold uppercase tracking-[0.05em]"
                  style={{
                    gridTemplateColumns: "40px minmax(240px,1fr) 120px 180px 110px 110px 90px",
                    color: C.muted,
                    borderBottom: `1px solid ${C.border}`,
                  }}
                >
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
                    <div className="flex flex-col items-center justify-center py-20 gap-3">
                      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: C.hover }}>
                        <CheckCircle2 size={28} style={{ color: C.muted, opacity: 0.5 }} />
                      </div>
                      <div className="text-center">
                        <p className="font-semibold text-sm" style={{ color: C.text }}>
                          {activeTab === "pending" ? "You're all caught up 🎉" : `No ${activeTab} approvals`}
                        </p>
                        <p className="text-sm mt-1" style={{ color: C.muted }}>
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

                      return (
                        <motion.div
                          key={item.id}
                          animate={{ opacity: isExiting ? 0 : 1, x: isExiting ? 20 : 0 }}
                          transition={{ duration: 0.25 }}
                          className="grid items-center px-6 cursor-pointer"
                          style={{
                            gridTemplateColumns: "40px minmax(240px,1fr) 120px 180px 110px 110px 90px",
                            minHeight: 72,
                            background: isSelected ? C.accentSel : isHovered ? C.hover : "transparent",
                            borderLeft: isSelected ? `3px solid ${C.accent}` : "3px solid transparent",
                            borderBottom: idx < paged.length - 1 ? `1px solid ${C.border}` : "none",
                            transition: "background 0.15s, border-color 0.15s",
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

                          {/* Document — icon + title/requester stacked, Type lives in its own column */}
                          <div className="flex items-center gap-3 py-4 min-w-0 pr-4">
                            <div
                              className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                              style={{ background: C.accentTint }}
                            >
                              <FileText size={17} style={{ color: C.accent }} />
                            </div>
                            <div className="flex flex-col min-w-0">
                              <p className="text-sm font-semibold truncate" style={{ color: C.text }}>
                                {item.title}
                              </p>
                              <p className="text-[12px] mt-0.5 flex items-center gap-1.5" style={{ color: C.muted }}>
                                <Avatar initials={item.initials} bg={item.avatarBg} size={15} />
                                <span className="truncate">{item.requester} · {item.requestedAt}</span>
                              </p>
                            </div>
                          </div>

                          {/* Type — separate column */}
                          <div className="text-sm" style={{ color: C.muted }}>{item.type}</div>

                          {/* Stage */}
                          <div>
                            <span
                              className="inline-flex items-center px-2.5 py-[5px] rounded-full text-[11px] font-medium whitespace-nowrap"
                              style={{
                                background:
                                  item.status === "rejected" ? C.redTint
                                  : item.status === "approved" ? C.greenTint
                                  : "rgba(255,255,255,0.06)",
                                color:
                                  item.status === "rejected" ? C.red
                                  : item.status === "approved" ? C.green
                                  : C.muted,
                              }}
                            >
                              {item.stage} · {item.stageSub}
                            </span>
                          </div>

                          {/* Requested */}
                          <div className="text-[13px]" style={{ color: C.muted }}>{item.requestedAt}</div>

                          {/* Status */}
                          <div><StatusBadge status={item.status} /></div>

                          {/* Quick actions — only for pending rows */}
                          <div
                            className="flex items-center gap-1.5"
                            style={{ opacity: item.status === "pending" ? (isHovered ? 1 : 0.55) : 0, transition: "opacity 0.15s" }}
                          >
                            {item.status === "pending" && (
                              <>
                                <button
                                  onClick={e => { e.stopPropagation(); act(item.id, "approved"); }}
                                  className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
                                  style={{ background: C.greenTint, color: C.green }}
                                  title="Approve"
                                >
                                  <Check size={14} />
                                </button>
                                <button
                                  onClick={e => { e.stopPropagation(); act(item.id, "rejected"); }}
                                  className="w-8 h-8 rounded-full flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
                                  style={{ background: C.redTint, color: C.red }}
                                  title="Reject"
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

            {/* Pagination */}
            {filtered.length > PER_PAGE && (
              <div
                className="flex items-center justify-between px-6 py-4"
                style={{ borderTop: `1px solid ${C.border}` }}
              >
                <span className="text-sm" style={{ color: C.muted }}>
                  Showing {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} of {filtered.length}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={safePage === 1}
                    className="w-9 h-9 rounded-[10px] flex items-center justify-center transition-colors disabled:opacity-30"
                    style={{ border: `1px solid ${C.border}`, color: C.muted }}
                  >
                    <ChevronLeft size={15} />
                  </button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(n => (
                    <button
                      key={n}
                      onClick={() => setPage(n)}
                      className="w-9 h-9 rounded-[10px] flex items-center justify-center text-sm font-medium transition-colors"
                      style={{
                        background: safePage === n ? C.accent : "transparent",
                        color:      safePage === n ? "#fff"   : C.muted,
                        border:     safePage === n ? "none"   : `1px solid ${C.border}`,
                      }}
                    >
                      {n}
                    </button>
                  ))}

                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage === totalPages}
                    className="w-9 h-9 rounded-[10px] flex items-center justify-center transition-colors disabled:opacity-30"
                    style={{ border: `1px solid ${C.border}`, color: C.muted }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* bottom breathing room */}
          <div className="h-8" />
        </main>
      </div>
    </div>
  );
}
