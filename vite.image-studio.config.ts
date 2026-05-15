import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vite 配置 - Image Studio 独立构建
 *
 * 专门用于构建 Image Studio 前端应用
 * 输出目录: dist-image-studio
 */
export default defineConfig({
  plugins: [react()],
  root: 'src-image-studio',
  base: '/image-studio/',
  build: {
    outDir: '../dist-image-studio',
    chunkSizeWarningLimit: 600,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@image-studio': path.resolve(__dirname, 'src-image-studio'),
      '@woohoo': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5174,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
    fs: {
      allow: [path.resolve(__dirname)],
    },
  },
});
