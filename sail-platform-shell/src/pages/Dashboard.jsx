import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'

export default function Dashboard() {
    const { schoolId } = useAuth()
    const [stats, setStats] = useState({ classes: 0, assignments: 0, distributed: 0 })

    useEffect(() => {
        if (schoolId) loadStats()
    }, [schoolId])

    // B27.1 read-path consolidation (2026-05-08): replaced 5 separate
    // direct-table count queries with one bridge_get_helm_dashboard_stats
    // RPC. Same RLS posture (the RPC is a thin LANGUAGE sql STABLE
    // wrapper); same numbers a teacher / student / sail-tier user
    // would have seen via the previous queries — but in one round-trip
    // instead of up to four.
    async function loadStats() {
        const { data, error } = await supabase.rpc('bridge_get_helm_dashboard_stats', {
            p_school_id: schoolId,
        })
        if (error) {
            console.error('[Dashboard.loadStats] bridge_get_helm_dashboard_stats failed:', error.message)
            return
        }
        // RPC returns RETURNS TABLE → array of one row.
        const row = Array.isArray(data) ? data[0] : data
        setStats({
            classes:     Number(row?.classes_count)     || 0,
            assignments: Number(row?.assignments_count) || 0,
            distributed: Number(row?.distributed_count) || 0,
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
