// Configuration Vitest séparée de vite.config.js : ce dernier charge le plugin
// PWA (Workbox), inutile et coûteux pour des tests de modules purs. Les suites
// Vitest ne testent que src/lib/*.js, sans DOM ni réseau.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/lib/__tests__/**/*.test.js'],
    reporters: ['default'],
    // Un test qui échoue doit faire échouer la commande : pas de retry, pas de
    // seuil de tolérance.
    passWithNoTests: false,
  },
})
