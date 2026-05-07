import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'

export default function Dashboard() {
    const { schoolId } = useAuth()
    const [stats, setStats] = useState({ classes: 0, assignments: 0, distributed: 0 })

    useEffect(() => {
        if (schoolId) loadStats()
    }, [schoolId])

    async function loadStats() {
        // Count classes for this school
        const { count: classes } = await supabase
            .from('classes')
            .select('*', { count: 'exact', head: true })
            .eq('school_id', schoolId)

        // Count assignments for this school's classes
        const { data: schoolClasses } = await supabase
            .from('classes')
            .select('id')
            .eq('school_id', schoolId)

        const classIds = (schoolClasses || []).map(c => c.id)

        let assignments = 0
        let distributed = 0

        if (classIds.length > 0) {
            const { count: assignmentCount } = await supabase
                .from('assignments')
                .select('*', { count: 'exact', head: true })
                .in('class_id', classIds)

            assignments = assignmentCount ?? 0

            // Count student_assignments for this school's assignments
            const { data: schoolAssignments } = await supabase
                .from('assignments')
                .select('id')
                .in('class_id', classIds)

            const assignmentIds = (schoolAssignments || []).map(a => a.id)

            if (assignmentIds.length > 0) {
                const { count: distCount } = await supabase
                    .from('student_assignments')
                    .select('*', { count: 'exact', head: true })
                    .in('assignment_id', assignmentIds)

                distributed = distCount ?? 0
            }
        }

        setStats({
            classes: classes ?? 0,
            assignments,
            distributed,
        })
    }

    return (
        <div>
            <h2>Dashboard</h2>
            <p>Welcome to SAIL Platform.</p>
            <br />
            <p>Classes: <strong>{stats.classes}</strong></p>
            <p>Assignments: <strong>{stats.assignments}</strong></p>
            <p>Distributed to students: <strong>{stats.distributed}</strong></p>
        </div>
    )
}
