import { useQuery } from '@tanstack/react-query';
import analyticsApi from '@/lib/api/analytics';
import { useAuthStore } from '@/store/authStore';

export const analyticsKeys = {
  dashboard: ['analytics', 'dashboard'] as const,
};

export function useDashboardStats() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: analyticsKeys.dashboard,
    queryFn: () => analyticsApi.getDashboardStats(),
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 2, // 2 minutes
  });
}
