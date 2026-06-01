import { Navigate, Route, Routes } from 'react-router-dom'
import { LandingPage } from './pages/Landing'
import './App.css'

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
