// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Permissions — Role-based access control
// ─────────────────────────────────────────────────────────────────────────────
// Centralised permission matrix. All access checks go through CAN.
// Never scatter inline role comparisons throughout the codebase.
//
// Roles (ascending privilege): student < teacher < admin < super_admin
// ═══════════════════════════════════════════════════════════════════════════════

const ROLE_RANK = {
    student:     1,
    teacher:     2,
    admin:       3,
    super_admin: 4,
}

export const ROLE_LABELS = {
    student:     'Student',
    teacher:     'Teacher',
    admin:       'Admin',
    super_admin: 'Super Admin',
}

const hasRole = (userRole, requiredRole) =>
    (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[requiredRole] || 0)

const isStaff = (r) => hasRole(r, 'teacher')
const isAdmin = (r) => hasRole(r, 'admin')

// ─── Role classifiers (exported) ─────────────────────────────────────────────
// Use these from pages to FILTER member rows by role (not to gate
// permissions). They are the canonical home for role-string compares
// — pages must NOT do `m.role === 'student'` inline. permissions.js is
// whole-file allowlisted by verify-permissions-single-source.mjs, so
// the string literals live here legitimately.
export const isStudentRole = (r) => r === 'student'
export const isStaffRole   = (r) => isStaff(r)
export const isAdminRole   = (r) => isAdmin(r)

// ─── Permission matrix ──────────────────────────────────────────────────────
export const CAN = {
    // Dashboard
    viewDashboard:        (r) => isStaff(r),

    // Assignments & grading
    //
    // viewAssignments / createAssignment / manageAssignment / gradeSubmission /
    // batchGrade / submitAssignment / viewGradebook were all migrated to the
    // DB-backed PermissionsProvider (cleanup pass 2026-05-16) and the
    // static entries were deleted as part of that pass. The remaining
    // entries below are surfaces that haven't been migrated yet (no DB
    // counterpart in school_role_permissions) — they stay static until
    // a future migration adds the corresponding DB grants.

    // Student-facing
    //
    // viewOwnAssignments still has a static entry because MyAssignments.jsx
    // uses it for a defensive page-level double-gate AFTER the route
    // registration in App.jsx (which uses can('helm.grades.view_own')).
    // The two paths are kept aligned — the static predicate matches the
    // single DB grant exactly (student-only on both sides).
    viewOwnAssignments:   (r) => r === 'student',

    // Admin
    //
    // viewMembers + manageSchool fully migrated to DB-backed can() and
    // their static entries deleted. addMember + changeMemberRole remain
    // here because they don't have DB counterparts yet — the Members.jsx
    // affordances they gate (the add-member form, the per-row role
    // change select) still use static CAN until DB perms exist.
    addMember:            (r) => isAdmin(r),
    changeMemberRole:     (r) => isAdmin(r),

    // Provisioning (Phase 1 Route 2 — HELM_REBUILD_PLAN.md §3)
    //
    // True for:
    //   - any authenticated user with no school_members row (role = null
    //     / undefined / empty) — the "first school" self-service path;
    //   - super_admin operators — the "create another school" path
    //     (the RPC enforces single-school-per-user, so super-admin
    //     provisioning of additional schools requires a future RPC).
    //
    // False for any role that already belongs to a school — they
    // cannot self-provision again. They reach a hard-block instead.
    provisionSchool:      (r) => !r || r === 'super_admin',

    // Attendance (Phase 2 Route 4 — HELM_PHASE_2_SPEC.md §3.4)
    //
    // viewAttendance: any school member. Staff see the per-date class
    // roster via list_class_attendance; students see their own
    // history via list_student_attendance. Both RPCs filter
    // server-side; this CAN.* is the UI gate only.
    // markAttendance: staff only. RPC re-checks teacher-of-class
    // OR admin-of-school inline.
    viewAttendance:       (r) => Boolean(r),
    markAttendance:       (r) => isStaff(r),

    // Timeline — per-student unified event stream (PR D)
    //
    // viewTimeline: any school member. Staff see the per-student event
    // stream under a class context (class selector → student selector
    // → timeline). Students see their own timeline directly (no
    // selectors). The helm_get_student_timeline RPC (migration M12)
    // re-checks at the DB layer: caller is the student themselves OR
    // admin of the student's school OR a teacher of a class they are
    // enrolled in. Same permission gate as M11.
    //
    // Page is READ-ONLY. Resolve / mark-attendance / mark-submitted
    // happen on their existing surfaces (Behaviour / Attendance /
    // Assignments), not inline in the timeline.
    viewTimeline:         (r) => Boolean(r),

    // Behaviour — per-student events (log + resolve, M11 wrapper read)
    //
    // viewBehaviour: any school member. Staff see the per-student
    // events list under a class context (class selector → student
    // selector → events). Students see their own events directly
    // (no selectors). The helm_list_behaviour_for_student RPC
    // (migration M11) re-checks at the DB layer: caller is the
    // student themselves OR admin of the student's school OR a
    // teacher of a class the student is enrolled in.
    //
    // logBehaviour: staff only. Gates both the Log form and the
    // Resolve action. The bridge_log_behaviour_event +
    // bridge_resolve_behaviour_event RPCs also re-check at the DB
    // layer (staff-of-school OR manage_behaviour permission).
    viewBehaviour:        (r) => Boolean(r),
    logBehaviour:         (r) => isStaff(r),

    // Copilot — review_struggling_students v1
    //
    // Staff-only (admin / teacher). The `bridge_copilot_review_struggling`
    // RPC re-checks at the DB level (caller must be a teacher of the
    // class OR hold copilot.read), so this CAN.* is the UI gate only.
    // Students are blocked at the UI to avoid the case where a student
    // discovers the route from the URL bar and gets a confusing
    // "permission denied" toast — better to not surface the link.
    useCopilot:           (r) => isStaff(r),

    // Courses (Phase 2 Route 1 — HELM_PHASE_2_SPEC.md §3.1)
    //
    // Every member of a school can view the courses surface. The RPC
    // filters which classes they see (admin: all active; teacher: own;
    // student: enrolled).
    viewCourses:          (r) => Boolean(r),
    // Create / archive are admin-only. Update + manageEnrollment admit
    // staff at the UI level; the RPCs re-check whether the caller is
    // admin of the school OR teacher of the specific class.
    createClass:          (r) => isAdmin(r),
    archiveClass:         (r) => isAdmin(r),
    updateClass:          (r) => isStaff(r),
    manageEnrollment:     (r) => isStaff(r),
}

// ─── Default landing page by role ───────────────────────────────────────────
// (The previous `getAllowedRoutes()` helper was removed in the cleanup
// pass — it had zero consumers in src/ and its references to migrated
// CAN entries would have broken after the deletion above.)
export function getDefaultRoute(role) {
    if (isStaff(role)) return '/'
    if (role === 'student') return '/my-assignments'
    return '/'
}
