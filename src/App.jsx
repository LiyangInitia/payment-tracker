import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Tracker from './pages/Tracker'

function Gate() {
  const { session, loading } = useAuth()
  if (loading) return null
  return session ? <Tracker /> : <Login />
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
