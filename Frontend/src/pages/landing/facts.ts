/**
 * DocFlow Landing Page — Strict Facts & Capability Policy
 * Single source of truth for technical facts and feature statuses.
 * Only items with confirmed: true may be asserted as present-tense claims.
 */

export type FeatureStatus = 'live' | 'in-progress' | 'planned';

export interface FactItem {
  id: string;
  claim: string;
  status: FeatureStatus;
  confirmed: boolean;
  notes?: string;
}

export const DOCFLOW_FACTS: FactItem[] = [
  // ── Core Architecture (Confirmed Live Facts) ──
  {
    id: 'fact-auth-firebase',
    claim: 'Authentication is powered by Firebase Authentication with role-scoped access control.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-db-postgres-rls',
    claim: 'Every query is scoped to the organization, so each tenant’s documents, members and templates stay isolated.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-storage-s3',
    claim: 'Document files and attachments are stored in S3-compatible object storage.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-audit-acid',
    claim: 'Chat discussions, comments, and approval actions are stored in an ACID database to serve as audit evidence.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-ai-decoupled',
    claim: 'The AI assistant operates as an optional modular layer; document workflows continue running smoothly if AI services are unavailable.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-unified-portal',
    claim: 'Single unified portal interface: every member can submit requests and act on documents sent to them.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-p2p-routing',
    claim: 'Role-based peer-to-peer routing moves documents person to person rather than forcing rigid hierarchy ladders.',
    status: 'live',
    confirmed: true,
  },
  {
    id: 'fact-multi-tenant',
    claim: 'Multi-tenant architecture provides an isolated workspace per organization with its own members, roles, departments, templates, and documents.',
    status: 'live',
    confirmed: true,
  },

  // ── Features in Progress ──
  {
    id: 'feat-templates-repo',
    claim: 'Document repository and templates with hub listing, creation wizard, and autosave.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-template-studio',
    claim: 'Template Studio editor for authoring reusable organizational forms with dynamic blanks.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-workflow-engine',
    claim: 'Workflow and permission engine with dynamic conditional step routing.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-approvals-queue',
    claim: 'Approvals queue with Pending, Approved, and Rejected views and live badge indicators.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-comments-chat',
    claim: 'Comments and contextual chat on documents with @mentions retained as audit history.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-revoke-approval',
    claim: 'Revoke approval capability and upstream prior-approver visibility before workflow closure.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },
  {
    id: 'feat-ai-drafting',
    claim: 'AI-assisted document drafting synthesized from structured template blanks.',
    status: 'in-progress',
    confirmed: false,
    notes: 'In progress',
  },

  // ── Planned Capabilities (Coming Soon) ──
  {
    id: 'feat-ai-assistant',
    claim: 'Conversational AI assistant that answers questions strictly from your organization’s uploaded documents and policies.',
    status: 'planned',
    confirmed: false,
    notes: 'Coming soon',
  },
  {
    id: 'feat-signatures-crypto',
    claim: 'Cryptographic digital signatures binding approver identity with document verification.',
    status: 'planned',
    confirmed: false,
    notes: 'Coming soon',
  },
  {
    id: 'feat-notifications',
    claim: 'Multi-channel notifications via email and in-app badges, with SMS and push notifications planned.',
    status: 'planned',
    confirmed: false,
    notes: 'Coming soon',
  },
  {
    id: 'feat-audit-trail',
    claim: 'Built-in tamper-evident audit and compliance trail tracking document events.',
    status: 'planned',
    confirmed: false,
    notes: 'Coming soon',
  },
  {
    id: 'feat-analytics-search',
    claim: 'Operational search and turnaround analytics with monthly and yearly reporting views.',
    status: 'planned',
    confirmed: false,
    notes: 'Coming soon',
  },
];

/**
 * Returns the status label for rendering chips.
 */
export function getStatusLabel(status: FeatureStatus): 'Live' | 'In progress' | 'Coming soon' {
  switch (status) {
    case 'live':
      return 'Live';
    case 'in-progress':
      return 'In progress';
    case 'planned':
      return 'Coming soon';
  }
}

