import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { readdirSync, unlinkSync } from 'fs'

// Plugin: delete old hashed JS/CSS bundles from public/assets before each build
function cleanOldBundles() {
  return {
    name: 'clean-old-bundles',
    buildStart() {
      const dir = resolve(__dirname, '../public/assets')
      try {
        readdirSync(dir).forEach(f => {
          if (/^index-[A-Za-z0-9_-]+\.(js|css)$/.test(f)) {
            unlinkSync(`${dir}/${f}`)
          }
        })
      } catch {}
    }
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cleanOldBundles()],
  build: {
    outDir: '../public',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':   ['react', 'react-dom'],
          'vendor-charts':  ['recharts'],
          'vendor-syntax':  ['react-syntax-highlighter'],
          'vendor-motion':  ['motion'],
          'vendor-lucide':  ['lucide-react'],
        }
      }
    }
  },
  base: '/'
})
