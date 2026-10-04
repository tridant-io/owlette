import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './globals.css'
import App from './App.tsx'
import { HostTheme } from '@/components/HostTheme'
import { resolvedAppearance } from '@/lib/ipc'
import { FALLBACK_THEME } from '@/lib/theme'

// asked before the first render, so the page never paints the other theme first
void resolvedAppearance()
  .catch(() => FALLBACK_THEME)
  .then((initial) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <HostTheme initial={initial}>
          <App />
        </HostTheme>
      </StrictMode>,
    )
  })
