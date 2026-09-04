/**
 * DocFlow Frontend — API Client: Organizations & RBAC
 * Typed calls for all /orgs endpoints.
 */

import { apiClient } from './client';
import type {
  Organization,
  Department,
  Team,
  Role,
  OrgStats,
  MemberDetail,
  PermissionCatalog,
  PaginatedResponse,
} from '@/types';

export interface UpdateOrgPayload {
  name?: string;
  logo_url?: string;
  settings?: Record<string, unknown>;
}

export interface CreateDepartmentPayload {
  name: string;
  code?: string;
  parent_id?: string | null;
  head_user_id?: string | null;
}

export interface UpdateDepartmentPayload {
  name?: string;
  code?: string;
  parent_id?: string | null;
  head_user_id?: string | null;
}

export interface CreateTeamPayload {
  name: string;
  dept_id?: string | null;
}

export interface UpdateTeamPayload {
  name?: string;
  dept_id?: string | null;
}

export interface CreateRolePayload {
  name: string;
  description?: string;
  permissions?: string[];
}

export interface UpdateRolePayload {
  name?: string;
  description?: string;
}

export interface InviteMemberPayload {
  email: string;
  name?: string;
  role_id: string;
  dept_id?: string | null;
}

export interface UpdateMemberPayload {
  role_id?: string;
  dept_id?: string | null;
  team_id?: string | null;
  status?: string;
}

export interface ListMembersParams {
  page?: number;
  limit?: number;
  search?: string;
  role_id?: string;
  dept_id?: string;
  status?: string;
}

export const orgsApi = {
  // ── Organization ────────────────────────────────────────────────────────────
  getMyOrg: () =>
    apiClient.get<Organization>('/orgs/me'),

  updateMyOrg: (data: UpdateOrgPayload) =>
    apiClient.patch<Organization>('/orgs/me', data),

  getOrgStats: () =>
    apiClient.get<OrgStats>('/orgs/me/stats'),

  // ── Departments ─────────────────────────────────────────────────────────────
  listDepartments: (flat = false) =>
    apiClient.get<Department[]>('/orgs/me/departments', { params: { flat } }),

  createDepartment: (data: CreateDepartmentPayload) =>
    apiClient.post<Department>('/orgs/me/departments', data),

  updateDepartment: (id: string, data: UpdateDepartmentPayload) =>
    apiClient.patch<Department>(`/orgs/me/departments/${id}`, data),

  deleteDepartment: (id: string) =>
    apiClient.delete<{ message: string }>(`/orgs/me/departments/${id}`),

  // ── Teams ───────────────────────────────────────────────────────────────────
  listTeams: () =>
    apiClient.get<Team[]>('/orgs/me/teams'),

  createTeam: (data: CreateTeamPayload) =>
    apiClient.post<Team>('/orgs/me/teams', data),

  updateTeam: (id: string, data: UpdateTeamPayload) =>
    apiClient.patch<Team>(`/orgs/me/teams/${id}`, data),

  deleteTeam: (id: string) =>
    apiClient.delete<{ message: string }>(`/orgs/me/teams/${id}`),

  // ── Roles ───────────────────────────────────────────────────────────────────
  listRoles: () =>
    apiClient.get<Role[]>('/orgs/me/roles'),

  createRole: (data: CreateRolePayload) =>
    apiClient.post<Role>('/orgs/me/roles', data),

  updateRole: (id: string, data: UpdateRolePayload) =>
    apiClient.patch<Role>(`/orgs/me/roles/${id}`, data),

  setRolePermissions: (id: string, permissions: string[]) =>
    apiClient.put<Role>(`/orgs/me/roles/${id}/permissions`, { permissions }),

  deleteRole: (id: string) =>
    apiClient.delete<{ message: string }>(`/orgs/me/roles/${id}`),

  getPermissionCatalog: () =>
    apiClient.get<PermissionCatalog>('/orgs/me/permissions'),

  // ── Members ─────────────────────────────────────────────────────────────────
  listMembers: (params?: ListMembersParams) =>
    apiClient.get<PaginatedResponse<MemberDetail>>('/orgs/me/members', { params: params as Record<string, string | number | boolean | undefined> }),

  inviteMember: (data: InviteMemberPayload) =>
    apiClient.post<MemberDetail>('/orgs/me/members/invite', data),

  updateMember: (id: string, data: UpdateMemberPayload) =>
    apiClient.patch<MemberDetail>(`/orgs/me/members/${id}`, data),

  removeMember: (id: string) =>
    apiClient.delete<{ message: string }>(`/orgs/me/members/${id}`),
};

export default orgsApi;
