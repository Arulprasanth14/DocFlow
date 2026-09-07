/**
 * DocFlow Frontend — API Client: Analytics
 * Typed calls for /analytics endpoints.
 */

import { apiClient } from './client';
import type { DashboardStats } from '@/types';

export const analyticsApi = {
  getDashboardStats: () =>
    apiClient.get<DashboardStats>('/analytics/dashboard'),
};

export default analyticsApi;
