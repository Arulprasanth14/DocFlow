import { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, Check, X, MoreHorizontal, FileText,
  Plus, Search,
  ArrowUpDown, UserPlus, History
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  useMyApprovalQueue, useApproveStep, useRejectStep,
  useDelegateStep, useMessageableMembers,
} from "@/hooks/useApprovals";
import type { ApprovalStep } from "@/lib/api/approvals";
import { ApiClientError } from "@/lib/api/client";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import ApprovalHistoryPanel from "@/components/approvals/ApprovalHistoryPanel";
import { useWorkflowTemplates } from "@/hooks/useWorkflows";
import { useDepartments } from "@/hooks/useOrg";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconChip } from "@/components/ui/IconChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge as StatusPill } from "@/components/ui/StatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = "pending" | "approved" | "rejected";
type TabKey  = "pending" | "approved" | "rejected" | "all";

type Urgency = "overdue" | "due_soon" | "normal" | "none";

type SortKey =
  | "due_at" | "-due_at"
  | "submitted_at" | "-submitted_at"
  | "title" | "-title";

interface Approval {
  id: string;
  documentId?: string | null;
  title: string;
  requester: string;
  initials: string;
  avatarBg: string;
  type: string;
  stage: string;
  stageSub: string;
  requestedAt: string;
  status: Status;
  // AP-DSH-06 — the SERVER decides what counts as late. BR-13 / AP-SLA-07
  // make the deadline server-owned, so comparing `due_at` against the
  // browser's clock would let a skewed client paint its own idea of overdue.
  urgency: Urgency;
  dueAt: string | null;
  hoursUntilDue: number | null;
  stageInstanceId?: string | null;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  bg:          "var(--bg-base)",
  surface:     "var(--bg-elevated)",
  hover:       "var(--bg-overlay)",
  text:        "var(--text-primary)",
  muted:       "var(--text-muted)",
  accent:      "var(--color-primary-500)",
  accentHover: "var(--color-primary-400)",
  accentTint:  "color-mix(in srgb, var(--color-primary-500) 12%, transparent)",
  accentSel:   "color-mix(in srgb, var(--color-primary-500) 8%, transparent)",
  green:       "var(--color-success-500)",
  greenTint:   "color-mix(in srgb, var(--color-success-500) 12%, transparent)",
  red:         "var(--color-error-500)",
  redTint:     "color-mix(in srgb, var(--color-error-500) 12%, transparent)",
  amber:       "var(--color-warning-500)",
  amberTint:   "color-mix(in srgb, var(--color-warning-500) 12%, transparent)",
  blue:        "var(--color-primary-400)",
  blueTint:    "color-mix(in srgb, var(--color-primary-400) 12%, transparent)",
  border:      "var(--border-default)",
};

// ─── Row mapping ──────────────────────────────────────────────────────────────

/** Deterministic avatar colour from the person's name — stable per user
 *  without needing an avatar service, and never a random/placeholder value. */
function avatarColor(seed: string): string {
  const palette = ["var(--chart-3)", "var(--chart-2)", "var(--chart-5)", "var(--chart-4)", "var(--destructive)", "var(--chart-1)", "var(--status-revoked)"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return palette[h % palette.length];
}

/**
 * Map a backend ApprovalStep onto the row model.
 *
 * This used to fabricate every visible field — the title was
 * `Approval Step <uuid-fragment>`, the type was the literal string
 * "Document", the stage subtitle was "Approval", the avatar colour was
 * hardcoded, and `requester` was filled with `approver_name`, i.e. the
 * person being asked to approve rather than the person who submitted it.
 * The backend populates the real document context
 * (ApprovalService.list_my_approvals batch-fetches it), so use that and
 * fall back to something honest when a field genuinely isn't available.
 */
function mapStepToApproval(step: ApprovalStep): Approval {
  const requester = step.submitter_name || "Unknown submitter";
  const initials =
    requester
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "U";

  const title = step.document_title || step.document_public_id || "Untitled document";
  const type = step.document_public_id || "Document";
  const stage = step.stage_name || "Approval stage";
  const stageSub =
    step.round_number > 1 ? `Round ${step.round_number}` : "Awaiting decision";
  const requestedAt = new Date(step.created_at || Date.now()).toLocaleDateString();

  let status: Status = "pending";
  if (step.decision === "approved") status = "approved";
  else if (step.decision === "rejected") status = "rejected";

  return {
    id: step.id,
    documentId: step.document_id,
    title,
    requester,
    initials,
    avatarBg: avatarColor(requester),
    type,
    stage,
    stageSub,
    urgency: (step.urgency ?? "none") as Urgency,
    dueAt: step.due_at ?? null,
    hoursUntilDue: step.hours_until_due ?? null,
    stageInstanceId: step.stage_instance_id ?? null,
    requestedAt,
    status,
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

// ─── Constants ────────────────────────────────────────────────────────────────

const TABS: { key: TabKey; label: string }[] = [
  { key: "pending",  label: "Pending"  },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all",      label: "All"      },
];

const PER_PAGE = 10;

const SORTS: { key: SortKey; label: string }[] = [
  { key: "due_at",         label: "Due soonest"   },
  { key: "-due_at",        label: "Due latest"    },
  { key: "-submitted_at",  label: "Newest first"  },
  { key: "submitted_at",   label: "Oldest first"  },
  { key: "title",          label: "Title A-Z"     },
  { key: "-title",         label: "Title Z-A"     },
];

const URGENCY: Record<Urgency, { label: string; color: string; bg: string } | null> = {
  overdue:  { label: "Overdue",  color: "var(--danger)",  bg: "var(--danger-subtle, rgba(220,38,38,0.12))" },
  due_soon: { label: "Due soon", color: "var(--warning)", bg: "var(--warning-subtle, rgba(217,119,6,0.12))" },
  normal:   null,
  none:     null,
};

/** Hours -> "in 3h" / "5h overdue", for the urgency chip's tooltip. */
function dueLabel(hours: number | null): string {
  if (hours == null) return "No deadline";
  const abs = Math.abs(hours);
  const unit = abs >= 48 ? `${Math.round(abs / 24)}d` : `${Math.round(abs)}h`;
  return hours < 0 ? `${unit} overdue` : `Due in ${unit}`;
}

// Grid template for table columns
const GRID_COLS = "40px minmax(240px,1fr) 120px 200px 110px 110px 90px";

// Shared look for the toolbar's real selects, so the filters and the sort
// match the chips they replaced.
const selectStyle: React.CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--border-subtle)",
  borderRadius: 10,
  color: "var(--text-muted)",
  background: "var(--bg-overlay)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
  fontFamily: "'Inter', sans-serif",
  outline: "none",
  maxWidth: 190,
};

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ApprovalsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabKey>("pending");
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [search, setSearch]       = useState("");
  const [sort, setSort]           = useState<SortKey>("due_at");
  const [templateFilter, setTemplateFilter] = useState("");
  const [deptFilter, setDeptFilter]         = useState("");
  const [page, setPage]           = useState(1);
  const [hovered, setHovered]     = useState<string | null>(null);
  // NOTE: nothing currently calls a setter for this — the row-exit animation
  // this was meant to drive was never wired up to the approve/reject actions.
  const [exiting] = useState<Set<string>>(new Set());
  const [actionModal, setActionModal] = useState<{ open: boolean; type: "approved"|"rejected"; id?: string; bulk?: boolean }>({ open: false, type: "approved" });
  const [note, setNote] = useState("");
  const [signatureNeeded, setSignatureNeeded] = useState(false);
  const [signatureName, setSignatureName] = useState("");

  // §6.2/6.5/6.6 panel — holds the workflow instance whose history is open.
  const [historyInstanceId, setHistoryInstanceId] = useState<string | null>(null);

  const [delegateModal, setDelegateModal] = useState<{ open: boolean; stepId?: string }>({ open: false });
  const [delegateUserId, setDelegateUserId] = useState("");
  const [delegateReason, setDelegateReason] = useState("");
  const membersQ = useMessageableMembers();
  const delegateM = useDelegateStep();

  // Debounced, because this is now a request rather than an array filter:
  // one per keystroke would be a request per keystroke (AP-DSH-04).
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Every filter, the sort and the page are SERVER parameters (AP-DSH-02..07).
  // They used to be applied in the browser over a single page of rows, so the
  // search searched only what had already been downloaded and "page 2" paged
  // an array the server had already sent in full.
  const myQueueQ = useMyApprovalQueue({
    status: activeTab,
    q: debouncedSearch || undefined,
    template_id: templateFilter || undefined,
    department_id: deptFilter || undefined,
    sort,
    page,
    limit: PER_PAGE,
  });
  const approveM = useApproveStep();
  const rejectM = useRejectStep();

  const templatesQ = useWorkflowTemplates();
  const deptsQ = useDepartments(true);

  // AP-DSH-09: the queue auto-refreshes, but it must not reorder under the
  // cursor. While the approver has rows selected or a dialog open, incoming
  // data is HELD and announced with a prompt instead of being swapped in
  // underneath them. With nothing selected there is nothing to disturb, so it
  // applies straight away.
  const holding = selected.size > 0 || actionModal.open || delegateModal.open;
  const [shown, setShown] = useState<typeof myQueueQ.data>(undefined);
  const [hasNewer, setHasNewer] = useState(false);
  const latest = useRef<typeof myQueueQ.data>(undefined);

  useEffect(() => {
    latest.current = myQueueQ.data;
    if (!myQueueQ.data) return;
    if (!holding) {
      setShown(myQueueQ.data);
      setHasNewer(false);
      return;
    }
    // Only prompt when the data genuinely moved on — a refetch that returns
    // the same rows must not light up a banner.
    const current = shown;
    const changed =
      !current ||
      current.total !== myQueueQ.data.total ||
      current.items.length !== myQueueQ.data.items.length ||
      current.items.some((it, i) => it.id !== myQueueQ.data!.items[i]?.id);
    if (changed) setHasNewer(true);
  }, [myQueueQ.data, holding, shown]);

  function applyNewer() {
    if (latest.current) setShown(latest.current);
    setHasNewer(false);
    setSelected(new Set());
  }

  const data = shown;
  const approvals = useMemo(
    () => (data?.items || []).map(mapStepToApproval),
    [data],
  );

  // Real counts, straight from the database (AP-DSH-02). These used to be
  // hard-coded `approved: 0, rejected: 0` with `all` set to the pending
  // count, because the client only ever held one tab's worth of rows.
  const counts: Record<TabKey, number> = useMemo(() => ({
    pending:  data?.counts?.pending  ?? 0,
    approved: data?.counts?.approved ?? 0,
    rejected: data?.counts?.rejected ?? 0,
    all:      data?.counts?.all      ?? 0,
  }), [data]);

  const summary = data?.summary;
  const total      = data?.total ?? 0;
  const totalPages = Math.max(1, data?.pages ?? 1);
  const safePage   = Math.min(page, totalPages);
  const paged      = approvals;

  function switchTab(tab: TabKey) {
    setActiveTab(tab); setSelected(new Set()); setPage(1);
  }

  function resetToFirstPage() {
    setPage(1); setSelected(new Set());
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
    setSignatureNeeded(false);
    setSignatureName("");
  }

  function openDelegate(stepId: string) {
    setDelegateModal({ open: true, stepId });
    setDelegateUserId("");
    setDelegateReason("");
  }

  async function confirmDelegate() {
    if (!delegateModal.stepId || !delegateUserId) return;
    try {
      await delegateM.mutateAsync({
        stepId: delegateModal.stepId,
        payload: { delegate_user_id: delegateUserId, reason: delegateReason || undefined },
      });
      toast.success("Approval delegated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delegate approval");
    }
    setDelegateModal({ open: false });
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

    // AP-REJ-02: a rejection is terminal, so the server requires a real
    // reason (>= 10 meaningful characters). Checked here too — not instead
    // of the server, but so the approver sees the problem before any request
    // is sent, and a bulk reject does not fire one doomed call per row.
    if (!isApprove) {
      const meaningful = (note ?? "").replace(/[^\p{L}\p{N}]/gu, "");
      if (meaningful.length < 10) {
        toast.error(
          "Please give a reason of at least 10 characters so the owner knows what to fix.",
        );
        return;
      }
    }

    if (!bulk && id) {
      try {
        const signature = signatureNeeded && signatureName.trim()
          ? { signature_method: "typed" as const, signed_hash: signatureName.trim() }
          : undefined;
        await m.mutateAsync({ stepId: id, note: note || undefined, signature });
        toast[isApprove ? "success" : "error"](`Document ${type}`);
      } catch (err) {
        // Stage requires a digital signature — switch the same modal into
        // signature-collection mode instead of closing it, then let the user
        // confirm again (this time with `signature` attached above).
        if (
          err instanceof ApiClientError &&
          err.status === 422 &&
          err.detail.toLowerCase().includes("signature")
        ) {
          setSignatureNeeded(true);
          toast.error("This stage requires a signature — type your name below to sign.");
          return; // keep modal open
        }
        toast.error(err instanceof Error ? err.message : `Failed to ${type.slice(0, -1)} document`);
        return;
      }
    } else if (bulk) {
      // D4: bulk goes through the SAME server-side decision logic as a
      // single decision — every authorization check and the signing gate
      // apply identically. A stage that requires a signature is skipped with
      // a reported reason and never auto-signed, so no signature is attached
      // here on purpose.
      //
      // Outcomes are counted per item. The previous loop swallowed every
      // error and then reported the full selection as done, which told the
      // approver that documents the server had refused were approved.
      const needsSignature: string[] = [];
      const failed: string[] = [];
      const done: string[] = [];

      for (const selId of selected) {
        try {
          await m.mutateAsync({ stepId: selId, note: note || undefined });
          done.push(selId);
        } catch (err) {
          const isSigning =
            err instanceof ApiClientError &&
            err.status === 422 &&
            err.detail.toLowerCase().includes("signature");
          if (isSigning) needsSignature.push(selId);
          else failed.push(selId);
        }
      }

      if (done.length > 0) {
        toast[isApprove ? "success" : "error"](
          `${done.length} ${done.length === 1 ? "item" : "items"} ${type}`,
        );
      }
      if (needsSignature.length > 0) {
        toast.warning(
          `${needsSignature.length} skipped — ${
            needsSignature.length === 1 ? "it requires" : "they require"
          } a signature. Approve those one at a time to sign.`,
          { duration: 8000 },
        );
      }
      if (failed.length > 0) {
        toast.error(
          `${failed.length} could not be ${type}. ${
            failed.length === 1 ? "It stays" : "They stay"
          } selected so you can retry.`,
          { duration: 8000 },
        );
      }
      if (done.length === 0 && needsSignature.length === 0 && failed.length === 0) {
        toast.info("Nothing was selected.");
      }

      // Keep whatever did not go through selected, so a retry does not mean
      // finding those rows again.
      setSelected(new Set([...needsSignature, ...failed]));
    }
    setActionModal({ open: false, type: "approved" });
    setSignatureNeeded(false);
    setSignatureName("");
  }

  const allPageSelected = paged.length > 0 && selected.size >= paged.length;

  return (
    <div className="page-content" style={{ paddingTop: 24 }}>
        {/* ── Page header ── */}
        <PageHeader
          breadcrumbs={[{ label: "Workspace" }, { label: "Approvals" }]}
          title="Approvals"
          description="Review and act on requests waiting for you"
          actions={
            <button className="btn btn-primary" onClick={() => navigate('/documents/new')}>
              <Plus size={16} /> New Request
            </button>
          }
        />

        <div style={{ height: 20 }} />

        {/* ── Main card ── */}
        <div className="glass-card" style={{ overflow: "hidden" }}>

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

            {/* Filters — real server filters (AP-DSH-05). These were four
                chips labelled Requester / Type / Department / Date that did
                nothing at all when clicked, which UX-INT-01 forbids. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <select
                value={templateFilter}
                onChange={e => { setTemplateFilter(e.target.value); resetToFirstPage(); }}
                aria-label="Filter by workflow"
                style={selectStyle}
              >
                <option value="">All workflows</option>
                {(templatesQ.data ?? []).map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              <select
                value={deptFilter}
                onChange={e => { setDeptFilter(e.target.value); resetToFirstPage(); }}
                aria-label="Filter by department"
                style={selectStyle}
              >
                <option value="">All departments</option>
                {(deptsQ.data ?? []).map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>

              {(templateFilter || deptFilter || debouncedSearch) && (
                <button
                  onClick={() => {
                    setTemplateFilter(""); setDeptFilter(""); setSearch("");
                    resetToFirstPage();
                  }}
                  style={{
                    padding: "7px 12px", borderRadius: 10,
                    border: `1px solid ${C.border}`, color: C.muted,
                    background: "transparent", cursor: "pointer",
                    fontSize: 12, fontWeight: 500,
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
              {/* Was a button reading "Newest first" that sorted nothing. */}
              <ArrowUpDown size={13} style={{ color: C.muted }} />
              <select
                value={sort}
                onChange={e => { setSort(e.target.value as SortKey); resetToFirstPage(); }}
                aria-label="Sort approvals"
                style={selectStyle}
              >
                {SORTS.map(s => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Summary strip (AP-DSH-08) — the whole pending workload, not
                the current filter, so it does not change as you type. ── */}
          {summary && summary.pending > 0 && (
            <div style={{
              display: "flex", alignItems: "center", gap: 20,
              padding: "10px 24px",
              borderBottom: `1px solid ${C.border}`,
              fontSize: 12, fontFamily: "'Inter', sans-serif",
            }}>
              <span style={{ color: C.muted }}>
                <strong style={{ color: C.text }}>{summary.pending}</strong> awaiting you
              </span>
              {summary.overdue > 0 && (
                <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                  {summary.overdue} overdue
                </span>
              )}
              {summary.due_today > 0 && (
                <span style={{ color: "var(--warning)", fontWeight: 600 }}>
                  {summary.due_today} due today
                </span>
              )}
              {summary.due_this_week > 0 && (
                <span style={{ color: C.muted }}>
                  {summary.due_this_week} due this week
                </span>
              )}
            </div>
          )}

          {/* ── AP-DSH-09: new items are announced, not swapped in under the
                cursor while the approver is working through a selection. ── */}
          {hasNewer && (
            <button
              onClick={applyNewer}
              style={{
                width: "100%", textAlign: "left",
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 24px",
                border: "none", borderBottom: `1px solid ${C.border}`,
                background: C.hover, color: C.accent,
                cursor: "pointer", fontSize: 13, fontWeight: 600,
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Your queue has changed - show the latest
            </button>
          )}

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
                {myQueueQ.isLoading ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} style={{ padding: "16px 24px" }}><Skeleton style={{ height: 40 }} /></div>
                    ))}
                  </div>
                ) : myQueueQ.isError ? (
                  <div style={{ padding: "48px 24px" }}>
                    <EmptyState art="inbox" title="Couldn't load approvals" description="Something went wrong fetching your queue."
                      action={<button className="btn btn-secondary btn-sm" onClick={() => myQueueQ.refetch()}>Retry</button>} />
                  </div>
                ) : paged.length === 0 ? (
                  <EmptyState
                    art="checklist"
                    title={activeTab === "pending" ? "You're all caught up" : `No ${activeTab} approvals`}
                    description={activeTab === "pending" ? "Nothing needs your attention right now." : `No documents have been ${activeTab} yet.`}
                  />
                ) : (
                  paged.map((item, idx) => {
                    const isSelected = selected.has(item.id);
                    const isHovered  = hovered === item.id;
                    const isExiting  = exiting.has(item.id);

                    const stageBg =
                      item.status === "rejected" ? C.redTint
                      : item.status === "approved" ? C.greenTint
                      : "color-mix(in srgb, var(--foreground) 6%, transparent)";
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
                        onClick={() => {
                          // AP-DET-01: the approver's own screen for this
                          // step. This used to open /documents/{id}, which is
                          // the OWNER's view - it shows the document but not
                          // the stage, what it requires, or what was decided
                          // before. Runs predating stage instances have no id
                          // to link to, so those still fall back.
                          if (item.stageInstanceId) navigate(`/approvals/${item.stageInstanceId}`);
                          else if (item.documentId) navigate(`/documents/${item.documentId}`);
                        }}
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
                          <IconChip tone="primary" size={40}><FileText size={17} /></IconChip>
                          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                            <p style={{
                              fontSize: 14, fontWeight: 600, color: C.text,
                              margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}>
                              {item.title}
                            </p>
                            {/* AP-DSH-06 — rendered from the server's verdict,
                                never from a client-side clock comparison. */}
                            {URGENCY[item.urgency] && (
                              <span
                                title={dueLabel(item.hoursUntilDue)}
                                style={{
                                  alignSelf: "flex-start",
                                  marginTop: 4,
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  fontSize: 10,
                                  fontWeight: 700,
                                  letterSpacing: "0.03em",
                                  textTransform: "uppercase",
                                  color: URGENCY[item.urgency]!.color,
                                  background: URGENCY[item.urgency]!.bg,
                                }}
                              >
                                {URGENCY[item.urgency]!.label}
                              </span>
                            )}
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
                        <div><StatusPill status={item.status} /></div>

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
                              <button
                                onClick={e => { e.stopPropagation(); openDelegate(item.id); }}
                                title="Delegate to someone else"
                                style={{
                                  width: 32, height: 32, borderRadius: "50%",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  background: C.blueTint, color: C.blue,
                                  border: "none", cursor: "pointer",
                                  transition: "transform 0.15s",
                                }}
                                onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.1)")}
                                onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
                              >
                                <UserPlus size={14} />
                              </button>
                            </>
                          )}
                          {/* §6.6 chain of custody + §6.5 revoke + §6.2
                              finalize, all in one panel. Shown for every row
                              (not just pending ones) so a decided step's
                              history stays reachable. */}
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              const step = (myQueueQ.data?.items || []).find(s => s.id === item.id);
                              if (step) setHistoryInstanceId(step.instance_id);
                            }}
                            title="Approval history, signatures, revoke & finalize"
                            style={{
                              width: 32, height: 32, borderRadius: "50%",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              background: "var(--bg-overlay)", color: "var(--text-secondary)",
                              border: "1px solid var(--border-subtle)", cursor: "pointer",
                              transition: "transform 0.15s",
                            }}
                            onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.1)")}
                            onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
                          >
                            <History size={14} />
                          </button>
                        </div>
                      </motion.div>
                    );
                  })
                )}
              </div>

            </div>
          </div>

          {/* ── Pagination ── */}
          {totalPages > 1 && (
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "16px 24px",
              borderTop: `1px solid ${C.border}`,
            }}>
              <span style={{ fontSize: 14, color: C.muted }}>
                Showing {total === 0 ? 0 : (safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, total)} of {total}
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

      <ConfirmDialog
        open={actionModal.open}
        title={
          signatureNeeded
            ? "Digital Signature Required"
            : actionModal.type === "approved" ? "Approve Request" : "Reject Request"
        }
        message={
          signatureNeeded
            ? "This workflow stage requires a digital signature to approve. Type your full name below to sign."
            : actionModal.bulk
              ? `Are you sure you want to ${actionModal.type} ${selected.size} requests?`
              : `Are you sure you want to ${actionModal.type} this request?`
        }
        confirmLabel={signatureNeeded ? "Sign & Approve" : actionModal.type === "approved" ? "Approve" : "Reject"}
        confirmDisabled={signatureNeeded && !signatureName.trim()}
        onConfirm={confirmAction}
        onCancel={() => {
          setActionModal({ open: false, type: "approved" });
          setSignatureNeeded(false);
          setSignatureName("");
        }}
      >
        {signatureNeeded ? (
          <input
            type="text"
            autoFocus
            placeholder="Type your full legal name"
            value={signatureName}
            onChange={(e) => setSignatureName(e.target.value)}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text,
              fontSize: 14, fontFamily: "'Inter', sans-serif",
            }}
          />
        ) : (
          <textarea
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text,
              fontSize: 14, fontFamily: "'Inter', sans-serif", resize: "vertical",
            }}
          />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={delegateModal.open}
        title="Delegate Approval"
        message="Reassign this approval step to another organization member. They'll receive a fresh pending step; this one will be marked delegated."
        confirmLabel="Delegate"
        confirmDisabled={!delegateUserId}
        onConfirm={confirmDelegate}
        onCancel={() => setDelegateModal({ open: false })}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <select
            value={delegateUserId}
            onChange={(e) => setDelegateUserId(e.target.value)}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text,
              fontSize: 14, fontFamily: "'Inter', sans-serif",
            }}
          >
            <option value="">
              {membersQ.isLoading ? "Loading members..." : "Select a team member..."}
            </option>
            {(membersQ.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.display_name} ({m.email})</option>
            ))}
          </select>
          <textarea
            placeholder="Reason (optional)"
            value={delegateReason}
            onChange={(e) => setDelegateReason(e.target.value)}
            rows={2}
            style={{
              width: "100%", padding: "10px 12px", borderRadius: 8,
              border: `1px solid ${C.border}`, background: C.bg, color: C.text,
              fontSize: 14, fontFamily: "'Inter', sans-serif", resize: "vertical",
            }}
          />
        </div>
      </ConfirmDialog>

      {historyInstanceId && (
        <ApprovalHistoryPanel
          instanceId={historyInstanceId}
          onClose={() => setHistoryInstanceId(null)}
        />
      )}
    </div>
  );
}
