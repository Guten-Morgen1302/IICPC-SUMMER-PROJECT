import { Navigate, Route, Routes } from 'react-router-dom'
import { LandingPage } from './pages/Landing'
import { DashboardApp } from './dashboard/DashboardApp'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/app/*" element={<DashboardApp />} />
      <Route path="*" element={<Navigate to="/app/stress" replace />} />
    </Routes>
  )
}

export default App
