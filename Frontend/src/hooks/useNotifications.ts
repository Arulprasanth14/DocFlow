import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import notificationsApi, { type NotificationFilters } from '@/lib/api/notifications';
import { useAuthStore } from '@/store/authStore';

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (params?: NotificationFilters) => ['notifications', 'list', params] as const,
  unreadCount: () => ['notifications', 'unreadCount'] as const,
};

export function useNotifications(params?: NotificationFilters) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: notificationKeys.list(params),
    queryFn: () => notificationsApi.listNotifications(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useUnreadCount() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: () => notificationsApi.getUnreadCount(),
    enabled: isAuthenticated,
    refetchInterval: 1000 * 60, // Poll every minute
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
