import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Flip } from 'gsap/Flip'
import './index.css'
import App from './App.tsx'

// Register GSAP plugins once (Flip ships with gsap — no new dependency).
gsap.registerPlugin(useGSAP, Flip)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
