import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Le serveur d'authentification compare « Host » ET « Origin » à AUTH_ORIGIN.
// Avec changeOrigin:false, Vite transmettait Host: 127.0.0.1:5173 et toutes les
// requêtes /api étaient refusées (403 Hôte refusé) en dev et en preview.
// On réécrit donc les deux en-têtes vers l'origine réelle du backend.
function authProxy(){
  const target = new URL(process.env.AUTH_DEV_TARGET || 'http://127.0.0.1:3000').origin
  return {
    target,
    changeOrigin: true,
    configure: (proxy) => proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('Origin', target)),
  }
}

export default defineConfig({
  base: './',
  server: { proxy: { '/api': authProxy() } },
  preview: { proxy: { '/api': authProxy() } },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'MON PARKING — Gestion de parkings automobiles',
        short_name: 'MON PARKING',
        description:
          'Suite de gestion multi-parcs : stock, ventes, locations, factures, comptabilité et statistiques.',
        lang: 'fr',
        theme_color: '#0a1119',
        background_color: '#06090e',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: './',
        scope: './',
        categories: ['business', 'productivity', 'finance'],
        // purpose séparés : Chrome refuse un jeu d'icônes où « any » et
        // « maskable » partagent le même fichier aux mauvaises marges.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Nouvelle vente', url: './#/ventes/nouvelle' },
          { name: 'État du stock', url: './#/stock' },
          { name: 'Tableau de bord', url: './#/dashboard' },
        ],
      },
      workbox: {
        importScripts: ['./notification-worker.js'],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm,gz}'],
        // Le moteur OCR (5,6 Mo de WASM + modèle de lecture) n'est PAS précaché :
        // il alourdissait le premier chargement mobile pour un usage occasionnel.
        // Il est mis en cache à la demande (route /ocr/ ci-dessous), donc le scan
        // hors ligne fonctionne après une première lecture en ligne.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globIgnores: ['**/ocr/*.wasm.js', '**/ocr/**'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Moteur OCR : téléchargé au premier scan, puis servi hors ligne.
            urlPattern: ({ url }) => url.pathname.startsWith('/ocr/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-engine',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 1600 },
})
