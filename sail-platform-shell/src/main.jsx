import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './lib/AuthContext'
import { PermissionsProvider } from './app/providers/PermissionsProvider'
import App from './App'
import './styles.css'

// PermissionsProvider sits INSIDE AuthProvider (it depends on useAuth)
// and OUTSIDE App (so any page/component can call usePermissions()).
//
// FOUNDATION step: provider is mounted and live-fetching the DB
// permission catalog, but NOTHING in the app reads from it yet —
// pages still use the static CAN.X(role) map. See header of
// PermissionsProvider.jsx for the "install the new engine without
// turning it on" rationale.
ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <BrowserRouter>
            <AuthProvider>
                <PermissionsProvider>
                    <App />
                </PermissionsProvider>
            </AuthProvider>
        </BrowserRouter>
    </React.StrictMode>
)
