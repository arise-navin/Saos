import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (process.env.VERCEL) {
    const apiUrl = process.env.VITE_API_URL || env.VITE_API_URL;
    if (!apiUrl || !apiUrl.startsWith('https://')) {
      throw new Error('Set VITE_API_URL to https://YOUR-RENDER-SERVICE.onrender.com/api in Vercel before building.');
    }
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
    },
  };
});
