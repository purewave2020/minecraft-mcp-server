import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false },
  build: {
    lib: { entry: 'client/main.ts', name: 'MinecraftDashboard', formats: ['iife'], fileName: () => 'dashboard.js' },
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: 'dashboard.[ext]' } },
    sourcemap: true
  }
});
