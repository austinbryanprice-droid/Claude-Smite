import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    // sounds.html auditions every sound in the game
    rollupOptions: { input: { main: 'index.html', sounds: 'sounds.html' } },
  },
  server: { host: true },
});
