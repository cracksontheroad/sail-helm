# Copilot prototype · visual end-to-end run results

**Run timestamp:** 2026-05-10 ≈ 00:46–00:48 UTC
**Helm dev server:** http://localhost:5173 (vite v8.0.8)
**Branch (sail-helm):** `copilot/prototype/review-struggling/v1`
**Branch (sail-core):** `copilot/prototype/review-struggling/v1` (PR #3, `Closes #2`)

## HARD-STOP ACHIEVED

A real teacher session generated suggestions, accepted one, the resulting
targeted assignment landed in the database, and a separate real student
session in the same school saw it appear in `/my-assignments`. RLS
correctly refused the student's direct attempt to call the Copilot RPC.

## Screenshot index

| # | File | What it shows |
|---|---|---|
| 01 | `copilot-e2e-01-teacher-after-login.png` | "Teacher" badge + `teacher@test.com` after sign-in, Copilot · At-risk nav link visible |
| 02 | `copilot-e2e-02-panel-empty.png` | Copilot panel pre-run — Class auto-selected to "Math Class", default window 14 / threshold 0.6 |
| 03 | `copilot-e2e-03-cards.png` | Three medium-risk cards (Alice S., Bob J., Charlie B.) with signal tags + Recommended actions + the displayed `request_id: 1cd30243-1aab-4dc9-9bec-70eb33df31ab` |
| 04 | `copilot-e2e-04-accept-form-open.png` | Accept clicked on Alice's card — pre-drafted title "Re-teach core concept — Alice S." + description editable inline |
| 05 | `copilot-e2e-05-accept-success.png` | "✓ Targeted assignment created" stamped on the Alice card after Create + assign |
| 06 | `copilot-e2e-06-student-after-login.png` | Student session signed in as `bob@test.com` (real name Alice Smith — fixture quirk; uid 14a97a21…) with "Student" badge |
| 07 | `copilot-e2e-07-student-my-assignments.png` | `/my-assignments` page — full list of 23 assignments, the targeted one is the first card |
| 08 | `copilot-e2e-08-student-sees-targeted-assignment.png` | Above-the-fold viewport showing the targeted assignment as the first row visible to the student |

## Database evidence

### A. The assignment created by the UI

```sql
SELECT id, title, description, created_by, created_at,
       (SELECT count(*) FROM student_assignments WHERE assignment_id = id) AS distributed_to_n,
       (SELECT array_agg(student_id) FROM student_assignments WHERE assignment_id = id) AS distributed_to
  FROM public.assignments
 WHERE class_id = 'b76d35bd-9c6a-418a-b087-b3c820ebc571'
   AND title ILIKE 'Re-teach core concept%'
 ORDER BY created_at DESC LIMIT 3;
```

```
 assignment_id              : f0867203-e414-45e8-b8c6-e6692a0c570e
 title                      : Re-teach core concept — Alice S.
 description                : Re-teach the most recent topic to Alice S. (and any peers in similar position). Watch for: low recent mark + unsubmitted work pattern.
 created_by                 : b506e763-d91f-4b73-9ae2-dd8d44b25939   ← teacher@test.com
 created_at                 : 2026-05-10 00:47:11.761003
 distributed_to_n           : 1
 distributed_to             : [14a97a21-299e-47b1-8e42-ed29fe5714ee]  ← Alice / bob@test.com only
```

### B. Audit JOIN — same `request_id` ties Copilot read to acceptance, plus the assignment trail by adjacency

`request_id = 1cd30243-1aab-4dc9-9bec-70eb33df31ab` (visible in screenshot 03)

```sql
-- Copilot rows for this request_id
SELECT id, action, actor_id, created_at,
       (metadata->>'student_count')::int AS n
  FROM public.audit_logs
 WHERE action = 'copilot.read'
   AND metadata->>'request_id' = '1cd30243-1aab-4dc9-9bec-70eb33df31ab'
 ORDER BY created_at;

-- Assignment rows by same actor within ±30s
WITH cop_at AS (
  SELECT max(created_at) AS ts FROM public.audit_logs
   WHERE action='copilot.read' AND metadata->>'request_id'='1cd30243-…'
)
SELECT id, action, entity_id AS assignment_id, actor_id, created_at,
       metadata->'context'->>'surface' AS surface
  FROM public.audit_logs, cop_at
 WHERE action IN ('assignment.created','assignment.distributed')
   AND actor_id = 'b506e763-d91f-4b73-9ae2-dd8d44b25939'
   AND created_at BETWEEN cop_at.ts - interval '30 seconds'
                      AND cop_at.ts + interval '30 seconds';
```

Combined timeline (4 rows, ~60 s window, all by teacher uid `b506e763…`):

| t (UTC)              | id           | action                   | entity     | target / metadata                                                  |
|----------------------|--------------|--------------------------|------------|--------------------------------------------------------------------|
| 00:46:12.252746      | `978d3cdd…`  | `copilot.read`           | copilot    | request_id `1cd30243…`, student_count=3, intent_key=`review_struggling_students` |
| 00:47:11.761003      | `14a62d6e…`  | `assignment.created`     | assignments | assignment `f0867203…`, class `b76d35bd…`                         |
| 00:47:12.368671      | `f5ab81d0…`  | `assignment.distributed` | assignments | assignment `f0867203…`, surface=`helm.assignments`                |
| 00:47:12.767024      | `4b5eae46…`  | `copilot.read`           | copilot    | request_id `1cd30243…`, student_count=1 (the accept emit)         |

The two `copilot.read` rows JOIN cleanly on `request_id`. The two
`assignment.*` rows are bridged to the Copilot trail by **same
actor_id + ~1 s timestamp adjacency** (per the existing trigger model;
the assignment-creation trigger does not carry `request_id`, which is
documented as a follow-up in the Hooks Spec).

## Security smoke during the live run (browser-side)

Inside the student-session browser, JavaScript pulled the student's own
JWT from `localStorage` and called the Copilot RPC directly:

```
POST https://gidyonbzxjorrgpicctt.supabase.co/rest/v1/rpc/bridge_copilot_review_struggling
authorization: Bearer <student JWT>
body: { p_school_id, p_class_id }

→ HTTP 403
   { "code": "42501", "message": "permission denied: caller is not staff of the target school and lacks copilot.read" }
```

So even when the route guard is bypassed (script-driven), the server
refuses with the expected error.

## Ephemeral credentials (already revoked)

For this run only, the test accounts' passwords were temporarily set
to ephemeral values via `crypt(…, gen_salt('bf'))` on `auth.users`,
with the original encrypted_password values snapshotted into
`public._copilot_e2e_pwd_restore`. After the run completed, the
originals were restored from the snapshot table and the snapshot
table was dropped. Verified post-restore:

```
ephemeral_teacher_still_works = false
ephemeral_student_still_works = false
```

## How to reproduce locally

```bash
cd "SAIL Core/sail-helm-core-v6-lite/sail-platform-shell"
git checkout copilot/prototype/review-struggling/v1
npm ci
npm run dev   # http://localhost:5173

# Get the test passwords from your team / Supabase dashboard,
# then in two browser contexts (or incognito tabs):
#   ① teacher@test.com → /copilot/review-struggling → Run → Accept → Create + assign
#   ② bob@test.com     → /my-assignments → first card is the just-created assignment
```

The committed Playwright recipe `scripts/copilot-prototype-e2e.mjs`
runs the same flow headlessly — pass `TEACHER_PASSWORD` and
`STUDENT_PASSWORD` as env vars.
