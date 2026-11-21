import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/ | https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // Same alias the web app uses, so every file copied out of web/ —
      // components/ui/*, lib/utils — compiles here UNCHANGED.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Tauri expects a fixed port and treats a moved one as a failure to launch;
  // it also owns the terminal, so vite must not wipe its output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // src-tauri is Rust's; watching it would restart vite on every cargo write.
    watch: { ignored: ['**/src-tauri/**'] },
  },

  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Vitest stubs CSS to `export default ""` unless opted in here, which would
    // empty the `globals.css?raw` import the port-integrity assertions read.
    // Nothing else imports CSS in tests, so no Tailwind compilation happens.
    css: { include: [/globals\.css/] },
  },
})
