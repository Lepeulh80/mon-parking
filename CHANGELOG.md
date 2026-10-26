## 19.6.0 — 2026-10-24 — devise d'affichage (XOF / EUR / USD) et langues (FR / EN / AR)

- `src/lib/money.js` : devises ISO, parité **fixe** EUR/XOF (655,957), taux USD **modifiable**
  (600 XOF/USD par défaut, borné 1–100 000). `convertAmount` sert uniquement au rendu ;
  **aucun montant stocké n'est réécrit** — le second argument de `fmtMoney` reste la devise
  de référence du parking.
- `src/lib/i18n.js` : dictionnaires fr/en/ar, `t()` avec variables `{name}`, `missingKeys()`
  et `extraKeys()` pour rendre les trous de traduction visibles au lieu d'un repli silencieux.
- `src/lib/display.js` + `src/lib/useI18n.js` : état d'affichage partagé et hook React ;
  les 144 appels `fmtMoney(...)` existants n'ont pas changé de signature.
- `src/lib/experience.js` : `lang`, `currency`, `usdRate` dans les préférences utilisateur ;
  `applyUI` pose `lang` et `dir` sur `<html>` (arabe → `dir="rtl"`), `saveUI` émet `mp-appearance`.
- `src/App.jsx` : coque (navigation, titres, sous-titres, états, déconnexion) entièrement traduite.
- `src/screens/ExperienceHub.jsx` : sélecteurs de langue et de devise, taux USD éditable.
- `src/styles.css` : miroir RTL (barre latérale, navigation, toasts, tableaux numériques en LTR).
- `test-i18n-money.mjs` : couverture des dictionnaires, repli, conversion, non-mutation, RTL.

## 19.5.0 — 2026-10-23 — publication des photos vers Supabase Storage

- `src/lib/storageMedia.js` : passerelle client du bucket `vehicle-media`, la pièce qui
  manquait depuis la v18. Chemin `<lot_id>/<vehicle_id>/<kind>/<id>.<ext>` validé
  localement (identifiants `[A-Za-z0-9_-]{1,64}`, kinds photo|spin|cover|thumb, MIME
  alignés sur le bucket) avant tout appel réseau ; URL signée bornée 60 s – 24 h ;
  erreurs converties en `MediaError` avec code et chemin.
- `src/lib/mediaPublish.js` : conversion data URL → octets, publication séquentielle avec
  rapport (`published/skipped/failed`) ; un média scellé par le coffre est ignoré, jamais
  téléversé en clair ; une image corrompue n'interrompt pas les suivantes.
- `src/components/VehicleMedia.jsx` : bouton « Publier vers le cloud » dans l'onglet
  Photos & 360°, résumé chiffré du rapport et motif des refus.
- `test-storage-media.mjs` (16 assertions) et `test-media-publish.mjs` (10 assertions).

## 19.4.0 — 2026-10-23 — revue de code et revue de sécurité

- `server/auth-store.mjs` : le nom de colonne de la migration additive était interpolé
  dans un `exec()` DDL sans contrôle. Liste littérale aujourd'hui, mais aucune barrière :
  validation stricte (`^[a-z][a-z0-9_]{0,30}$` + type `TEXT|INTEGER|REAL|BLOB`) avant exécution.
- `test/regression/m8-manifest-mime.test.mjs` : précondition explicite sur `dist/sw.js` ;
  l'absence de build produisait un `404 !== 200` indiscernable d'une régression réelle.
- `test-v10-browser.mjs` : course corrigée avec le sondage de session de 15 s
  (déclenchement de `mp-auth-check` avant l'attente, délai porté à 15 s).
- `src/components/UI.jsx` : props facultatives déclarées avec défauts pour 10 primitives
  (`Card`, `Badge`, `Field`, `IconBtn`, `Empty`, `Modal`, `Switch`, `Progress`, `StatRow`, `StatusBadge`).
- `test-routes.mjs` : nouveau test qui énumère les routes `/api/` déclarées dans `server/http.mjs`
  et vérifie qu'aucune ne répond à une requête anonyme sans `401/403`.

## 19.3.0 — 2026-10-23 — durcissement des notifications et de la revue

- `src/lib/toastApi.js` : API de toasts sortie du JSX (`createToastApi`), testable sans React.
  Le contexte par défaut ne portait que `push` ; tout composant monté hors
  `<ToastProvider>` levait `TypeError: toast.ok is not a function`. Le défaut est
  désormais `NOOP_TOAST` (no-op), et `Sync.jsx` retombe sur ce no-op si le contexte est incomplet.
- `src/components/UI.jsx` : `CardHead` accepte `right` et `icon` facultatifs (défauts `null`) ;
  la classe CSS du toast est contrainte à `TOAST_KINDS` (aucune classe arbitraire injectée).
- `test-toast.mjs` : nouveau test (routage des kinds, absence de fuite d'arguments, câblage du
  provider et des défauts de `CardHead` vérifié dans la source).

## 19.2.0 — 2026-10-22
Correction de TOUS les points laissés ouverts par la revue de sécurité v19.1.

- **ÉLEVÉE (déploiement cassé)** `20261022090100_vehicle_media.sql` créait les
  policies du bucket `vehicle-media` en appelant `public.mp_member_of()` et
  `public.mp_is_admin()`, définis seulement dans `20261022090200_rls.sql`.
  Sur un projet Supabase réel, la migration 002 échouait (« function
  public.mp_member_of(uuid) does not exist »). Le bloc est déplacé dans
  `20261022090500_storage_policies.sql`, après les helpers et l'AAL2.
- **ÉLEVÉE** policies Storage jamais exécutées : ajout du harnais
  `supabase/tests/00b_storage_stub.sql` (schéma `storage`, `foldername()`), donc
  12 assertions réelles sur le bucket. Durcissements trouvés en les écrivant :
  `owner = auth.uid()` (un admin ne peut plus déposer au nom d'un tiers), ajout
  de la policy `update` (upsert impossible auparavant), `mp_is_admin_strong`
  (dépôt refusé en `aal1`), bucket `public = false` et types MIME vérifiés.
- **ÉLEVÉE** sauvegarde incomplète : `BACKUP_TABLES` n'incluait ni
  `vehiclePhotos` ni `vaults` — une sauvegarde « complète » restaurait les fiches
  véhicules **sans leurs photos**, en silence. Format passé en version 4 avec
  drapeaux `media.encrypted` / `media.vault`.
- **MOVENNE** hachages PIN hérités (`sha256×3`, FNV `fb…`) acceptés
  indéfiniment : ajout de `AUTH_DENY_LEGACY_PIN=1` pour les refuser, et
  `sweep()` remonte désormais `legacyPins` (comptage vérifiable).
- **FAIBLE** avertissement explicite en production quand `AUTH_2FA_KEY` est
  absent et que la clé de scellement est générée sur le disque de la base.

## 19.1.0 — 2026-10-22
Revue de sécurité de la v19.0.0 ; trois failles corrigées, avec tests dédiés.
- **ÉLEVÉE** le secret TOTP était stocké EN CLAIR dans `accounts.totp_secret`
  (copie de la base = codes valides à vie, donc second facteur contourné).
  Correctif : scellement AES-256-GCM (`sealSecret`/`openSecret`, préfixe `v1:`),
  clé de 256 bits lue depuis `AUTH_2FA_KEY` ou générée en `auth-store.key` (0600),
  migration automatique au démarrage (`reencryptTotpSecrets`) ; tag invalide →
  chaîne vide, donc échec fermé. Tests `t19`, `t21`.
- **ÉLEVÉE** `activateTotp` n'avait aucune limitation d'essais : un jeton de
  session volé permettait de deviner le code à 6 chiffres (10^6) et de lier
  l'authentificateur de l'attaquant. Correctif : mêmes compteurs que
  `completeMfa` (5 échecs → 429 + `Retry-After`, bon code refusé pendant le
  verrouillage). Test `t20`.
- **FAIBLE** comparaison des codes de secours via `includes()` (sortie au premier
  caractère divergent → oracle de position). Correctif : `safeEqual` (temps constant).
- Nettoyage : ternaire mort dans `photos.js`, version figée « v12 » dans le
  message de démarrage de `server/start.mjs`.

## 19.0.0 — 2026-10-22
### Second facteur (TOTP, RFC 6238) — vérifié côté serveur
- `server/totp.mjs` : HOTP/TOTP SHA-1, base32, tolérance ±1 pas, refus de rejeu
  (`lastStep`), codes de secours hachés SHA-256, URI `otpauth://`.
- `server/auth-store.mjs` : colonnes `totp_*`, table `login_challenges`
  (défi haché, usage unique, 5 min, un seul vivant par compte), méthodes
  `enrollTotp` / `activateTotp` / `completeMfa` / `disableTotp`, verrouillage
  après 5 codes faux, purge au `sweep()`.
- `server/http.mjs` : `POST /api/auth/mfa`, `/api/auth/mfa/enroll`,
  `/api/auth/mfa/activate`, `/api/auth/mfa/disable` ; `/api/auth/login` renvoie
  `{mfaRequired, challenge}` au lieu d'un cookie quand la 2FA est active.
- UI : étape « Vérification en deux étapes » dans `Auth.jsx`, panneau
  `TwoFactor.jsx` (QR généré localement, clé manuelle, codes de secours),
  onglet Administration → Sécurité.
- Politique `AUTH_2FA_POLICY=off|admin|all` : exposée comme `mfa.required`,
  elle n'empêche jamais la connexion (sinon l'admin non enrôlé se verrouille).
- `supabase/migrations/20261022090400_mfa_aal.sql` : colonne
  `memberships.mfa_enrolled`, fonctions `mp_aal()`, `mp_mfa_ok()`,
  `mp_is_admin_strong()` ; dépenses, journal d'audit, suppression de règlement,
  écriture stock et photos exigent un JWT `aal2` pour les comptes enrôlés.

### Chiffrement des photos — AES-256-GCM (WebCrypto)
- `src/lib/photoCrypto.js` : clé de données 256 bits par parking, emballée par
  une clé dérivée PBKDF2-SHA256 (310 000 itérations) de la phrase de coffre ;
  IV aléatoire de 96 bits par image ET par vignette ; intégrité GCM.
- `src/lib/photos.js` : chiffrement à l'écriture (`enc1:…`, champ `enc`),
  déchiffrement à la lecture (`openMedia`), `sealExistingMedia()` idempotent
  pour les médias antérieurs, couvertures de stock scellées aussi.
- `db.version(9)` : table `vaults` (`{sel, iv, clé emballée}` — jamais la clé).
- Verrouillage manuel + automatique (10 min par défaut), cache de vignettes
  invalidé au verrouillage, tuile « coffre verrouillé » à la place de l'image.
- `VaultPanel.jsx` : création/déverrouillage, mesure de robustesse, réglage du
  délai, chiffrement des photos existantes, limites affichées sans détour.

### Tests
- `test-totp.mjs` : 18 assertions (vecteurs RFC 6238, anti-rejeu, verrouillage,
  codes de secours, expiration du défi, révocation, politique).
- `test-photo-crypto.mjs` : 13 assertions (aller-retour, altération/troncature
  rejetées, coffre fermé, cloisonnement entre parkings, auto-verrouillage).
- Suite RLS : 53 assertions, dont 10 nouvelles sur `aal1`/`aal2`.

