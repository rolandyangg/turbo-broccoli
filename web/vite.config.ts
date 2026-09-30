import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.BUGBASH_WEB_API_PORT ?? 4318);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.BUGBASH_WEB_PORT ?? 4317),
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
