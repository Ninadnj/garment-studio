import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works from any sub-path (e.g. GitHub Pages /garment-studio/).
export default defineConfig({
  base: './',
  plugins: [react()],
  optimizeDeps: { exclude: ['@imgly/background-removal', 'onnxruntime-web'] },
})
