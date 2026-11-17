import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 本地后端地址；后端端口冲突时可用 BACKEND_ORIGIN 环境变量覆盖
const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:8788';

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': BACKEND,
      '/health': BACKEND,
    },
  },
});
