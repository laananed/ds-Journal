import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import DemoAuthGate from './components/DemoAuthGate'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoAuthGate><App /></DemoAuthGate>
  </StrictMode>,
)
