/**
 * DocFlow Frontend — API Client: Analytics
 * Typed calls for /analytics endpoints.
 *
 * Both endpoints accept a reporting period (§9: monthly by default, with a
 * yearly option) and return server-side aggregates — the client never
 * derives organization-wide figures from a page of rows.
 */

import { apiClient } from './client';
import type { DashboardStats } from '@/types';

export type ReportPeriod = 'monthly' | 'yearly';

export interface PeriodParams {
  period?: ReportPeriod;
  year?: number;
  month?: number;
}

/** Which records the caller's role allowed into these figures (§2.5). */
export type AnalyticsScope = 'organization' | 'own_and_department' | 'own' | 'none';

export interface Bucket {
  key: string | null;
  label?: string;
  count: number;
}

export interface AnalyticsReport {
  period: ReportPeriod;
  period_label: string;
  period_start: string;
  period_end: string;
  timezone: string;
  scope: AnalyticsScope;
  has_data: boolean;
  generated_at: string;
  documents: {
    created_in_period: Record<string, number>;
    created_total: number;
    completed_in_period: Record<string, number>;
    created_bucketed_on: string;
    completed_bucketed_on: string;
  };
  workflows: {
    instances_started: number;
    instances_completed: number;
    completion_rate: number | null;
    avg_completion_hours: number | null;
    currently_open: number;
    by_status: Record<string, number>;
  };
  approvals: {
    decisions_made: number;
    by_decision: Record<string, number>;
    pending_now: number;
    overdue_now: number;
    revoked_in_period: number;
    avg_time_to_decision_hours: number | null;
  };
  breakdowns: {
    by_status: Bucket[];
    by_department: Bucket[];
    by_document_type: Bucket[];
    by_workflow: Bucket[];
    by_month: Bucket[];
  };
  bottlenecks: {
    stage_id: string;
    stage_name: string;
    avg_time_to_decision_hours: number | null;
    decisions_in_period: number;
    pending_now: number;
    overdue_now: number;
  }[];
}

export const analyticsApi = {
  getDashboardStats: (params?: PeriodParams) =>
    apiClient.get<DashboardStats>('/analytics/dashboard', { params }),

  getReport: (params?: PeriodParams & { dept_id?: string; doc_type_id?: string }) =>
    apiClient.get<AnalyticsReport>('/analytics/report', { params }),
};

export default analyticsApi;
