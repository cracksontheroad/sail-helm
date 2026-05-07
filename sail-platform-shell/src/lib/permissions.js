// ═══════════════════════════════════════════════════════════════════════════════
// SAIL Permissions — Role-based access control
// ─────────────────────────────────────────────────────────────────────────────
// Centralised permission matrix. All access checks go through CAN.
// Never scatter inline role comparisons throughout the codebase.
//
// Roles (ascending privilege): student < teacher < admin
//
// Why no `super_admin` here: the live Postgres CHECK on
// `public.school_members.role` admits exactly
//   ('admin','teacher','student','parent','counsellor')
// — `super_admin` was deleted from the constraint in SAIL-core Phase 0
// Slice 2 (2026-05-05). A `super_admin: 4` rank in this file was a
// dead branch — no row in school_members can hold that role, so the
// rank-ladder check `(ROLE_RANK[userRole] || 0) >= …` never returned
// true via this entry. Phase Lockdown C (2026-05-07) removes it so a
// future reader doesn't confuse "this rank exists in code" with
// "this role exists in the DB".
//
// Cross-school / platform-tier overrides (`assignments.read`,
// `assignments.write`) are enforced server-side by the SAIL-core
// RLS + RPC gates (`has_permission(uuid, text)`). They do NOT route
// through this file — Helm's CAN matrix is a school-membership
// affordance helper, not an authorisation system.
// ═══════════════════════════════════════════════════════════════════════════════

const ROLE_RANK = {
    student:     1,
    teacher:     2,
    admin:       3,
}

export const ROLE_LABELS = {
    student:     'Student',
    teacher:     'Teacher',
    admin:       'Admin',
}

const hasRole = (userRole, requiredRole) =>
    (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[requiredRole] || 0)

const isStaff = (r) => hasRole(r, 'teacher')
const isAdmin = (r) => hasRole(r, 'admin')

// ─── Permission matrix ──────────────────────────────────────────────────────
export const CAN = {
    // Dashboard
    viewDashboard:        (r) => isStaff(r),

    // Assignments & grading
    viewAssignments:      (r) => isStaff(r),
    createAssignment:     (r) => isStaff(r),
    gradeSubmission:      (r) => isStaff(r),
    batchGrade:           (r) => isStaff(r),

    // Gradebook
    viewGradebook:        (r) => isStaff(r),

    // Student-facing
    viewOwnGrades:        (r) => r === 'student',
    submitAssignment:     (r) => r === 'student',
    // Phase 6E — student /my-assignments surface
    viewMyAssignments:    (r) => r === 'student',

    // Admin
    viewMembers:          (r) => isAdmin(r),
    manageSchool:         (r) => isAdmin(r),
}

// ─── Route access by role ───────────────────────────────────────────────────
// Returns the allowed route paths for a given role.
export function getAllowedRoutes(role) {
    const routes = []
    if (CAN.viewDashboard(role))     routes.push('/')
    if (CAN.viewAssignments(role))   routes.push('/assignments')
    if (CAN.viewGradebook(role))     routes.push('/gradebook')
    if (CAN.viewMyAssignments(role)) routes.push('/my-assignments')
    if (CAN.viewOwnGrades(role))     routes.push('/my-grades')
    return routes
}

// ─── Default landing page by role ───────────────────────────────────────────
// Phase 6E: students now default to /my-assignments (real surface)
// rather than /my-grades (placeholder). Once /my-grades is built out,
// the default may shift again — but the current default should always
// land the user on a USABLE page.
export function getDefaultRoute(role) {
    if (isStaff(role)) return '/'
    if (role === 'student') return '/my-assignments'
    return '/'
}
