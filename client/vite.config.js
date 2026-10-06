import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development, requests to /api are forwarded to the Node server (port 8000), so there are no CORS problems.
const proxy = { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } }

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
})
