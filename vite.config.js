import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': { target: process.env.PLAZA_API_TARGET || 'http://127.0.0.1:4174', changeOrigin: false }
    }
  }
})
