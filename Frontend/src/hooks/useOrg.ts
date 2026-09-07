/**
 * DocFlow Frontend — Organization & RBAC Hooks (TanStack Query)
 * Queries and mutations for organization settings, departments, teams, roles, and members.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import orgsApi, {
  type UpdateOrgPayload,
  type CreateDepartmentPayload,
  type UpdateDepartmentPayload,
  type CreateTeamPayload,
  type UpdateTeamPayload,
  type CreateRolePayload,
  type UpdateRolePayload,
  type InviteMemberPayload,
  type UpdateMemberPayload,
  type ListMembersParams,
} from '@/lib/api/orgs';
import { useAuthStore } from '@/store/authStore';

// ── Query Keys ─────────────────────────────────────────────────────────────────
export const orgKeys = {
  all: ['org'] as const,
  me: ['org', 'me'] as const,
  stats: ['org', 'stats'] as const,
  departments: (flat?: boolean) => ['org', 'departments', { flat }] as const,
  teams: ['org', 'teams'] as const,
  roles: ['org', 'roles'] as const,
  permissions: ['org', 'permissions'] as const,
  members: (params?: ListMembersParams) => ['org', 'members', params] as const,
};

// ── Organization Queries & Mutations ──────────────────────────────────────────
export function useMyOrg() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.me,
    queryFn: orgsApi.getMyOrg,
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5,
  });
}

export function useOrgStats() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.stats,
    queryFn: orgsApi.getOrgStats,
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useUpdateMyOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrgPayload) => orgsApi.updateMyOrg(data),
    onSuccess: (updated) => {
      queryClient.setQueryData(orgKeys.me, updated);
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

// ── Departments ───────────────────────────────────────────────────────────────
export function useDepartments(flat = false) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.departments(flat),
    queryFn: () => orgsApi.listDepartments(flat),
    enabled: isAuthenticated,
    staleTime: 1000 * 60,
  });
}

export function useCreateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDepartmentPayload) => orgsApi.createDepartment(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'departments'] });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

export function useUpdateDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateDepartmentPayload }) =>
      orgsApi.updateDepartment(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'departments'] });
    },
  });
}

export function useDeleteDepartment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => orgsApi.deleteDepartment(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'departments'] });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

// ── Teams ─────────────────────────────────────────────────────────────────────
export function useTeams() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.teams,
    queryFn: orgsApi.listTeams,
    enabled: isAuthenticated,
    staleTime: 1000 * 60,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTeamPayload) => orgsApi.createTeam(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.teams });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTeamPayload }) =>
      orgsApi.updateTeam(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.teams });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => orgsApi.deleteTeam(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.teams });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

// ── Roles & Permissions ───────────────────────────────────────────────────────
export function useRoles() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.roles,
    queryFn: orgsApi.listRoles,
    enabled: isAuthenticated,
    staleTime: 1000 * 60,
  });
}

export function useCreateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateRolePayload) => orgsApi.createRole(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.roles });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

export function useUpdateRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateRolePayload }) =>
      orgsApi.updateRole(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.roles });
    },
  });
}

export function useSetRolePermissions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: string[] }) =>
      orgsApi.setRolePermissions(id, permissions),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.roles });
    },
  });
}

export function useDeleteRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => orgsApi.deleteRole(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgKeys.roles });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

export function usePermissions() {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.permissions,
    queryFn: orgsApi.getPermissionCatalog,
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
}

// ── Members ───────────────────────────────────────────────────────────────────
export function useMembers(params?: ListMembersParams) {
  const isAuthenticated = useAuthStore((s) => !!s.user);
  return useQuery({
    queryKey: orgKeys.members(params),
    queryFn: () => orgsApi.listMembers(params),
    enabled: isAuthenticated,
    staleTime: 1000 * 30,
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: InviteMemberPayload) => orgsApi.inviteMember(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'members'] });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}

export function useUpdateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemberPayload }) =>
      orgsApi.updateMember(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'members'] });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => orgsApi.removeMember(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org', 'members'] });
      queryClient.invalidateQueries({ queryKey: orgKeys.stats });
    },
  });
}
