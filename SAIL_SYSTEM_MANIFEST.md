# SAIL System Manifest

Last updated: 2026-05-07

This file is the operational truth map for the SAIL platform. It exists to reduce drift between AI reports, markdown memory, GitHub, Supabase, Netlify, and the live applications.

## 1. Platform architecture

SAIL is a multi-app education platform ecosystem.

### Core separation

| Layer | Purpose | Status |
|---|---|---|
| SAIL Core | Shared backend, auth, database, RBAC, audit, app registry, memory | Active |
| SAIL Bridge | Internal SAIL company control plane for ops/admin/support/content | Active internal foundation |
| SAIL Helm | External school-facing SaaS shell | Preserved / stabilisation required |
| SAIL Apps | Product apps that will later connect to Core | Audited / not migrated yet |

### Hard rules

1. SAIL Core is the single backend source of truth.
2. Bridge is internal-only. Helm is external-facing. They must not share one UI surface.
3. Apps must not fork their own database, auth, or role system.
4. AI reports are not accepted as true unless verified against GitHub, Supabase, CI, or live runtime evidence.
5. Markdown/transcripts are snapshots only, not authoritative implementation proof.

## 2. Known connected systems

### Supabase

| Project | Ref | Role |
|---|---|---|
| SAIL-core | gidyonbzxjorrgpicctt | Canonical shared backend |
| SAIL-Helm | qilppvnwilcxworlrdjh | Legacy/transitional Helm backend |

### GitHub repositories visible through connector

| Repository | Observed role |
|---|---|
| cracksontheroad/sail-helm | Visible Helm/Core code repository |
| cracksontheroad/sail-bridge-d9-review-20260506-2329 | Private D.9 Bridge review artifact repository |
| cracksontheroad/SAIL-Manual-Netlify-Deploy | Manual deployment/documentation repository |

Note: a separate canonical `sail-core` or `sail-bridge` repository was not visible through the GitHub connector at the time this manifest was created.

## 3. Current verified Supabase baseline

Observed from live Supabase connector on 2026-05-07 for project `gidyonbzxjorrgpicctt`:

### Healthy active platform tables

- `profiles` — RLS enabled
- `schools` — RLS enabled
- `classes` — RLS enabled
- `assignments` — RLS enabled
- `apps` — RLS enabled
- `user_apps` — RLS enabled
- `analytics_events` — RLS enabled
- `school_members` — RLS enabled
- `student_assignments` — RLS enabled
- `audit_logs` — RLS enabled
- `ai_requests` — RLS enabled
- `consent_records` — RLS enabled
- `school_apps` — RLS enabled
- `school_app_events` — RLS enabled
- `integrity_milestones` — RLS enabled
- `sail_memory` — RLS enabled
- `alert_request_log` — RLS enabled
- `system_health_history` — RLS enabled

### Security concern

Supabase advisor reported 23 public tables with RLS disabled. Some are deprecated/archive tables, but this still needs explicit treatment before production.

Examples include:

- `enrollments`
- `submissions`
- `grades`
- `roles`
- `permissions`
- `role_permissions`
- `campuses`
- `departments`
- `notifications`
- `message_threads`
- `messages`
- `files`
- `rollout_gate_logs`
- `rollout_gate_checks`
- deprecated/archive tables

Do not blindly enable RLS without policies; that can break valid paths. Each table needs classification: active, deprecated, archive, or internal-only.

## 4. Governance principle

Every SAIL build claim must be classified as one of:

| Claim status | Meaning |
|---|---|
| Verified | Confirmed through live connector, GitHub, CI, Supabase, or runtime check |
| Reported | Claimed by AI/transcript but not independently verified |
| Planned | Intended work only |
| Blocked | Cannot proceed due to missing access, credentials, schema, or decision |
| Rejected | Explicitly not part of current direction |

## 5. Current governance priorities

1. Finish role/RBAC finalisation.
2. Resolve RLS-disabled table backlog.
3. Harden AI proxy: auth, quotas, CORS, persistent logging.
4. Stabilise Helm before app migrations.
5. Automate SAIL Memory updates from commits/build logs where possible.
6. Establish repeatable live audit process.

## 6. Evidence rules

A task is not complete unless it includes at least one of:

- commit SHA
- PR link
- CI result
- Supabase migration name
- SQL verification result
- runtime test result
- deployment URL and deploy ID
- screenshot or console output where relevant

## 7. Non-goals for this manifest

This file does not store secrets, credentials, service-role keys, private DB passwords, or API keys.
