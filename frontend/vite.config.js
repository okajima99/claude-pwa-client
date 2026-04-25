import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Generate public/manifest.json from manifest.template.json by injecting
// values from VITE_APP_* env vars. Runs once at config time so both `vite`
// (dev) and `vite build` pick up the latest values.
function generateManifest(env) {
  const root = resolve(import.meta.dirname, 'public')
  const template = readFileSync(resolve(root, 'manifest.template.json'), 'utf-8')
  const out = template
    .replace(/__APP_TITLE__/g, env.VITE_APP_TITLE || 'App')
    .replace(/__APP_SHORT_NAME__/g, env.VITE_APP_SHORT_NAME || 'App')
  writeFileSync(resolve(root, 'manifest.json'), out)
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, '')
  generateManifest(env)
  return {
    plugins: [react()],
  }
})
