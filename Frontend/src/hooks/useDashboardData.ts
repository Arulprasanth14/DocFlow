/**
 * useDashboardData — the SINGLE source of truth for the dashboard.
 *
 * Information-ownership rule: every count/metric the dashboard shows is derived here exactly once, so two
 * widgets can never disagree. Widgets read the relevant query's {isLoading,isError,refetch} for their own
 * skeleton/retry, but numbers always come from this hook. UI-only: composes EXISTING endpoints only
 * (/analytics/dashboard, /analytics/report, /approvals, /documents, /notifications, /chat/members).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import analyticsApi from '@/lib/api/analytics';
import { useDashboardStats } from '@/hooks/useAnalytics';
import { useMyApprovalQueue } from '@/hooks/useApprovals';
import { useDocuments } from '@/hooks/useDocuments';
import { useNotifications } from '@/hooks/useNotifications';
import { useMessageableMembers } from '@/hooks/useApprovals';
import { useAuthStore } from '@/store/authStore';
import type { Document, DocumentStatus } from '@/types';

/** In-flight statuses for documents I submitted. */
const IN_PROGRESS: DocumentStatus[] = ['submitted', 'pending', 'sent_back'];
const RETURNED: DocumentStatus[] = ['rejected', 'sent_back'];

export function useDashboardData() {
  const user = useAuthStore((s) => s.user);
  const userId = user?.id;
  // Both selectors must run on every render: `&&` short-circuiting the second
  // useAuthStore call changed the hook order between trainee and non-trainee
  // users (rules-of-hooks violation).
  const hasTraineeRole = useAuthStore((s) => s.hasRole('trainee'));
  const isSuperAdmin = useAuthStore((s) => s.isSuperAdmin());
  const isTrainee = hasTraineeRole && !isSuperAdmin;
  const canApprove = !isTrainee; // approver is dynamic; trainees are stripped from approvers
  const canNewWorkflow = useAuthStore((s) => s.hasPermission('workflows:admin') || s.isSuperAdmin());
  const canInvite = useAuthStore((s) => s.hasPermission('members:invite_standard') || s.isSuperAdmin());

  // ── Source queries ──────────────────────────────────────────────────────────
  const stats = useDashboardStats();
  const report = useQuery({
    queryKey: ['analytics', 'report', 'dashboard'],
    queryFn: () => analyticsApi.getReport(),
    enabled: !!userId,
    staleTime: 1000 * 60 * 2,
  });
  const queue = useMyApprovalQueue();
  const recent = useDocuments({ page: 1, limit: 6, sort: '-updated_at' });
  const mine = useDocuments({ page: 1, limit: 25, sort: '-updated_at', submitted_by: userId });
  const activity = useNotifications({ page: 1, limit: 6 });

  // Fresh-workspace candidate drives the (otherwise skipped) members fetch.
  const freshCandidate = recent.data?.total === 0 && (report.data?.workflows.instances_started ?? 0) === 0;
  const members = useMessageableMembers();

  // ── Derived, single-source values ───────────────────────────────────────────
  const statusCounts = useMemo(() => {
    const by = report.data?.breakdowns.by_status ?? [];
    const get = (k: string) => by.find((b) => (b.key ?? '').toLowerCase() === k)?.count ?? 0;
    return {
      draft: get('draft'),
      submitted: get('submitted'),
      pending: get('pending'),
      approved: get('approved'),
      rejected: get('rejected'),
      sent_back: get('sent_back'),
    };
  }, [report.data]);

  const kpis = useMemo(() => {
    const s = stats.data;
    const approvedN = s?.documents_approved ?? 0;
    const rejectedN = s?.documents_rejected ?? 0;
    const decided = approvedN + rejectedN;
    return {
      approvalRate: decided > 0 ? Math.round((approvedN / decided) * 100) : null, // null → render "-"
      avgTurnaroundHours: s?.avg_approval_time_hours ?? null,
      overdueCount: report.data?.approvals.overdue_now ?? null,
      processed: decided,
      scope: report.data?.scope ?? null, // 'own' | 'own_and_department' | 'organization' | 'none'
    };
  }, [stats.data, report.data]);

  const bottleneck = useMemo(() => {
    const b = report.data?.bottlenecks ?? [];
    // slowest stage by avg time-to-decision, only if it's a real figure
    const withTime = b.filter((x) => typeof x.avg_time_to_decision_hours === 'number');
    if (!withTime.length) return null;
    return withTime.sort((a, z) => (z.avg_time_to_decision_hours! - a.avg_time_to_decision_hours!))[0];
  }, [report.data]);

  const mineItems: Document[] = mine.data?.items ?? [];
  const inProgress = useMemo(() => mineItems.filter((d) => IN_PROGRESS.includes(d.status)), [mine.data]);
  const drafts = useMemo(() => mineItems.filter((d) => d.status === 'draft'), [mine.data]);
  const returned = useMemo(() => mineItems.filter((d) => RETURNED.includes(d.status)), [mine.data]);

  const trend = stats.data?.trend_data ?? [];

  // ── Fresh-workspace + get-started ─────────────────────────────────────────────
  const teamCount = members.data?.length ?? null;
  const getStarted = useMemo(
    () => ({
      hasDocuments: (recent.data?.total ?? 0) > 0,
      hasWorkflow: (report.data?.workflows.instances_started ?? 0) > 0,
      hasTeam: teamCount !== null ? teamCount > 1 : null, // null = can't verify
    }),
    [recent.data, report.data, teamCount],
  );
  const isFresh = !!freshCandidate && !recent.isLoading && !report.isLoading;

  return {
    user,
    roles: { isTrainee, canApprove, canNewWorkflow, canInvite },
    stats,
    report,
    queue,
    recent,
    mine,
    activity,
    members,
    // derived (single source)
    statusCounts,
    kpis,
    bottleneck,
    inProgress,
    drafts,
    returned,
    trend,
    totalQueue: queue.data?.total ?? queue.data?.items?.length ?? 0,
    isFresh,
    getStarted,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
