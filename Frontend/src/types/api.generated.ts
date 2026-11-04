/* eslint-disable */
/**
 * GENERATED FILE — do not edit by hand (FR-1.7).
 *
 * Source: DocFlow API 0.1.0 (OpenAPI 3.1.0)
 * Regenerate with:  npm run gen:api
 *
 * Types only. The transport layer (lib/api/client.ts) stays hand-written:
 * it owns token refresh, the error envelope and org headers, none of which
 * belong to a generator. The hand-written API modules import the request and
 * response types from here so a backend change shows up as a type error
 * instead of a runtime surprise.
 */

export interface components {
  schemas: {
    /** Asked once; when `enabled` is false the UI hides AI entirely. */
    AIAvailabilityResponse: {
      enabled: boolean;
      reason_code?: string | null;
      reason?: string | null;
      used_today: number;
      daily_quota: number;
    };
    AIDecisionRequest: {
      accepted: boolean;
    };
    /** The organisation-wide switch, admin only. Absent in storage means OFF: AI stays dark until an administrator deliberately turns it on. */
    AIOrgSettingsRequest: {
      ai_enabled: boolean;
    };
    /** The person's own off-switch. True = don't offer me AI. */
    AIUserSettingsRequest: {
      ai_opt_out: boolean;
    };
    /** What the author accepted. `start`/`end` identify WHICH stored detection this is; they are matched against the server's own copy and a span that was never proposed is ignored. Only the label, key and type may be edited in review. */
    AcceptedDetection: {
      start: number;
      end: number;
      key?: string | null;
      label?: string | null;
      type?: string | null;
    };
    ApprovalStepResponse: {
      id: string;
      instance_id: string;
      stage_id: string;
      document_version_id: string;
      approver_id: string;
      decision: string;
      decision_note: string | null;
      decided_at: string | null;
      due_at: string | null;
      escalated_at: string | null;
      round_number: number;
      created_at: string;
      stage_name?: string | null;
      approver_name?: string | null;
      approver_email?: string | null;
      document_id?: string | null;
      document_title?: string | null;
      document_public_id?: string | null;
      submitted_by?: string | null;
      submitter_name?: string | null;
      revoked_at?: string | null;
      revocation_reason?: string | null;
      superseded_at?: string | null;
    };
    ApprovalStepSummary: {
      id: string;
      stage_id: string;
      stage_name?: string | null;
      approver_id: string;
      approver_name?: string | null;
      decision: string;
      decided_at: string | null;
      due_at: string | null;
      round_number: number;
    };
    AskRequest: {
      question: string;
      conversation_id?: string | null;
    };
    AttachmentCreateRequest: {
      file_asset_id: string;
      label?: string | null;
    };
    AttachmentResponse: {
      id: string;
      document_id: string;
      file_asset_id: string;
      label: string | null;
      attached_by: string;
      attacher_name?: string | null;
      filename: string;
      mime_type: string;
      size_bytes: number;
      preview_url: string | null;
      created_at: string;
    };
    AuditLogEntry: {
      id: string;
      actor_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string;
      instance_id: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      created_at: string;
    };
    AuditLogListResponse: {
      items: components['schemas']["AuditLogEntry"][];
      total: number;
    };
    BlankDetectRequest: {
      document_text: string;
      template_id?: string | null;
    };
    BlankDetectResponse: {
      interaction_id: string;
      blanks: components['schemas']["DetectedBlank"][];
      truncated: boolean;
    };
    Body_ai_generate_draft_api_v1_documents_ai_draft_post: {
      instructions: string;
      doc_type_id?: string | null;
      template_id?: string | null;
      title?: string | null;
      save?: boolean;
      files?: string[] | null;
    };
    Body_ai_suggest_document_type_api_v1_documents_ai_suggest_type_post: {
      instructions: string;
    };
    Body_upload_knowledge_api_v1_agent_knowledge_post: {
      file: string;
      title: string;
      category?: string | null;
      version_label?: string | null;
      effective_date?: string | null;
      review_due_at?: string | null;
      replaces_source_id?: string | null;
    };
    CancelWorkflowRequest: {
      reason?: string | null;
    };
    /** PUT /auth/password — change own password. */
    ChangePasswordRequest: {
      current_password: string;
      new_password: string;
    };
    ChatMessageResponse: {
      id: string;
      conversation_id: string;
      sender_id: string;
      body: string;
      attachment_ids?: unknown[];
      created_at: string;
      edited_at?: string | null;
      sender_name?: string | null;
      sender_avatar_url?: string | null;
    };
    CommentCreateRequest: {
      body: string;
      parent_id?: string | null;
      is_internal?: boolean;
      mention_user_ids?: string[];
    };
    CommentResponse: {
      id: string;
      document_id: string;
      parent_id: string | null;
      body: string;
      author_id: string;
      author_name?: string | null;
      author_email?: string | null;
      author_avatar?: string | null;
      is_internal: boolean;
      resolved_at: string | null;
      created_at: string;
      updated_at: string;
      replies?: components['schemas']["CommentResponse"][];
      mentions?: components['schemas']["MentionResponse"][];
    };
    CommentUpdateRequest: {
      body?: string | null;
      is_resolved?: boolean | null;
    };
    /** `before` is the text immediately in front of the cursor and nothing else: not the paragraph after it, and never the whole body. */
    CompleteRequest: {
      before: string;
      template_id?: string | null;
      document_id?: string | null;
    };
    CompleteResponse: {
      interaction_id: string;
      text: string;
    };
    ConfirmUploadRequest: {
      /** storage_key returned by /upload-url */
      storage_key: string;
      bucket: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
    };
    ConfirmUploadResponse: {
      file_asset_id: string;
      scan_status: string;
      scan_label: string;
      scan_detail?: string | null;
      macros_removed?: boolean;
    };
    ConversationListResponse: {
      items: components['schemas']["ConversationResponse"][];
      total: number;
      page: number;
      limit: number;
    };
    ConversationParticipantResponse: {
      user_id: string;
      joined_at: string;
      last_read_at?: string | null;
      user_name?: string | null;
      user_email?: string | null;
      user_avatar_url?: string | null;
    };
    ConversationResponse: {
      id: string;
      kind: string;
      title: string | null;
      workflow_instance_id: string | null;
      approval_step_id: string | null;
      created_by: string;
      created_at: string;
      participants?: components['schemas']["ConversationParticipantResponse"][];
      last_message_body?: string | null;
      last_message_at?: string | null;
      unread_count?: number;
    };
    DashboardStatsResponse: {
      documents_submitted: number;
      documents_approved: number;
      documents_rejected: number;
      avg_approval_time_hours: number;
      sla_breach_rate: number;
      pending_approvals: number;
      trend_data: Record<string, unknown>[];
    };
    /** Request body for POST /approvals/{step_id}/decision decision values: 'approved' — approve this step; advance workflow 'rejected' — blocking rejection; close workflow 'changes_requested' — send back to creator; open chat; stay at this stage */
    DecisionRequest: {
      /** 'approved' | 'rejected' | 'changes_requested' */
      decision: string;
      note?: string | null;
      signature?: components['schemas']["ESignatureRequest"] | null;
    };
    /** Request body for POST /approvals/{step_id}/delegate */
    DelegateRequest: {
      delegate_user_id: string;
      reason?: string | null;
      ends_at?: string | null;
    };
    DepartmentCreateRequest: {
      name: string;
      code?: string | null;
      parent_id?: string | null;
      head_user_id?: string | null;
    };
    DepartmentResponse: {
      id: string;
      org_id: string;
      parent_id: string | null;
      name: string;
      code: string | null;
      head_user_id: string | null;
      created_at: string;
      children?: components['schemas']["DepartmentResponse"][];
    };
    DepartmentUpdateRequest: {
      name?: string | null;
      code?: string | null;
      parent_id?: string | null;
      head_user_id?: string | null;
    };
    /** The live editor body. Sent rather than read from the row so the author can detect blanks in text they have typed but not yet autosaved. */
    DetectBlanksRequest: {
      content?: Record<string, unknown>;
    };
    /** The body rewritten with placeholder nodes in place, plus what was found. */
    DetectBlanksResponse: {
      content: Record<string, unknown>;
      found: number;
      skipped?: components['schemas']["SkippedBlank"][];
      fields?: components['schemas']["DetectedField"][];
    };
    DetectedBlank: {
      snippet: string;
      label: string;
      key: string;
      type: string;
      confidence: "high" | "medium" | "low";
    };
    DetectedField: {
      key: string;
      label: string;
      type: string;
    };
    /** One proposed blank (FR-9.3). */
    DetectionOut: {
      start: number;
      end: number;
      original: string;
      key: string;
      label: string;
      type: string;
      confidence: string;
      reason: string;
      source: string;
    };
    /** Optional device fingerprint — stored on Session for audit. */
    DeviceInfo: {
      user_agent?: string | null;
      platform?: string | null;
      browser?: string | null;
    };
    /** Editable body of a document (spec §9 DocumentContent). */
    DocumentContentResponse: {
      document_id: string;
      content?: Record<string, unknown>;
      answers?: Record<string, unknown>;
      rendered_snapshot_url?: string | null;
      pdf_url?: string | null;
      updated_at?: string | null;
    };
    /** Autosave for the freeform editor / template answers. Partial is fine. */
    DocumentContentUpdateRequest: {
      content?: Record<string, unknown> | null;
      answers?: Record<string, unknown> | null;
    };
    DocumentCreateRequest: {
      doc_type_id: string;
      title: string;
      /** low, normal, high, urgent */
      priority?: string;
      tags?: string[];
      form_data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      dept_id?: string | null;
      due_at?: string | null;
      /** If true, sets status to submitted instead of draft */
      submit_immediately?: boolean;
      /** template | blank | upload */
      source?: string | null;
      /** public | internal | confidential */
      confidentiality?: string | null;
      /** Wizard/editor step to resume at */
      current_step?: string | null;
      /** Template Studio template to fill */
      template_id?: string | null;
    };
    /** One question in the pinned template version (spec §21.2). */
    DocumentFillFieldSchema: {
      key: string;
      label: string;
      type?: string;
      required?: boolean;
      help_text?: string | null;
      example?: string | null;
      default_value?: unknown | null;
      validation?: Record<string, unknown>;
      format?: string | null;
      options?: unknown[];
      if_empty_behavior?: string;
      order_index?: number;
      section?: string | null;
    };
    /** Everything Form Fill needs, read from the version the document is PINNED to (FR-12.x / C9) rather than from the template's current state — so editing, archiving or deleting the template cannot change a document being filled. */
    DocumentFillSchemaResponse: {
      document_id?: string | null;
      template_id?: string | null;
      template_version_id?: string | null;
      template_name?: string | null;
      version_no?: number | null;
      content?: Record<string, unknown>;
      fields?: components['schemas']["DocumentFillFieldSchema"][];
      answers?: Record<string, unknown>;
      template_deleted?: boolean;
    };
    /** FR-13.8 — state of the frozen snapshot's PDF. `status`: None (never requested) | 'pending' | 'ready' | 'failed'. `download_url` is a short-lived presigned URL, present only when ready. `checksum` is the SHA-256 of the PDF bytes; because rendering is deterministic, re-rendering the same snapshot reproduces it, so the artefact can be proven to match what was submitted. `available` is False when the deployment has not applied the migration that adds these columns, letting the UI stay silent rather than show a control that cannot work. */
    DocumentPDFStateResponse: {
      status?: string | null;
      checksum?: string | null;
      rendered_at?: string | null;
      error?: string | null;
      download_url?: string | null;
      available?: boolean;
      has_snapshot?: boolean;
    };
    DocumentResponse: {
      id: string;
      org_id: string;
      doc_type_id: string;
      doc_type_name: string;
      doc_type_code: string;
      dept_id: string | null;
      public_id: string;
      title: string;
      status: components['schemas']["DocumentStatus"];
      priority: string;
      tags: string[];
      form_data: Record<string, unknown>;
      metadata: Record<string, unknown>;
      submitted_by: string;
      submitter_name?: string | null;
      submitter_email?: string | null;
      submitted_at: string | null;
      due_at: string | null;
      created_at: string;
      updated_at: string;
      source?: string;
      confidentiality?: string | null;
      current_step?: string | null;
      template_version_id?: string | null;
      version?: number;
      category?: string | null;
      effective_from?: string | null;
      expires_at?: string | null;
      reminder_days_before?: number | null;
      reminder_sent_at?: string | null;
      watcher_count?: number;
      attachment_count?: number;
      comment_count?: number;
      version_count?: number;
      current_approval_step_id?: string | null;
      current_workflow_instance_id?: string | null;
    };
    /** Document lifecycle states. Requirements report §5.5 asks for: Draft, Ready for Submission, In Approval, Changes Requested, Approved, Rejected, Revoked/Returned for Correction, and Closed/Finalized. Mapping to this enum: Draft → DRAFT Ready for Submission → READY In Approval → PENDING (SUBMITTED is the transient "handed to the workflow engine" state) Changes Requested → SENT_BACK Approved → APPROVED Rejected → REJECTED Revoked/Returned for Corr. → REVOKED Closed/Finalized → FINALIZED The `status` column is VARCHAR(50) (not a native Postgres enum type — see alembic/versions/..._workflow_approvals_phase2_gaps.py's own docstring), so adding values here needs no migration. */
    DocumentStatus: "draft" | "ready" | "submitted" | "pending" | "approved" | "rejected" | "sent_back" | "revoked" | "finalized" | "archived" | "expired" | "cancelled";
    DocumentSubmitRequest: {
      /** Version reason */
      change_reason?: string | null;
      /** Which WorkflowTemplate to start. If omitted, the DocumentType's default template is used. If neither is configured, submit returns 422. */
      workflow_template_id?: string | null;
    };
    DocumentTemplateCreateRequest: {
      name: string;
      default_field_values?: Record<string, unknown>;
    };
    DocumentTemplateResponse: {
      id: string;
      org_id: string;
      doc_type_id: string;
      name: string;
      default_field_values: Record<string, unknown>;
      created_by: string;
      created_at: string;
      updated_at: string;
    };
    DocumentTypeCreateRequest: {
      name: string;
      code: string;
      description?: string | null;
      category?: string | null;
      icon?: string | null;
      color?: string | null;
      form_schema?: components['schemas']["FormFieldSchema"][];
      metadata_schema?: Record<string, unknown>;
      retention_days?: number | null;
    };
    DocumentTypeResponse: {
      id: string;
      org_id: string;
      name: string;
      code: string;
      description: string | null;
      category: string | null;
      icon: string | null;
      color: string | null;
      form_schema: components['schemas']["FormFieldSchema"][];
      metadata_schema: Record<string, unknown>;
      is_active: boolean;
      retention_days: number | null;
      created_at: string;
      updated_at: string;
    };
    DocumentTypeUpdateRequest: {
      name?: string | null;
      code?: string | null;
      description?: string | null;
      category?: string | null;
      icon?: string | null;
      color?: string | null;
      form_schema?: components['schemas']["FormFieldSchema"][] | null;
      metadata_schema?: Record<string, unknown> | null;
      is_active?: boolean | null;
      retention_days?: number | null;
    };
    DocumentUpdateRequest: {
      title?: string | null;
      priority?: string | null;
      tags?: string[] | null;
      form_data?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
      dept_id?: string | null;
      due_at?: string | null;
      confidentiality?: string | null;
      current_step?: string | null;
      /** Reason for version history */
      change_reason?: string | null;
      category?: string | null;
      effective_from?: string | null;
      expires_at?: string | null;
      reminder_days_before?: number | null;
      /** Detail fields to null out: effective_from, expires_at, reminder_days_before, category */
      clear_fields?: string[] | null;
    };
    DocumentVersionResponse: {
      id: string;
      document_id: string;
      version_num: number;
      title: string;
      form_data: Record<string, unknown>;
      changed_by: string;
      changer_name?: string | null;
      change_reason: string | null;
      created_at: string;
    };
    DownloadURLResponse: {
      download_url: string;
      storage_key: string;
    };
    /** `instruction` is the author's own words. `context` is the paragraph before the cursor and nothing more — the body is never sent. */
    DraftRequest: {
      instruction: string;
      context?: string;
      template_id?: string | null;
      document_id?: string | null;
    };
    DraftResponse: {
      interaction_id: string;
      text: string;
      note?: string | null;
      confidence: string;
    };
    ESignatureRequest: {
      /** 'drawn' | 'typed' | 'click_to_sign' | 'provider_docusign' */
      signature_method: string;
      /** SHA-256 hash of the signed document */
      signed_hash: string;
      provider_reference?: string | null;
    };
    /** POST /auth/login — email + password login. */
    EmailLoginRequest: {
      email: string;
      password: string;
      device_info?: components['schemas']["DeviceInfo"] | null;
    };
    FeedbackRequest: {
      vote: string;
      note?: string | null;
    };
    /** One blocked (or flagged) field, in the shape the UI points at. */
    FieldProblemSchema: {
      field: string;
      code: string;
      message: string;
    };
    FieldSuggestRequest: {
      /** Text before the blank */
      before?: string;
      /** Text after the blank */
      after?: string;
      existing_keys?: string[];
      template_id?: string | null;
    };
    FieldSuggestResponse: {
      interaction_id: string;
      label: string;
      key: string;
      type: string;
      confidence: "high" | "medium" | "low";
    };
    /** POST /auth/firebase-login — exchange Firebase ID token for DocFlow JWT. */
    FirebaseLoginRequest: {
      /** Firebase ID token from client SDK */
      id_token: string;
      device_info?: components['schemas']["DeviceInfo"] | null;
    };
    FormFieldSchema: {
      /** Unique field key in form_data JSONB */
      key: string;
      /** Display label for form rendering */
      label: string;
      /** Field type: 'text', 'number', 'date', 'select', 'textarea', 'checkbox' */
      type: string;
      required?: boolean;
      /** Options for 'select' field type */
      options?: string[] | null;
      placeholder?: string | null;
      default?: unknown | null;
    };
    HTTPValidationError: {
      detail?: components['schemas']["ValidationError"][];
    };
    ImportApplyRequest: {
      name: string;
      accepted: components['schemas']["AcceptedDetection"][];
    };
    /** Start an import from a file that has already been uploaded and scanned. */
    ImportCreateRequest: {
      file_asset_id: string;
      filename: string;
      mime_type?: string | null;
      use_llm?: boolean;
    };
    ImportJobResponse: {
      id: string;
      filename: string;
      source_kind: string;
      file_asset_id?: string | null;
      status: string;
      stage?: string | null;
      progress?: number;
      use_llm?: boolean;
      page_count?: number | null;
      char_count?: number | null;
      content?: Record<string, unknown> | null;
      text?: string;
      detections?: components['schemas']["DetectionOut"][];
      warnings?: string[];
      error?: string | null;
      template_id?: string | null;
      created_at: string;
    };
    /** Body for accepting a join request: the reviewer MUST choose the role. */
    JoinRequestAccept: {
      role_id: string;
    };
    JoinRequestCreate: {
      org_name: string;
    };
    JoinRequestStatusResponse: {
      org_name?: string | null;
      status?: string | null;
    };
    /** Response for successful login / register — access token + user context. `state` is the ONLY thing the frontend should route on: HAS_ORG -> org_membership is set; go to the dashboard PENDING_REQUEST -> show "waiting for approval"; pending_request is set NO_ORG -> show Create / Join organization These are normal outcomes, returned with HTTP 200 - never as errors. */
    LoginResponse: {
      access_token: string;
      token_type?: string;
      user: components['schemas']["UserResponse"];
      org_membership: components['schemas']["OrgMembershipResponse"] | null;
      state?: string;
      pending_request?: components['schemas']["PendingRequestInfo"] | null;
    };
    /** Response for GET /auth/me — full current user context. */
    MeResponse: {
      user: components['schemas']["UserResponse"];
      org_membership: components['schemas']["OrgMembershipResponse"] | null;
      sessions: components['schemas']["SessionInfo"][];
    };
    MemberInviteRequest: {
      email: string;
      name?: string | null;
      role_id: string;
      dept_id?: string | null;
      password: string;
    };
    MemberResponse: {
      id: string;
      org_id: string;
      user_id: string;
      role_id: string;
      dept_id: string | null;
      team_id: string | null;
      status: string;
      joined_at: string;
      user?: components['schemas']["MemberUserInfo"] | null;
      role?: components['schemas']["MemberRoleInfo"] | null;
    };
    MemberRoleInfo: {
      id: string;
      name: string;
      is_system: boolean;
    };
    MemberUpdateRequest: {
      role_id?: string | null;
      dept_id?: string | null;
      team_id?: string | null;
      status?: string | null;
    };
    MemberUserInfo: {
      id: string;
      email: string;
      name: string | null;
      avatar_url: string | null;
      status: string;
    };
    MentionResponse: {
      user_id: string;
      user_name?: string | null;
    };
    MultipartAbortRequest: {
      storage_key: string;
      bucket: string;
      upload_id: string;
    };
    MultipartCompleteRequest: {
      storage_key: string;
      bucket: string;
      upload_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number;
    };
    MultipartInitRequest: {
      filename: string;
      mime_type: string;
      size_bytes: number;
    };
    MultipartInitResponse: {
      upload_id: string;
      storage_key: string;
      bucket: string;
      part_size: number;
      part_count: number;
      part_urls: string[];
    };
    MultipartResumeResponse: {
      uploaded_parts: number[];
      part_size: number;
      part_count: number;
      part_urls: string[];
    };
    MultipartSessionRequest: {
      storage_key: string;
      bucket: string;
      upload_id: string;
      size_bytes: number;
    };
    MyApprovalsResponse: {
      items: components['schemas']["ApprovalStepResponse"][];
      total: number;
    };
    /** Org-level default notification channel preferences. */
    NotificationDefaults: {
      email?: boolean;
      sms?: boolean;
      push?: boolean;
      in_app?: boolean;
    };
    NotificationListResponse: {
      items: Record<string, unknown>[];
      total: number;
      unread_count: number;
    };
    /** User's membership in an organization, including resolved role + permissions. */
    OrgMembershipResponse: {
      org_id: string;
      user_id: string;
      role_id: string;
      role_name: string;
      dept_id: string | null;
      status: string;
      joined_at: string;
      organization: components['schemas']["OrganizationResponse"];
      permissions: string[];
    };
    OrgNameAvailability: {
      available: boolean;
      reason?: string;
    };
    OrgResponse: {
      id: string;
      name: string;
      slug: string;
      logo_url: string | null;
      plan: string;
      status: string;
      settings: Record<string, unknown>;
      industry?: string | null;
      timezone?: string | null;
      branding_primary_color?: string | null;
      branding_accent_color?: string | null;
      notification_defaults?: components['schemas']["NotificationDefaults"] | null;
      created_at: string;
    };
    OrgStatsResponse: {
      member_count: number;
      department_count: number;
      team_count: number;
      role_count: number;
      active_member_count: number;
    };
    OrgUpdateRequest: {
      name?: string | null;
      logo_url?: string | null;
      settings?: Record<string, unknown> | null;
      industry?: string | null;
      timezone?: string | null;
      branding_primary_color?: string | null;
      branding_accent_color?: string | null;
      notification_defaults?: components['schemas']["NotificationDefaults"] | null;
    };
    OrganizationResponse: {
      id: string;
      name: string;
      slug: string;
      logo_url: string | null;
      plan: string;
      status: string;
      created_at: string;
    };
    /** FR-1.4 / spec §25.1 — keyset (cursor) pagination. `next_cursor` is the forward-only cursor; null means "no more rows". `total` is a count of the whole filtered set and is only computed for a request with no cursor, because counting on every page of a 100k-row table is exactly the cost keyset pagination exists to avoid. On a cursor request it is echoed back as -1, meaning "not counted". */
    PaginatedDocumentsResponse: {
      items: components['schemas']["DocumentResponse"][];
      total: number;
      page: number;
      limit: number;
      pages: number;
      next_cursor?: string | null;
    };
    PaginatedMembersResponse: {
      items: components['schemas']["MemberResponse"][];
      total: number;
      page: number;
      limit: number;
      pages: number;
    };
    /** A join request the user has submitted and is awaiting a decision. */
    PendingRequestInfo: {
      org_name: string;
      requested_at?: string | null;
    };
    PermissionCatalogResponse: {
      permissions: components['schemas']["PermissionEntry"][];
      by_category: Record<string, string[]>;
    };
    PermissionEntry: {
      code: string;
      category: string;
      description?: string | null;
    };
    /** One blank in the content; several may share a field_key (spec §21.1). */
    PlaceholderOccurrenceSchema: {
      field_key: string;
      node_id: string;
      order_no?: number;
    };
    PublishIssue: {
      rule: string;
      field_key?: string | null;
      message: string;
    };
    /** POST /auth/register — create a new user account. */
    RegisterRequest: {
      email: string;
      name: string;
      password: string;
      /** If provided, creates a new organization and assigns user as admin */
      org_name?: string | null;
      device_info?: components['schemas']["DeviceInfo"] | null;
    };
    /** Request body for POST /approvals/recalls/{revocation_id}/resolve (§6.5). */
    ResolveRecallRequest: {
      /** True applies the recall (invalidating the recalled decision and affected downstream approvals, returning the document for correction); False denies it and the workflow continues. */
      approve: boolean;
      note?: string | null;
    };
    ReviewFinding: {
      severity: "high" | "medium" | "low";
      message: string;
      quote?: string | null;
      confidence: "high" | "medium" | "low";
    };
    ReviewRequest: {
      document_id?: string | null;
      document_text?: string | null;
    };
    ReviewResponse: {
      interaction_id: string;
      findings: components['schemas']["ReviewFinding"][];
      truncated: boolean;
    };
    /** Request body for POST /documents/{id}/revise-and-resume */
    ReviseAndResumeRequest: {
      /** UUID of the already-uploaded new DocumentVersion */
      new_version_id: string;
      /** Note explaining what was changed */
      note?: string | null;
    };
    /** Request body for POST /approvals/{step_id}/revoke (§6.5). A reason is REQUIRED — the revocation is preserved as a permanent audit event, and "add a correction comment" is part of the specified flow, so there is no such thing as an unexplained revocation. */
    RevokeRequest: {
      reason: string;
    };
    RewriteRequest: {
      passage: string;
      instruction?: string | null;
      document_id?: string | null;
    };
    RewriteResponse: {
      interaction_id: string;
      original: string;
      suggestion: string;
      note?: string | null;
      confidence: "high" | "medium" | "low";
      warning?: string | null;
    };
    RoleCatalogEntry: {
      name: string;
      description: string;
      permissions: string[];
    };
    RoleCreateRequest: {
      name: string;
      description?: string | null;
      permissions?: string[];
    };
    /** PUT /roles/{id}/permissions — replace full permission set. */
    RolePermissionsRequest: {
      /** List of permission codes to assign */
      permissions: string[];
    };
    RoleResponse: {
      id: string;
      org_id: string;
      name: string;
      description: string | null;
      is_system: boolean;
      permissions: string[];
      member_count?: number;
      created_at: string;
    };
    RoleUpdateRequest: {
      name?: string | null;
      description?: string | null;
    };
    /** FR-5.4 — turn an existing document into a reusable template. */
    SaveAsTemplateRequest: {
      name?: string | null;
      description?: string | null;
      category?: string | null;
    };
    /** REST fallback for sending a message (WebSocket is the primary path). */
    SendMessageRequest: {
      body: string;
      attachment_ids?: string[];
    };
    /** A single active session — returned in /auth/sessions and /auth/me. */
    SessionInfo: {
      id: string;
      device_info: Record<string, unknown> | null;
      ip_address: string | null;
      created_at: string;
      expires_at: string;
      is_current?: boolean;
    };
    SkippedBlank: {
      original: string;
      reason: string;
    };
    StageApproverRuleCreate: {
      /** 'specific_user' | 'role_in_department' | 'manager_of_requester' */
      rule_type: string;
      rule_value?: Record<string, unknown>;
    };
    StageApproverRuleResponse: {
      id: string;
      stage_id: string;
      rule_type: string;
      rule_value: Record<string, unknown>;
      created_at: string;
    };
    /** POST /chat/conversations — start a conversation. For kind='direct': participant_user_id is required. For kind='workflow_context': approval_step_id is required (idempotent — returns existing conversation if one exists for this step). */
    StartConversationRequest: {
      /** 'direct' | 'workflow_context' */
      kind?: string;
      /** The other user to DM (required for kind='direct') */
      participant_user_id?: string | null;
      /** The approval step that triggered this context chat (required for kind='workflow_context') */
      approval_step_id?: string | null;
      participant_ids?: string[];
      title?: string | null;
      initial_message?: string | null;
    };
    /** FR-13.5 — ask for a title/description/priority for a document. */
    SubmissionDetailsRequest: {
      document_id: string;
    };
    SubmissionDetailsResponse: {
      interaction_id: string;
      title?: string | null;
      description?: string | null;
      priority?: string | null;
      reason?: string | null;
      confidence?: string;
    };
    /** Ask whether a draft may move past `stage`. 'write' checks the document body only; each later stage includes the ones before it, so 'confirm' is the whole submission. The workflow id is the one currently selected in the wizard, which may not be saved yet. */
    SubmitCheckRequest: {
      /** write | workflow | details | confirm */
      stage?: string;
      workflow_template_id?: string | null;
    };
    /** `ok` is false when anything blocks. Warnings never block. */
    SubmitCheckResponse: {
      ok: boolean;
      errors?: components['schemas']["FieldProblemSchema"][];
      warnings?: components['schemas']["FieldProblemSchema"][];
    };
    /** POST /users/me/sync — sync Firebase user to DocFlow backend profile. */
    SyncUserRequest: {
      name?: string | null;
      /** If provided and user has no org, creates a new organisation and assigns user as admin. */
      org_name?: string | null;
      /** Profile picture URL from Firebase (Google/Microsoft). */
      avatar_url?: string | null;
    };
    /** Response from POST /users/me/sync. */
    SyncUserResponse: {
      user: components['schemas']["UserResponse"];
      org_membership: components['schemas']["OrgMembershipResponse"] | null;
      state?: string;
      pending_request?: components['schemas']["PendingRequestInfo"] | null;
    };
    TeamCreateRequest: {
      name: string;
      dept_id?: string | null;
    };
    TeamResponse: {
      id: string;
      org_id: string;
      dept_id: string | null;
      name: string;
      created_at: string;
    };
    TeamUpdateRequest: {
      name?: string | null;
      dept_id?: string | null;
    };
    TemplateCreateRequest: {
      name?: string;
      description?: string | null;
      category?: string | null;
      tags?: string[];
      icon?: string | null;
      color?: string | null;
      /** user | system (system requires admin) */
      scope?: string;
    };
    TemplateDetailResponse: {
      id: string;
      org_id: string;
      owner_id: string | null;
      scope: string;
      name: string;
      description: string | null;
      category: string | null;
      tags: string[];
      icon: string | null;
      color: string | null;
      status: string;
      usage_count: number;
      field_count?: number;
      version_no?: number | null;
      is_owner?: boolean;
      is_favourite?: boolean;
      created_at: string;
      updated_at: string;
      version_id?: string | null;
      content?: Record<string, unknown>;
      page_settings?: Record<string, unknown>;
      fields?: components['schemas']["TemplateFieldSchema"][];
      placeholders?: components['schemas']["PlaceholderOccurrenceSchema"][];
    };
    TemplateFieldSchema: {
      /** lower_snake_case field key */
      key: string;
      /** Question shown to the person filling it in */
      label: string;
      type?: string;
      required?: boolean;
      help_text?: string | null;
      example?: string | null;
      default_value?: unknown | null;
      validation?: Record<string, unknown>;
      format?: string | null;
      options?: unknown[];
      /** keep_blank | remove_phrase */
      if_empty_behavior?: string;
      order_index?: number;
      section?: string | null;
    };
    /** Metadata captured at publish time (FR-11.3). */
    TemplatePublishRequest: {
      name?: string | null;
      description?: string | null;
      category?: string | null;
      tags?: string[] | null;
      icon?: string | null;
      color?: string | null;
    };
    TemplateReviewResponse: {
      id: string;
      name: string;
      description: string | null;
      stages: components['schemas']["TemplateReviewStage"][];
    };
    TemplateReviewStage: {
      name: string;
      sequence_order: number;
      approver_summary: string;
      sla_hours: number | null;
      requires_signature: boolean;
    };
    TemplateSummaryResponse: {
      id: string;
      org_id: string;
      owner_id: string | null;
      scope: string;
      name: string;
      description: string | null;
      category: string | null;
      tags: string[];
      icon: string | null;
      color: string | null;
      status: string;
      usage_count: number;
      field_count?: number;
      version_no?: number | null;
      is_owner?: boolean;
      is_favourite?: boolean;
      created_at: string;
      updated_at: string;
    };
    /** Autosave payload — any subset. Draft data may be partial/invalid (FR-14.4). */
    TemplateUpdateRequest: {
      name?: string | null;
      description?: string | null;
      category?: string | null;
      tags?: string[] | null;
      icon?: string | null;
      color?: string | null;
      content?: Record<string, unknown> | null;
      page_settings?: Record<string, unknown> | null;
      fields?: components['schemas']["TemplateFieldSchema"][] | null;
      placeholders?: components['schemas']["PlaceholderOccurrenceSchema"][] | null;
    };
    /** One entry in a template's version history (FR-14.8). */
    TemplateVersionSummary: {
      id: string;
      version_no: number;
      is_published: boolean;
      is_current: boolean;
      field_count: number;
      published_at?: string | null;
      created_at: string;
    };
    /** Response for POST /auth/refresh — new short-lived access token. */
    TokenRefreshResponse: {
      access_token: string;
      token_type?: string;
    };
    /** PATCH /auth/me — update own profile fields. */
    UpdateProfileRequest: {
      name?: string | null;
      avatar_url?: string | null;
      notification_prefs?: Record<string, unknown> | null;
    };
    UploadURLRequest: {
      /** Original filename */
      filename: string;
      /** MIME type of the file to be uploaded */
      mime_type: string;
      /** Size of file in bytes */
      size_bytes: number;
    };
    UploadURLResponse: {
      upload_url: string;
      storage_key: string;
      bucket: string;
    };
    /** User data returned in auth responses and /auth/me. */
    UserResponse: {
      id: string;
      email: string;
      name: string | null;
      avatar_url: string | null;
      is_superadmin: boolean;
      status: string;
      last_seen_at: string | null;
      notification_prefs: Record<string, unknown>;
      created_at: string;
    };
    ValidationError: {
      loc: (string | number)[];
      msg: string;
      type: string;
    };
    WatcherAddRequest: {
      user_id: string;
    };
    /** A colleague who can be added as a watcher. Deliberately only id/name/email: this endpoint is open to any member who can open the document, so it must not become a way to read the org's roles, departments or activity. */
    WatcherCandidateResponse: {
      user_id: string;
      name?: string | null;
      email?: string | null;
    };
    /** Someone CC'd on a document (FR-13.4). */
    WatcherResponse: {
      id: string;
      user_id: string;
      name?: string | null;
      email?: string | null;
      added_by: string;
      added_by_name?: string | null;
      created_at: string;
    };
    WorkflowInstanceResponse: {
      id: string;
      document_id: string;
      template_id: string | null;
      status: string;
      current_stage_id: string | null;
      submitted_at: string;
      completed_at: string | null;
      approval_steps?: components['schemas']["ApprovalStepSummary"][];
      created_at: string;
    };
    WorkflowStageCreate: {
      name: string;
      sequence_order: number;
      /** 'sequential' | 'parallel' | 'conditional' */
      stage_type?: string;
      min_approvals_required?: number;
      sla_hours?: number | null;
      reapproval_on_revision?: boolean;
      /** If True, the Approve decision on this stage requires a digital e-signature. */
      requires_signature?: boolean;
      approver_rules?: components['schemas']["StageApproverRuleCreate"][];
    };
    WorkflowStageResponse: {
      id: string;
      template_id: string;
      name: string;
      sequence_order: number;
      stage_type: string;
      min_approvals_required: number;
      sla_hours: number | null;
      reapproval_on_revision: boolean;
      requires_signature: boolean;
      approver_rules?: components['schemas']["StageApproverRuleResponse"][];
      created_at: string;
    };
    WorkflowTemplateCreate: {
      name: string;
      description?: string | null;
      department_id?: string | null;
      doc_type_id?: string | null;
      document_type_scope?: string | null;
      is_active?: boolean;
      stages?: components['schemas']["WorkflowStageCreate"][];
    };
    WorkflowTemplateResponse: {
      id: string;
      org_id: string;
      name: string;
      description: string | null;
      department_id: string | null;
      doc_type_id: string | null;
      document_type_scope: string | null;
      is_active: boolean;
      version: number;
      stages?: components['schemas']["WorkflowStageResponse"][];
      created_at: string;
      updated_at?: string | null;
      created_by?: string | null;
      visibility?: string;
    };
    /** Lightweight response — no stages included. */
    WorkflowTemplateSummary: {
      id: string;
      name: string;
      description?: string | null;
      department_id: string | null;
      doc_type_id?: string | null;
      is_active: boolean;
      version: number;
      created_at: string;
      created_by?: string | null;
      visibility?: string;
    };
    WorkflowTemplateUpdate: {
      name?: string | null;
      description?: string | null;
      department_id?: string | null;
      document_type_scope?: string | null;
      is_active?: boolean | null;
    };
    /** Generic success message response. */
    app__schemas__auth__MessageResponse: {
      message: string;
    };
    app__schemas__org__MessageResponse: {
      message: string;
    };
  };
}

export interface paths {
  "/health": {
    /** Health check */
    get: {
      response: unknown;
    };
  };
  "/health/live": {
    /** Liveness probe (DB + Redis) */
    get: {
      response: unknown;
    };
  };
  "/api/v1/auth/firebase-login": {
    /** Firebase Login */
    post: {
      body: components['schemas']["FirebaseLoginRequest"];
      response: components['schemas']["LoginResponse"];
    };
  };
  "/api/v1/auth/login": {
    /** Email Login */
    post: {
      body: components['schemas']["EmailLoginRequest"];
      response: components['schemas']["LoginResponse"];
    };
  };
  "/api/v1/auth/register": {
    /** Register */
    post: {
      body: components['schemas']["RegisterRequest"];
      response: components['schemas']["LoginResponse"];
    };
  };
  "/api/v1/auth/refresh": {
    /** Refresh Token */
    post: {
      response: components['schemas']["TokenRefreshResponse"];
    };
  };
  "/api/v1/auth/logout": {
    /** Logout */
    post: {
      response: components['schemas']["app__schemas__auth__MessageResponse"];
    };
  };
  "/api/v1/auth/logout-all": {
    /** Logout All */
    post: {
      response: components['schemas']["app__schemas__auth__MessageResponse"];
    };
  };
  "/api/v1/auth/me": {
    /** Get Me */
    get: {
      response: components['schemas']["MeResponse"];
    };
    /** Update Profile */
    patch: {
      body: components['schemas']["UpdateProfileRequest"];
      response: components['schemas']["UserResponse"];
    };
  };
  "/api/v1/auth/password": {
    /** Change Password */
    put: {
      body: components['schemas']["ChangePasswordRequest"];
      response: components['schemas']["app__schemas__auth__MessageResponse"];
    };
  };
  "/api/v1/auth/sessions": {
    /** List Sessions */
    get: {
      response: components['schemas']["SessionInfo"][];
    };
  };
  "/api/v1/auth/sessions/{session_id}": {
    /** Revoke Session */
    delete: {
      path: {
        session_id: string;
      };
      response: components['schemas']["app__schemas__auth__MessageResponse"];
    };
  };
  "/api/v1/users/me/sync": {
    /** Sync User */
    post: {
      body: components['schemas']["SyncUserRequest"];
      response: components['schemas']["SyncUserResponse"];
    };
  };
  "/api/v1/orgs/me": {
    /** Get My Org */
    get: {
      response: components['schemas']["OrgResponse"];
    };
    /** Update My Org */
    patch: {
      body: components['schemas']["OrgUpdateRequest"];
      response: components['schemas']["OrgResponse"];
    };
  };
  "/api/v1/orgs/me/stats": {
    /** Get Org Stats */
    get: {
      response: components['schemas']["OrgStatsResponse"];
    };
  };
  "/api/v1/orgs/me/departments": {
    /** List Departments */
    get: {
      query: {
        flat?: boolean;
      };
      response: components['schemas']["DepartmentResponse"][];
    };
    /** Create Department */
    post: {
      body: components['schemas']["DepartmentCreateRequest"];
      response: components['schemas']["DepartmentResponse"];
    };
  };
  "/api/v1/orgs/me/departments/{dept_id}": {
    /** Delete Department */
    delete: {
      path: {
        dept_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Department */
    patch: {
      path: {
        dept_id: string;
      };
      body: components['schemas']["DepartmentUpdateRequest"];
      response: components['schemas']["DepartmentResponse"];
    };
  };
  "/api/v1/orgs/me/teams": {
    /** List Teams */
    get: {
      response: components['schemas']["TeamResponse"][];
    };
    /** Create Team */
    post: {
      body: components['schemas']["TeamCreateRequest"];
      response: components['schemas']["TeamResponse"];
    };
  };
  "/api/v1/orgs/me/teams/{team_id}": {
    /** Delete Team */
    delete: {
      path: {
        team_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Team */
    patch: {
      path: {
        team_id: string;
      };
      body: components['schemas']["TeamUpdateRequest"];
      response: components['schemas']["TeamResponse"];
    };
  };
  "/api/v1/orgs/me/roles": {
    /** List Roles */
    get: {
      response: components['schemas']["RoleResponse"][];
    };
    /** Create Role */
    post: {
      body: components['schemas']["RoleCreateRequest"];
      response: components['schemas']["RoleResponse"];
    };
  };
  "/api/v1/orgs/me/roles/{role_id}": {
    /** Delete Role */
    delete: {
      path: {
        role_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Role */
    patch: {
      path: {
        role_id: string;
      };
      body: components['schemas']["RoleUpdateRequest"];
      response: components['schemas']["RoleResponse"];
    };
  };
  "/api/v1/orgs/me/roles/{role_id}/permissions": {
    /** Set Role Permissions */
    put: {
      path: {
        role_id: string;
      };
      body: components['schemas']["RolePermissionsRequest"];
      response: components['schemas']["RoleResponse"];
    };
  };
  "/api/v1/orgs/me/permissions": {
    /** Get Permission Catalog */
    get: {
      response: components['schemas']["PermissionCatalogResponse"];
    };
  };
  "/api/v1/orgs/me/members": {
    /** List Members */
    get: {
      query: {
        page?: number;
        limit?: number;
        search?: string | null;
        role_id?: string | null;
        dept_id?: string | null;
        status?: string | null;
      };
      response: components['schemas']["PaginatedMembersResponse"];
    };
  };
  "/api/v1/orgs/me/members/invite": {
    /** Invite Member */
    post: {
      body: components['schemas']["MemberInviteRequest"];
      response: components['schemas']["MemberResponse"];
    };
  };
  "/api/v1/orgs/me/members/{member_id}": {
    /** Remove Member */
    delete: {
      path: {
        member_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Member */
    patch: {
      path: {
        member_id: string;
      };
      body: components['schemas']["MemberUpdateRequest"];
      response: components['schemas']["MemberResponse"];
    };
  };
  "/api/v1/orgs/join-requests": {
    /** Create Join Request */
    post: {
      body: components['schemas']["JoinRequestCreate"];
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
  };
  "/api/v1/orgs/availability": {
    /** Check Org Name Availability */
    get: {
      query: {
        name: string;
      };
      response: components['schemas']["OrgNameAvailability"];
    };
  };
  "/api/v1/orgs/search": {
    /** Search Organizations */
    get: {
      query: {
        q: string;
      };
      response: string[];
    };
  };
  "/api/v1/orgs/me/join-requests": {
    /** List Pending Join Requests */
    get: {
      response: Record<string, unknown>[];
    };
  };
  "/api/v1/orgs/me/join-requests/{request_id}/accept": {
    /** Accept Join Request */
    post: {
      path: {
        request_id: string;
      };
      body: components['schemas']["JoinRequestAccept"];
      response: Record<string, unknown>;
    };
  };
  "/api/v1/orgs/me/join-requests/{request_id}/reject": {
    /** Reject Join Request */
    post: {
      path: {
        request_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/orgs/join-requests/mine": {
    /** Get My Join Request */
    get: {
      response: components['schemas']["JoinRequestStatusResponse"];
    };
  };
  "/api/v1/document-types": {
    /** List Document Types */
    get: {
      query: {
        active_only?: boolean;
      };
      response: components['schemas']["DocumentTypeResponse"][];
    };
    /** Create Document Type */
    post: {
      body: components['schemas']["DocumentTypeCreateRequest"];
      response: components['schemas']["DocumentTypeResponse"];
    };
  };
  "/api/v1/document-types/{type_id}": {
    /** Get Document Type */
    get: {
      path: {
        type_id: string;
      };
      response: components['schemas']["DocumentTypeResponse"];
    };
    /** Delete Document Type */
    delete: {
      path: {
        type_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Document Type */
    patch: {
      path: {
        type_id: string;
      };
      body: components['schemas']["DocumentTypeUpdateRequest"];
      response: components['schemas']["DocumentTypeResponse"];
    };
  };
  "/api/v1/document-types/templates": {
    /** Create Document Template */
    post: {
      query: {
        doc_type_id: string;
      };
      body: components['schemas']["DocumentTemplateCreateRequest"];
      response: components['schemas']["DocumentTemplateResponse"];
    };
  };
  "/api/v1/documents/ai/suggest-type": {
    /** Identify the likely document type and template for a description */
    post: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/documents/ai/draft": {
    /** Generate an AI-assisted document draft (saved as a draft for review) */
    post: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/documents/analytics": {
    /** Get Documents Analytics */
    get: {
      response: Record<string, number>;
    };
  };
  "/api/v1/documents": {
    /** List Documents */
    get: {
      query: {
        page?: number;
        limit?: number;
        status?: string | null;
        doc_type_id?: string | null;
        dept_id?: string | null;
        submitted_by?: string | null;
        search?: string | null;
        tags?: string[] | null;
        priority?: string | null;
        date_from?: string | null;
        date_to?: string | null;
        sort?: string | null;
        workflow_template_id?: string | null;
        cursor?: string | null;
      };
      response: components['schemas']["PaginatedDocumentsResponse"];
    };
    /** Create Document */
    post: {
      body: components['schemas']["DocumentCreateRequest"];
      response: components['schemas']["DocumentResponse"];
    };
  };
  "/api/v1/documents/from-template/{template_id}": {
    /** Create Document From Template */
    post: {
      path: {
        template_id: string;
      };
      body: components['schemas']["DocumentCreateRequest"];
      response: components['schemas']["DocumentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}": {
    /** Get Document */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentResponse"];
    };
    /** Delete Document */
    delete: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Document */
    patch: {
      path: {
        doc_id: string;
      };
      header: {
        "If-Match"?: string | null;
      };
      body: components['schemas']["DocumentUpdateRequest"];
      response: components['schemas']["DocumentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/submit-check": {
    /** Check Document Submission */
    post: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["SubmitCheckRequest"];
      response: components['schemas']["SubmitCheckResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/submit": {
    /** Submit Document */
    post: {
      path: {
        doc_id: string;
      };
      header: {
        "Idempotency-Key"?: string | null;
      };
      body: components['schemas']["DocumentSubmitRequest"];
      response: components['schemas']["DocumentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/content": {
    /** Get Document Content */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentContentResponse"];
    };
    /** Update Document Content */
    patch: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["DocumentContentUpdateRequest"];
      response: components['schemas']["DocumentContentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/fill-schema": {
    /** Get Document Fill Schema */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentFillSchemaResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/export": {
    /** Export Document */
    get: {
      query: {
        format?: "pdf" | "docx";
      };
      path: {
        doc_id: string;
      };
      response: void;
    };
  };
  "/api/v1/documents/{doc_id}/pdf": {
    /** Get Document Pdf */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentPDFStateResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/pdf/retry": {
    /** Retry Document Pdf */
    post: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentPDFStateResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/save-as-template": {
    /** Save Document As Template */
    post: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["SaveAsTemplateRequest"];
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/versions": {
    /** List Document Versions */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["DocumentVersionResponse"][];
    };
  };
  "/api/v1/documents/{doc_id}/versions/{version_id}/restore": {
    /** Restore Document Version */
    post: {
      path: {
        doc_id: string;
        version_id: string;
      };
      response: components['schemas']["DocumentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/comments": {
    /** List Document Comments */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["CommentResponse"][];
    };
    /** Add Document Comment */
    post: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["CommentCreateRequest"];
      response: components['schemas']["CommentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/comments/{comment_id}": {
    /** Update Document Comment */
    patch: {
      path: {
        doc_id: string;
        comment_id: string;
      };
      body: components['schemas']["CommentUpdateRequest"];
      response: components['schemas']["CommentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/attachments": {
    /** List Document Attachments */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["AttachmentResponse"][];
    };
    /** Add Document Attachment */
    post: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["AttachmentCreateRequest"];
      response: components['schemas']["AttachmentResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/attachments/{att_id}": {
    /** Delete Document Attachment */
    delete: {
      path: {
        doc_id: string;
        att_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/watchers": {
    /** List Document Watchers */
    get: {
      path: {
        doc_id: string;
      };
      response: components['schemas']["WatcherResponse"][];
    };
    /** Add Document Watcher */
    post: {
      path: {
        doc_id: string;
      };
      body: components['schemas']["WatcherAddRequest"];
      response: components['schemas']["WatcherResponse"];
    };
  };
  "/api/v1/documents/{doc_id}/watcher-candidates": {
    /** List Watcher Candidates */
    get: {
      query: {
        q?: string | null;
        limit?: number;
      };
      path: {
        doc_id: string;
      };
      response: components['schemas']["WatcherCandidateResponse"][];
    };
  };
  "/api/v1/documents/{doc_id}/watchers/{user_id}": {
    /** Remove Document Watcher */
    delete: {
      path: {
        doc_id: string;
        user_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
  };
  "/api/v1/templates": {
    /** List Templates */
    get: {
      query: {
        scope?: string | null;
        category?: string | null;
        q?: string | null;
        favourites_only?: boolean;
        include_archived?: boolean;
        published_only?: boolean;
        sort?: string;
      };
      response: components['schemas']["TemplateSummaryResponse"][];
    };
    /** Create Template */
    post: {
      body: components['schemas']["TemplateCreateRequest"];
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}": {
    /** Get Template */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
    /** Delete Template */
    delete: {
      path: {
        template_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
    /** Update Template */
    patch: {
      path: {
        template_id: string;
      };
      body: components['schemas']["TemplateUpdateRequest"];
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/fill-schema": {
    /** Template Fill Schema */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["DocumentFillSchemaResponse"];
    };
  };
  "/api/v1/templates/{template_id}/detect-blanks": {
    /** Detect Blanks */
    post: {
      path: {
        template_id: string;
      };
      body: components['schemas']["DetectBlanksRequest"];
      response: components['schemas']["DetectBlanksResponse"];
    };
  };
  "/api/v1/templates/{template_id}/publish-check": {
    /** Publish Check */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["PublishIssue"][];
    };
  };
  "/api/v1/templates/{template_id}/publish": {
    /** Publish Template */
    post: {
      path: {
        template_id: string;
      };
      body: components['schemas']["TemplatePublishRequest"];
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/favourite": {
    /** Favourite Template */
    put: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
    /** Unfavourite Template */
    delete: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/archive": {
    /** Archive Template */
    post: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/unarchive": {
    /** Unarchive Template */
    post: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/duplicate": {
    /** Duplicate Template */
    post: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/templates/{template_id}/versions": {
    /** List Template Versions */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateVersionSummary"][];
    };
  };
  "/api/v1/templates/{template_id}/versions/{version_id}/restore": {
    /** Restore Template Version */
    post: {
      path: {
        template_id: string;
        version_id: string;
      };
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/imports": {
    /** Start Import */
    post: {
      body: components['schemas']["ImportCreateRequest"];
      response: components['schemas']["ImportJobResponse"];
    };
  };
  "/api/v1/imports/{job_id}": {
    /** Get Import */
    get: {
      path: {
        job_id: string;
      };
      response: components['schemas']["ImportJobResponse"];
    };
  };
  "/api/v1/imports/{job_id}/cancel": {
    /** Cancel Import */
    post: {
      path: {
        job_id: string;
      };
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
  };
  "/api/v1/imports/{job_id}/apply": {
    /** Apply Import */
    post: {
      path: {
        job_id: string;
      };
      body: components['schemas']["ImportApplyRequest"];
      response: components['schemas']["TemplateDetailResponse"];
    };
  };
  "/api/v1/imports/{job_id}/stream": {
    /** Stream Import */
    get: {
      path: {
        job_id: string;
      };
      response: unknown;
    };
  };
  "/api/v1/files/upload-url": {
    /** Generate presigned S3/MinIO PUT URL for client upload */
    post: {
      body: components['schemas']["UploadURLRequest"];
      response: components['schemas']["UploadURLResponse"];
    };
  };
  "/api/v1/files/confirm-upload": {
    /** Record the FileAsset row after the client's direct PUT to storage succeeds */
    post: {
      body: components['schemas']["ConfirmUploadRequest"];
      response: components['schemas']["ConfirmUploadResponse"];
    };
  };
  "/api/v1/files/download-url/{storage_key}": {
    /** Generate presigned S3/MinIO GET URL for client download */
    get: {
      path: {
        storage_key: string;
      };
      response: components['schemas']["DownloadURLResponse"];
    };
  };
  "/api/v1/files/asset/{file_asset_id}/download-url": {
    /** Presigned GET URL for a FileAsset, addressed by id */
    get: {
      path: {
        file_asset_id: string;
      };
      response: components['schemas']["DownloadURLResponse"];
    };
  };
  "/api/v1/files/multipart/init": {
    /** Begin a resumable (multipart) upload */
    post: {
      body: components['schemas']["MultipartInitRequest"];
      response: components['schemas']["MultipartInitResponse"];
    };
  };
  "/api/v1/files/multipart/resume": {
    /** Ask storage which parts of an interrupted upload already landed */
    post: {
      body: components['schemas']["MultipartSessionRequest"];
      response: components['schemas']["MultipartResumeResponse"];
    };
  };
  "/api/v1/files/multipart/complete": {
    /** Assemble a resumable upload, then scan and record it as usual */
    post: {
      body: components['schemas']["MultipartCompleteRequest"];
      response: components['schemas']["ConfirmUploadResponse"];
    };
  };
  "/api/v1/files/multipart/abort": {
    /** Discard an unfinished resumable upload and its parts */
    post: {
      body: components['schemas']["MultipartAbortRequest"];
      response: void;
    };
  };
  "/api/v1/ai/availability": {
    /** Ai Availability */
    get: {
      response: components['schemas']["AIAvailabilityResponse"];
    };
  };
  "/api/v1/ai/suggest-field": {
    /** Suggest Field */
    post: {
      body: components['schemas']["FieldSuggestRequest"];
      response: components['schemas']["FieldSuggestResponse"];
    };
  };
  "/api/v1/ai/detect-blanks": {
    /** Detect Blanks */
    post: {
      body: components['schemas']["BlankDetectRequest"];
      response: components['schemas']["BlankDetectResponse"];
    };
  };
  "/api/v1/ai/rewrite": {
    /** Rewrite */
    post: {
      body: components['schemas']["RewriteRequest"];
      response: components['schemas']["RewriteResponse"];
    };
  };
  "/api/v1/ai/draft": {
    /** Draft */
    post: {
      body: components['schemas']["DraftRequest"];
      response: components['schemas']["DraftResponse"];
    };
  };
  "/api/v1/ai/complete": {
    /** Complete */
    post: {
      body: components['schemas']["CompleteRequest"];
      response: components['schemas']["CompleteResponse"];
    };
  };
  "/api/v1/ai/review": {
    /** Review */
    post: {
      body: components['schemas']["ReviewRequest"];
      response: components['schemas']["ReviewResponse"];
    };
  };
  "/api/v1/ai/suggest-details": {
    /** Suggest Details */
    post: {
      body: components['schemas']["SubmissionDetailsRequest"];
      response: components['schemas']["SubmissionDetailsResponse"];
    };
  };
  "/api/v1/ai/interactions/{interaction_id}/decision": {
    /** Record Decision */
    post: {
      path: {
        interaction_id: string;
      };
      body: components['schemas']["AIDecisionRequest"];
      response: components['schemas']["app__schemas__org__MessageResponse"];
    };
  };
  "/api/v1/ai/settings": {
    /** Set My Ai Settings */
    put: {
      body: components['schemas']["AIUserSettingsRequest"];
      response: components['schemas']["AIAvailabilityResponse"];
    };
  };
  "/api/v1/ai/org-settings": {
    /** Set Org Ai Settings */
    put: {
      body: components['schemas']["AIOrgSettingsRequest"];
      response: components['schemas']["AIAvailabilityResponse"];
    };
  };
  "/api/v1/documents/{document_id}/revise-and-resume": {
    /** Submit revised document and resume workflow at flagged stage */
    post: {
      path: {
        document_id: string;
      };
      body: components['schemas']["ReviseAndResumeRequest"];
      response: components['schemas']["WorkflowInstanceResponse"];
    };
  };
  "/api/v1/workflow-instances/{instance_id}": {
    /** Get workflow instance details */
    get: {
      path: {
        instance_id: string;
      };
      response: components['schemas']["WorkflowInstanceResponse"];
    };
  };
  "/api/v1/workflow-instances/{instance_id}/stream": {
    /** Server-Sent Events (SSE) live stream of workflow status */
    get: {
      path: {
        instance_id: string;
      };
      response: unknown;
    };
  };
  "/api/v1/workflow-instances/{instance_id}/cancel": {
    /** Cancel a running workflow instance */
    post: {
      path: {
        instance_id: string;
      };
      body: components['schemas']["CancelWorkflowRequest"];
      response: components['schemas']["WorkflowInstanceResponse"];
    };
  };
  "/api/v1/approvals/signing-key": {
    /** Get the public key used to verify DocFlow approval signatures */
    get: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/approvals/recalls": {
    /** List approval recall requests for the organization */
    get: {
      query: {
        instance_id?: string | null;
      };
      response: Record<string, unknown>[];
    };
  };
  "/api/v1/approvals": {
    /** List my pending approval steps */
    get: {
      response: components['schemas']["MyApprovalsResponse"];
    };
  };
  "/api/v1/approvals/{step_id}": {
    /** Get a single approval step */
    get: {
      path: {
        step_id: string;
      };
      response: components['schemas']["ApprovalStepResponse"];
    };
  };
  "/api/v1/approvals/{step_id}/decision": {
    /** Submit decision on an approval step ('approved' | 'rejected' | 'changes_requested') */
    post: {
      path: {
        step_id: string;
      };
      body: components['schemas']["DecisionRequest"];
      response: components['schemas']["ApprovalStepResponse"];
    };
  };
  "/api/v1/approvals/{step_id}/delegate": {
    /** Delegate an approval step to another user */
    post: {
      path: {
        step_id: string;
      };
      body: components['schemas']["DelegateRequest"];
      response: components['schemas']["ApprovalStepResponse"];
    };
  };
  "/api/v1/approvals/{step_id}/revoke": {
    /** Revoke/recall a decision you already recorded on this step */
    post: {
      path: {
        step_id: string;
      };
      body: components['schemas']["RevokeRequest"];
      response: Record<string, unknown>;
    };
  };
  "/api/v1/approvals/recalls/{revocation_id}/resolve": {
    /** Approve or deny an outstanding approval recall request (admin/HR only) */
    post: {
      path: {
        revocation_id: string;
      };
      body: components['schemas']["ResolveRecallRequest"];
      response: Record<string, unknown>;
    };
  };
  "/api/v1/approvals/instances/{instance_id}/finalize": {
    /** Finalize/close a fully-approved workflow (final approver or admin only) */
    post: {
      path: {
        instance_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/approvals/instances/{instance_id}/history": {
    /** Full approval chain of custody for a workflow instance */
    get: {
      path: {
        instance_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/approvals/{step_id}/signature/verify": {
    /** Verify the cryptographic signature recorded for an approval step */
    get: {
      path: {
        step_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/workflow-templates": {
    /** List active workflow templates (non-admin read — summary only) */
    get: {
      query: {
        active_only?: boolean;
        department_id?: string | null;
        doc_type_id?: string | null;
        search?: string | null;
        mine_only?: boolean;
      };
      response: components['schemas']["WorkflowTemplateSummary"][];
    };
    /** Create my own reusable workflow */
    post: {
      query: {
        visibility?: string;
      };
      body: components['schemas']["WorkflowTemplateCreate"];
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/workflow-templates/{template_id}": {
    /** Full definition of a workflow I own (or any, for org admins) */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["WorkflowTemplateResponse"];
    };
    /** Delete a workflow I own */
    delete: {
      path: {
        template_id: string;
      };
      response: void;
    };
    /** Update a workflow I own */
    patch: {
      path: {
        template_id: string;
      };
      body: components['schemas']["WorkflowTemplateUpdate"];
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/workflow-templates/{template_id}/duplicate": {
    /** Duplicate a workflow into a new one I own */
    post: {
      query: {
        new_name?: string | null;
      };
      path: {
        template_id: string;
      };
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/workflow-templates/{template_id}/active": {
    /** Enable or disable a workflow I own */
    post: {
      query: {
        is_active?: boolean;
      };
      path: {
        template_id: string;
      };
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/workflow-templates/{template_id}/review": {
    /** Non-admin, human-readable template detail for the pre-submit review step */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["TemplateReviewResponse"];
    };
  };
  "/api/v1/chat/conversations": {
    /** List my conversations (with unread counts) */
    get: {
      query: {
        kind?: string | null;
        page?: number;
        limit?: number;
      };
      response: components['schemas']["ConversationListResponse"];
    };
    /** Start a conversation (direct DM or workflow context) */
    post: {
      body: components['schemas']["StartConversationRequest"];
      response: components['schemas']["ConversationResponse"];
    };
  };
  "/api/v1/chat/conversations/{conversation_id}": {
    /** Get a single conversation by ID */
    get: {
      path: {
        conversation_id: string;
      };
      response: components['schemas']["ConversationResponse"];
    };
  };
  "/api/v1/chat/conversations/{conversation_id}/messages": {
    /** List messages in a conversation (cursor pagination) */
    get: {
      query: {
        before_id?: string | null;
        limit?: number;
      };
      path: {
        conversation_id: string;
      };
      response: components['schemas']["ChatMessageResponse"][];
    };
    /** Send a chat message (REST fallback; WebSocket preferred) */
    post: {
      path: {
        conversation_id: string;
      };
      body: components['schemas']["SendMessageRequest"];
      response: components['schemas']["ChatMessageResponse"];
    };
  };
  "/api/v1/chat/conversations/{conversation_id}/read": {
    /** Mark conversation as read (updates last_read_at for unread count) */
    post: {
      path: {
        conversation_id: string;
      };
      response: void;
    };
  };
  "/api/v1/chat/members": {
    /** List org members for DM picker (no admin gate — any member can query peers) */
    get: {
      query: {
        search?: string | null;
        limit?: number;
      };
      response: Record<string, unknown>[];
    };
  };
  "/api/v1/notifications": {
    /** List notifications for current user */
    get: {
      query: {
        unread_only?: boolean;
        page?: number;
        limit?: number;
      };
      response: components['schemas']["NotificationListResponse"];
    };
  };
  "/api/v1/notifications/unread-count": {
    /** Get the current user's unread notification count */
    get: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/notifications/{notification_id}/read": {
    /** Mark a notification as read */
    post: {
      path: {
        notification_id: string;
      };
      response: void;
    };
  };
  "/api/v1/notifications/read-all": {
    /** Mark all notifications as read */
    post: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/analytics/dashboard": {
    /** Summary stats for the analytics dashboard */
    get: {
      query: {
        period?: "monthly" | "yearly";
        year?: number | null;
        month?: number | null;
      };
      response: components['schemas']["DashboardStatsResponse"];
    };
  };
  "/api/v1/analytics/report": {
    /** Full analytics report (§9): monthly/yearly, breakdowns, bottlenecks */
    get: {
      query: {
        period?: "monthly" | "yearly";
        year?: number | null;
        month?: number | null;
        dept_id?: string | null;
        doc_type_id?: string | null;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/search": {
    /** Search documents, workflows, members, and messages (permission-filtered) */
    get: {
      query: {
        q?: string;
        entities?: string | null;
        limit?: number;
        offset?: number;
        status?: string | null;
        doc_type_id?: string | null;
        dept_id?: string | null;
        owner_id?: string | null;
        date_from?: string | null;
        date_to?: string | null;
        sort?: "relevance" | "newest" | "oldest" | "title";
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/status": {
    /** Whether the AI Agent is configured on this server */
    get: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/knowledge": {
    /** List Agent knowledge sources and index health */
    get: {
      query: {
        include_archived?: boolean;
      };
      response: Record<string, unknown>;
    };
    /** Upload a legal/policy document into the Agent's knowledge base */
    post: {
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/knowledge/{source_id}/reembed": {
    /** Re-embed a source with the current embedding model */
    post: {
      path: {
        source_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/knowledge/{source_id}/archive": {
    /** Archive (withdraw) a knowledge source so it is no longer retrieved */
    post: {
      query: {
        reason?: string | null;
      };
      path: {
        source_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/ask": {
    /** Ask the Agent a question about your organization */
    post: {
      body: components['schemas']["AskRequest"];
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/conversations": {
    /** My Agent conversations */
    get: {
      query: {
        limit?: number;
      };
      response: Record<string, unknown>[];
    };
  };
  "/api/v1/agent/conversations/{conversation_id}": {
    /** One Agent conversation */
    get: {
      path: {
        conversation_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/agent/messages/{message_id}/feedback": {
    /** Rate an Agent answer */
    post: {
      path: {
        message_id: string;
      };
      body: components['schemas']["FeedbackRequest"];
      response: Record<string, unknown>;
    };
  };
  "/api/v1/admin/roles/catalog": {
    /** Get the canonical role → permission mapping for all DocFlow roles */
    get: {
      response: components['schemas']["RoleCatalogEntry"][];
    };
  };
  "/api/v1/admin/workflow-templates": {
    /** List workflow templates for organization */
    get: {
      query: {
        active_only?: boolean;
        department_id?: string | null;
      };
      response: components['schemas']["WorkflowTemplateSummary"][];
    };
    /** Create a new workflow template with stages and approver rules */
    post: {
      body: components['schemas']["WorkflowTemplateCreate"];
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/admin/workflow-templates/{template_id}": {
    /** Get workflow template with all stages and rules */
    get: {
      path: {
        template_id: string;
      };
      response: components['schemas']["WorkflowTemplateResponse"];
    };
    /** Soft-delete a workflow template */
    delete: {
      path: {
        template_id: string;
      };
      response: void;
    };
    /** Update workflow template metadata (bumps version) */
    patch: {
      path: {
        template_id: string;
      };
      body: components['schemas']["WorkflowTemplateUpdate"];
      response: components['schemas']["WorkflowTemplateResponse"];
    };
  };
  "/api/v1/admin/users/{user_id}/deactivate": {
    /** Deactivate a user and revoke all active sessions */
    post: {
      path: {
        user_id: string;
      };
      response: Record<string, unknown>;
    };
  };
  "/api/v1/admin/audit-logs": {
    /** Query immutable system audit logs */
    get: {
      query: {
        instance_id?: string | null;
        actor_id?: string | null;
        action?: string | null;
        page?: number;
        limit?: number;
      };
      response: components['schemas']["AuditLogListResponse"];
    };
  };
}

/** Every path the API documents. */
export type ApiPath = keyof paths;

/** The methods a given path documents. */
export type ApiMethod<P extends ApiPath> = keyof paths[P];

type Op<P extends ApiPath, M extends ApiMethod<P>> = paths[P][M];

/** The JSON body of the success response, or `void` when there is none. */
export type ApiResponse<P extends ApiPath, M extends ApiMethod<P> = 'get' & ApiMethod<P>> =
  Op<P, M> extends { response: infer R } ? R : never;

/** The JSON request body, or `never` when the operation takes none. */
export type ApiBody<P extends ApiPath, M extends ApiMethod<P> = 'post' & ApiMethod<P>> =
  Op<P, M> extends { body: infer B } ? B : never;

/** The query string parameters, or `never` when there are none. */
export type ApiQuery<P extends ApiPath, M extends ApiMethod<P> = 'get' & ApiMethod<P>> =
  Op<P, M> extends { query: infer Q } ? Q : never;

/** A named schema, e.g. `Schema<'DocumentResponse'>`. */
export type Schema<N extends keyof components['schemas']> = components['schemas'][N];

