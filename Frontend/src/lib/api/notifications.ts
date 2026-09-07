/**
 * DocFlow Frontend — API Client: Notifications
 * Typed calls for /notifications endpoints.
 */

import { apiClient } from './client';
import type { Notification, PaginatedResponse } from '@/types';

export interface NotificationFilters {
  page?: number;
  limit?: number;
  unread_only?: boolean;
}

export const notificationsApi = {
  listNotifications: (params?: NotificationFilters) =>
    apiClient.get<PaginatedResponse<Notification>>('/notifications', { params }),

  getUnreadCount: () =>
    apiClient.get<{ count: number }>('/notifications/unread-count'),

  markRead: (id: string) =>
    apiClient.post<{ message: string; notification: Notification }>(`/notifications/${id}/read`),

  markAllRead: () =>
    apiClient.post<{ message: string }>('/notifications/read-all'),
};

export default notificationsApi;
