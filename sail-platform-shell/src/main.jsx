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
// Provider is the sole source of truth for migrated permissions
// (helm.* keys driven by `helm_get_my_school_permissions`). Static
// CAN.* entries that remain in lib/permissions.js are for surfaces
// that haven't been migrated yet.
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
