import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // base: '/nijimi/',   // ← リポジトリ名と一致させる
  base: './',   // ← '/nijimi/' から変更。GitHub PagesでもCapacitorでも動く
})
