import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import './globals.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* always 'system', and nothing here calls setTheme: the host pins or frees the
        window theme (set_appearance_theme), the webview's prefers-color-scheme
        follows the window, and the class follows that. one switch, in rust. */}
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      enableColorScheme
      disableTransitionOnChange
    >
      <App />
    </ThemeProvider>
  </StrictMode>,
)
