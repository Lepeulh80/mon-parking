# MON PARKING v12 — corrections de déploiement

## Guide prioritaire v12

Cette version conserve les sessions serveur révocables de v11. Les tests fonctionnels de v11 passaient, mais sept contrôles de déploiement ajoutés échouaient. Ils passent après correction : lecture de `.env`, refus de démarrer sans build, base d'authentification interdite dans `dist`, HTTPS obligatoire en production, vraie disponibilité du service, refus de servir des fichiers sensibles et gestion des URL malformées sans arrêt du serveur. Les modifications et preuves sont dans `audit-evidence/v12/`.

### 1. Préparer l'application (Node 22.23+ ; 24 recommandé)

```sh
npm ci
npm run test:all
npm run build
```

`npm run test:all` démarre ses propres fixtures locales pour les tests navigateur. Définir `CHROME` si le navigateur Chrome n'est pas au chemin du sandbox. Ne pas fournir `BASE` pointant vers une production : les tests de sécurité modifient des PIN de test. Le script `typecheck` vérifie JS/JSX avec `checkJs=false`, pas un typage TypeScript strict.

### 2. Configurer l'environnement réel

Pour un essai LOCAL seulement : `cp .env.example .env`, puis `npm start`. Pour Internet : copier `.env.production.example` en `.env`, remplacer `AUTH_ORIGIN` par votre vrai domaine HTTPS (sans chemin), puis renseigner `AUTH_DB` avec un fichier sur disque persistant **hors du répertoire dist**. Aucun mot de passe ni clé privée ne doit être ajouté aux variables `VITE_*`. Les scripts `npm start`, `auth:setup`, `auth:import` et `deploy:check` lisent désormais `.env` automatiquement ; les variables du processus gardent la priorité.

Exemple de paramètres à adapter :

```dotenv
NODE_ENV=production
AUTH_ORIGIN=https://parking.votre-domaine.fr
HOST=127.0.0.1
PORT=3000
AUTH_DB=/var/lib/mon-parking/auth.sqlite
```

Créer le répertoire persistant avec le propriétaire correspondant au compte système qui exécute Node ; il doit pouvoir écrire dans le fichier et son répertoire (SQLite WAL). Pour un conteneur, conserver un volume persistant et utiliser `HOST=0.0.0.0` si nécessaire. Ne pas partager des fichiers SQLite indépendants entre réplicas : la configuration livrée est mono-instance.

### 3. Provisionner le premier administrateur

Préparer **hors du projet**, avec permissions privées, un JSON contenant vos valeurs : `username`, `name`, `pin` (chaîne de 4 à 12 chiffres choisie par vous), `lotName`. En cas de migration, conserver aussi les `userId` et `lotId` existants pour rattacher les données locales. Aucun compte serveur de démonstration n'est créé automatiquement.

```sh
chmod 600 /chemin/prive/compte-initial.json
npm run auth:setup < /chemin/prive/compte-initial.json
# Pour des comptes existants : voir auth:import et les contraintes de confiance ci-dessous.
npm run deploy:check
```

`deploy:check` exige une configuration de production, un vrai domaine configuré (pas example.com), un build, une base hors du Web, des droits sur la base, un administrateur actif et l'absence de secrets évidents dans les variables publiques VITE. Pour un diagnostic LOCAL uniquement : `npm run deploy:check -- --local`. La vérification ne crée pas de compte et n'affiche pas les PIN. Après provisionnement, supprimer le JSON privé s'il n'est plus nécessaire et le protéger dans toute sauvegarde.

### 4. Démarrer et vérifier

```sh
npm start
# Dans un autre terminal :
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz
```

La connexion est limitée par origine réseau (`AUTH_MAX_LOGIN_ATTEMPTS`, défaut
20 tentatives / 15 minutes, en-tête `Retry-After`) ; derrière Caddy/Nginx,
définir `AUTH_TRUST_PROXY=1` pour compter par client réel. Les sessions expirées
et le journal d'authentification de plus de 180 jours sont purgés au démarrage.
Un identifiant ne peut appartenir qu'à un seul compte : deux parkings distincts
ne peuvent pas réutiliser le même nom d'utilisateur.

La CSP est appliquée aux pages HTML servies par `server/http.mjs` : aucun script inline, worker OCR autorisé (`worker-src blob:`), WASM autorisé (`'wasm-unsafe-eval'`). Les coordonnées du personnel (téléphone, e-mail) sont stockées dans la table `accounts` ; les bases v12 reçoivent les colonnes manquantes automatiquement au démarrage (migration additive).

`/healthz` indique uniquement que le processus répond (200). `/readyz` renvoie 503 avec `ADMIN_REQUIRED` tant que le premier administrateur serveur manque, puis 200 lorsque le build et la base/comptes sont disponibles. Ces points de contrôle ne révèlent aucun identifiant. La validation locale ne prouve pas que DNS, TLS public, stockage durable et sauvegardes fonctionnent sur votre hébergeur.

### 5. Exposer le domaine en HTTPS

Sur un VPS, placer Caddy ou Nginx devant Node et conserver l'en-tête Host original. Le domaine du proxy doit correspondre à AUTH_ORIGIN. Le modèle `deploy/Caddyfile` doit être modifié avant utilisation ; faire pointer le DNS et ouvrir 80/443. Ne pas exposer le port Node 3000 sur Internet quand il écoute derrière le proxy. Le modèle `deploy/mon-parking.service` suppose `/opt/mon-parking`, l'utilisateur/groupe `monparking`, `/usr/bin/node` et `/var/lib/mon-parking` : créer ces éléments et adapter les chemins avant installation. Vérifier la syntaxe du proxy et du service sur la machine cible avant activation.

**Ces modèles ne sont pas des déploiements déjà effectués.** Docker et Caddy n'étaient pas disponibles dans l'environnement de validation ; aucun lancement de ces services ni certificat public n'est revendiqué. Le serveur Node, ses contrôles de disponibilité, son provisionnement et la configuration de production sont testés localement. Un hébergement purement statique ne suffit pas pour cette application.

### 6. Recette de préproduction

Ouvrir le vrai domaine HTTPS, vérifier la connexion, deux onglets, déconnexion puis rechargement, réinitialisation du PIN et refus des anciennes sessions. Vérifier aussi ventes, reçu/PDF, scan caméra (permission HTTPS), état des places, redémarrage et restauration d'une sauvegarde. Garder la base persistante hors des mises à jour du code. La v12 n'active pas automatiquement les banques, la biométrie, les notifications distantes ou un serveur financier global ; les limites v11 ci-dessous restent applicables. Hors ligne, l'accès reste verrouillé sans validation serveur et les données ne sont pas effacées.

---

## Historique et limites héritées de v11

Audit correctif sur v10. Lire **AUDIT.md** (causes, corrections, limites et preuves) et **CHANGELOG.md** avant déploiement. Fonctions existantes conservées ; ajout de la migration 011_13.

Vérifications : `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:audit`, `npm run build`. Le script typecheck vérifie la syntaxe/le graphe JS/JSX, pas un typage strict.

Pour une base Supabase déjà en v10 : appliquer uniquement `migrations/011_13_audit_integrity.sql`. Sauvegarder et essayer en préproduction avant toute migration réelle. Les anciens PIN sont migrés après connexion réussie. Les documents encaissés ne sont plus supprimables sans processus d’avoir/remboursement.

## Correctif sessions serveur — à lire avant lancement

La session locale précédente (`mp_session` contenant des identifiants) n'est plus une preuve. Le navigateur doit obtenir et faire vérifier un cookie opaque `__Host-mp_sid` par le nouveau serveur Node. Il n'y a aucun compte serveur créé automatiquement et aucun repli vers une validation IndexedDB.

### Lancement et provisionnement

Node **22.23 ou plus récent** (24 recommandé), HTTPS en production, un seul serveur d'authentification avec stockage SQLite persistant. Le module `node:sqlite` est natif ; son avertissement expérimental sous Node 22 ne concerne pas le résultat des tests. Aucun secret d'authentification n'est exposé dans les variables `VITE_*`.

```sh
npm ci
npm run build
# Sur le serveur uniquement, lire un JSON de provisionnement choisi par vous :
# {"username":"...","name":"...","pin":"...","lotName":"...","userId":"...","lotId":"..."}
npm run auth:setup < /chemin/protege/compte-initial.json
# Exemple de développement local ; employer votre vraie origine HTTPS en production.
AUTH_ORIGIN=http://127.0.0.1:3000 PORT=3000 npm start
```

Les IDs optionnels `userId`/`lotId` doivent correspondre aux données existantes pour les conserver. L'alternative `npm run auth:import -- /chemin/protege/utilisateurs.json` importe **uniquement dans une base serveur vide**, depuis un fichier de confiance contenant `{lots:[...],users:[{id,lotId,username,name,role,active,pinHash,salt},...]}`. Aucun import d'identité reçu du navigateur n'est autorisé. Les anciens hashes SHA-256, fallback et PBKDF2-310000 sont vérifiés puis migrés vers PBKDF2-600000 lors de la connexion. Les exports ordinaires de l'application excluent les hashes : ils ne constituent pas à eux seuls un fichier d'import des comptes. Un opérateur doit donc provisionner/réinitialiser les comptes côté serveur ou préparer cet import par une procédure sécurisée.

`AUTH_DB` désigne le fichier SQLite (défaut `.server-data/auth.sqlite`, hors `dist`). Sauvegarder ce fichier de manière sécurisée ; il contient des hashes d'identifiants et les empreintes des sessions. Ne pas le publier, ne pas partager des copies divergentes entre plusieurs réplicas. Pour plusieurs instances/HA, remplacer ce stockage par un stockage transactionnel central partagé avant déploiement. Les clés TLS natives peuvent être fournies via `AUTH_TLS_KEY` et `AUTH_TLS_CERT`, sinon placer le serveur derrière un reverse proxy HTTPS conservant l'en-tête Host et la même origine. `AUTH_ORIGIN` est obligatoire et doit être l'origine exacte exposée au navigateur.

### Comportement de sécurité

- Jeton aléatoire de 256 bits ; seule son empreinte SHA-256 est stockée côté serveur. Cookie `HttpOnly; Secure; SameSite=Strict; Path=/`, expiration absolue **8 heures**. Les IDs client et les jetons fabriqués sont ignorés/refusés.
- Rotation à la connexion ; révocation du jeton courant à la déconnexion. Une modification/réinitialisation de PIN incrémente la génération et supprime toutes les sessions du même compte/principal, y compris ses accès multi-parking regroupés lors du provisionnement.
- Chaque route API protégée valide le cookie, l'état du compte, sa génération et l'expiration. Les réponses d'authentification sont `no-store`. Une réponse 401 tardive ne doit pas effacer un cookie plus récent ; seules les actions explicites concernées effacent leur cookie.
- L'interface revalide au chargement, au focus, aux événements entre onglets et toutes les **2 secondes**. Le serveur refuse immédiatement une session révoquée ; l'interface des autres onglets peut donc se verrouiller avec ce court délai.
- **Changement volontaire du mode hors ligne :** sans validation serveur, l'interface se verrouille. Les données PWA/IndexedDB ne sont pas effacées et redeviennent accessibles après revalidation en ligne. Aucune promesse de connexion hors ligne sécurisée n'est faite. Une déconnexion non confirmée hors réseau reste verrouillée et est réessayée en ligne.
- La première création de compte se fait avec l'outil serveur ; l'auto-inscription locale ne peut plus créer une identité autorisée. L'administration connectée utilise les API protégées pour les comptes et nouveaux parkings.
- Les sessions Supabase historiques demeurent un domaine d'authentification distinct ; le bouton de déconnexion tente aussi la fermeture locale du SDK, sans prétendre révoquer globalement les jetons Supabase. Le stockage financier local n'est pas devenu une base serveur transactionnelle ni un coffre chiffré par ce correctif.

### Tests et preuves livrés

`npm run test:sessions` exécute 21 contrôles HTTP/SQLite réels (cookies, rotation, replay, PIN, autres sessions, expiration serveur, rôle/parking, CSRF, redémarrage et concurrence). `npm run test:pin` conserve les 10 scénarios PIN. `npm run test:all` lance tous les tests, construit la PWA puis démarre un vrai serveur local isolé pour les tests navigateur. `CHROME` peut désigner votre exécutable Chrome ; `BASE` permet de cibler explicitement un serveur de test existant. Ne pas exécuter les scénarios qui changent les PIN contre un environnement de production.

Les fixtures de démonstration sont confinées aux scripts de test et ne sont jamais importées par `server/start.mjs`. Les données démo locales ne créent aucune autorité serveur. Le contrôle navigateur offline a été renforcé : verrouillage hors ligne et préservation des données après reconnexion, plutôt qu'une restauration locale non authentifiée.

Les sorties avant/après sont dans `audit-evidence/session-fix/`. Avant correction : les trois scénarios de preuve persistante échouent, le script de revue reproduit les deux bugs, et l'ancien déploiement sans serveur échoue au contrat HTTP. Cinq contrôles internes SQLite n'étaient pas exécutables sur l'ancien déploiement puisqu'il n'avait aucune base de sessions ; ils sont explicitement marqués non applicables dans le journal de comparaison, et exécutés sur le nouveau vrai serveur. Aucun contrôle interne absent n'est compté comme une réussite avant correction. Le test supplémentaire de réponse 401 tardive échoue avant sa correction et passe après.

Les rapports AUDIT.md/CHANGELOG.md généraux sont antérieurs à ce correctif ; cette section et les nouveaux logs précisent sa portée. Ce correctif n'est pas une certification de sécurité complète.

## Run historique (le backend ci-dessus reste obligatoire pour l'authentification)

```sh
npm install
npm run dev
npm test
npm run build
npm run preview
```

Recent evergreen Chrome/Edge/Firefox/Safari; camera and browser cryptography
require HTTPS or localhost. Web Push/WebAuthn availability varies by device.
Demo PIN accounts are NOT production accounts. Do not deploy them unchanged.
Browser tests require Chrome and can use the CHROME and BASE environment variables.

## Feature matrix

| Tier | Features | Real status |
|---|---|---|
| In-browser | Dark default / light, slate-mint-blue palette, contrast, zoom, reduced motion, focus-visible, labelled forms, modal keyboard trap, skip link | Implemented; no formal WCAG certification |
| In-browser | Per-user/per-lot widgets, keyboard reorder, Framer Motion respecting reduced motion, SVG point selection/tables | Local IndexedDB updates; cloud ticket polling is 15 s, not zero-latency |
| In-browser | Transaction date/absolute-amount/category/account filters, CSV and PDF, monthly spending and net flow | Declared/imported cash flows, NOT verified bank balances or legal profit |
| In-browser | Multiple named CSV accounts, parser validation and deduplication | Real local CSV import; no live banking access |
| In-browser | Explicitly labelled optional bank demo data | Mock data, never a bank connection |
| In-browser | Monthly category budgets, deduplicated alerts, local inbox and opt-in browser notifications | Works while data is available locally; not server push |
| In-browser | Camera getUserMedia, Tesseract/WASM, known-plate recall, operator confirmation and learned confusion costs | Preserved; learning committed only on final confirmation |
| In-browser | Per-city/parking-zone observed OCR outcomes and low-confidence alerts | Sample counts, not a certified accuracy rate; no automatic GPS |
| In-browser | PWA cache / IndexedDB, offline consultation, queued ticket/OCR retries | Requires initial successful load/cache; external auth/banks cannot work offline |
| In-browser | AES-256-GCM encrypted backup, PBKDF2-SHA256 310000 iterations, decrypt/restore | Actual cryptography; password/key is not persisted; no recovery without password |
| Backend scaffold | Supabase PostgreSQL v7/v9 RPCs plus v10 own-profile sync and encrypted snapshot RPC | Must deploy SQL and configure real URL/key/Auth/memberships; not live-tested on your project |
| Backend scaffold | Supabase TOTP enroll/challenge/verify and assurance-level display | Actual SDK calls when configured; no local/mock second factor |
| Backend scaffold | Five roles / RLS / append-only event records; AAL2 required by v10 vault | Local role checks are NOT server security; legacy RPCs need global AAL2 hardening |
| Provider | Bank aggregation, Google Drive/Dropbox OAuth | HTTPS BFF adapter contract only; provider credentials, consent, webhooks and server token storage required |
| Provider | WebAuthn biometrics | Native browser challenge/assertion adapter; server enrollment/verification required; no fingerprint/face templates handled here |
| Provider | Remote Web Push | Service-worker handler/subscription adapter; VAPID server and authenticated registration/dispatch required |
| Provider | End-to-end cloud sync of all data / high availability | NOT implemented/guaranteed. Only encrypted snapshot files are opaque to storage. Parking fee server reads ticket fields |

## Boundaries and deployment

- Configure `.env.local` from `.env.example` or the existing admin Supabase panel.
  Never put bank passwords, service_role, OAuth refresh tokens or provider
  secrets in VITE_* (these variables are public in the client bundle).
- New SQL migration: `migrations/010_12_personal_preferences_vault.sql` after
  existing 008 and 009 migrations. It relies on Supabase auth.uid()/auth.jwt().
- TOTP needs a real Supabase Auth session, separate from local PIN login.
  AAL2 is enforced for the v10 encrypted cloud vault, not every legacy endpoint.
- Personal UI preference sync buttons call the v10 RPC manually. Ticket/OCR
  automatic polling/retry remains the existing v9/v7 implementation.
- Active IndexedDB financial records are plaintext in this module. Device
  security, browser storage protection, XSS prevention and a reviewed encrypted
  local vault are required before storing sensitive banking data.
- Bank CSV and application payments are intentionally separate scopes, avoiding
  automatic double counting. No automatic reconciliation is claimed.
- Backup passwords are never stored; losing the phrase means losing access to
  that encrypted file. A weak phrase remains vulnerable to offline guessing.
- Notifications on lock screens contain generic text. Browser notification
  consent is explicit. No bank transaction/plate detail is sent by the default
  service worker. Remote push is not connected without a server.
- OCR zone reports measure `unchanged / operator-validated observations`, not
  recognition accuracy against independently labelled ground truth. City and
  zone are declared site metadata; location permission/GPS is not collected.

## External BFF adapter contract (not a provided production server)

`POST HTTPS VITE_INTEGRATION_BFF_URL`, bearer Supabase session token,
body `{provider: bank|drive|dropbox|webauthn|push, ...payload}`.
The server must validate JWT, tenant, scopes and AAL2 for sensitive actions;
store OAuth/provider tokens encrypted server-side; manage consent, revocation,
rate limits and signed bank/push callbacks. WebAuthn challenge and origin/RP ID,
signature, counter and user-verification checks belong to the server.
A browser-reported successful credential is NOT proof until server validation.
Drive/Dropbox uploads must receive ciphertext files, not clear backups, when
end-to-end confidentiality is required.

## Privacy / accessibility

No automatic GDPR/RGPD compliance or availability guarantee. Before production:
legal basis and notices, retention/deletion policy (including remote copies),
processor contracts, access/erasure workflows, breach process, audit/DPIA where
appropriate, independent security/accessibility tests, load tests, restore
exercises, monitoring and provider SLA. Exported CSV/PDF are cleartext files;
store/share them securely. The browser PIN is not MFA or encryption.

## Tests

- Existing v7/v8/v9 suites stay enabled.
- v10 tests cover UI normalization, transaction filters, CSV import/dedup,
  monthly totals, budget alert dedup, encryption/decryption/tamper rejection,
  TOTP SDK adapter mocks (NOT live Auth), disabled external adapters, per-zone
  OCR observations and a real Tesseract sample image/learned confusion ranking.
- v10 PostgreSQL tests run migrations/RLS/AAL2 in embedded PostgreSQL with
  explicit auth test stubs. This is not a real Supabase deployment test.
- Browser tests cover dark/light/contrast, keyboard/modals, personalization,
  finance filters/CSV/PDF, demo labelling, budgets, mobile/tablet/desktop and
  offline reload. Captures are exported static DOM snapshots of tested pages.

## Base Postgres / Supabase

Le schéma de référence est versionné dans `supabase/migrations/` et s'applique
sur un projet Supabase (ou tout PostgreSQL 15+) :

| Fichier | Contenu |
| --- | --- |
| `20261022090000_core.sql` | `lots`, `memberships`, `vehicles`, `clients`, `sales`, `payments`, `expenses`, `stock_moves`, `audit_log`, `spots`, `tickets`, `reservations` — clés étrangères, index, contraintes `CHECK`, `UNIQUE (lot_id, plate)`, `sales.paid <= sales.total` |
| `20261022090100_vehicle_media.sql` | `vehicle_photos` (photos et prises 360°), index de couverture unique, trigger de recalcul `photo_count`/`frame_count`, bucket Storage `vehicle-media` avec ses policies |
| `20261022090200_rls.sql` | `ENABLE ROW LEVEL SECURITY` sur les 13 tables et policies par rôle |
| `20261022090300_audit_and_numbering.sql` | journal d'audit chaîné par SHA-256, vérification `mp_audit_verify()`, numérotation atomique des factures/reçus, garde de cumul des paiements |

### Modèle de permissions

| Table | `anon` | employé (`employe`) | admin du parking |
| --- | --- | --- | --- |
| `lots` | refusé | lecture | lecture + écriture |
| `memberships` | refusé | sa propre ligne | toutes celles de son parking |
| `vehicles` | refusé | lecture | lecture + écriture + suppression |
| `vehicle_photos` | refusé | lecture | lecture + écriture |
| `clients` | refusé | lecture + création | tout |
| `sales` | refusé | insertion **en son nom** | tout |
| `payments` | refusé | insertion | tout (suppression admin) |
| `expenses`, `audit_log` | refusé | refusé (audit : insertion seule) | lecture + écriture |
| `spots`, `tickets`, `reservations` | refusé | lecture + entrées/sorties | tout |

Une policy ne peut pas interroger sa propre table sans récursion : les
contrôles passent par les fonctions `SECURITY DEFINER` `mp_member_of()`,
`mp_role_of()`, `mp_is_admin()`, `mp_can_sell()` et `mp_uid()` (qui lit
`auth.uid()`).

### Appliquer le schéma

```bash
# Supabase CLI (projet lié)
supabase link --project-ref <ref>
supabase db push

# ou, sans CLI : coller chaque fichier dans le SQL Editor, dans l'ordre
```

### Tests RLS

```bash
npm run test:rls
```

Le script crée une base `mon_parking_rls_test`, applique un harnais `auth`
(rôles `anon`/`authenticated`, `auth.uid()` lisant `request.jwt.claims`),
joue les quatre migrations puis la suite, et supprime la base à la fin
(`--keep` pour la conserver). Il échoue si PostgreSQL est absent au lieu de
faire semblant. `DATABASE_URL` permet de cibler un PostgreSQL/Supabase de
test distant.

Les assertions s'exécutent réellement sous `SET ROLE authenticated` avec les
claims d'un utilisateur donné : un `UPDATE` inter-parkings ne lève pas
d'erreur en PostgreSQL, il touche simplement 0 ligne — les tests vérifient
donc `ROW_COUNT`, et `SELECT count(*)` exact pour les absences. Des contrôles
positifs (l'admin voit bien ses 2 photos, sa dépense, son parking) empêchent
une policy « deny all » de passer pour un succès.

## Double authentification (TOTP)

La connexion de MON PARKING est servie par le serveur Node (`server/auth-store.mjs`
+ cookie `HttpOnly`), pas par Supabase Auth : `supabase.auth.mfa` ne peut donc
pas ouvrir cette session. Le second facteur est vérifié **côté serveur**
(`server/totp.mjs`, RFC 6238), et les policies RLS savent en plus exiger un JWT
`aal2` pour les comptes enrôlés.

| Étape | Route | Effet |
| --- | --- | --- |
| Connexion | `POST /api/auth/login` | renvoie `{mfaRequired, challenge}` — **aucun cookie** |
| Vérification | `POST /api/auth/mfa` | `{challenge, code}` → cookie de session |
| Enrôlement | `POST /api/auth/mfa/enroll` | secret base32 + URI `otpauth://`, affiché une fois |
| Activation | `POST /api/auth/mfa/activate` | `{code}` → 8 codes de secours (une seule fois) |
| Désactivation | `POST /api/auth/mfa/disable` | `{pin}` → révoque toutes les sessions |

Garde-fous : défi stocké haché, usage unique, 5 minutes, un seul vivant par
compte ; code refusé s'il a déjà servi (anti-rejeu) ; 5 codes faux verrouillent
le facteur une minute ; réinitialisation du PIN par l'admin annule la 2FA ;
politique `AUTH_2FA_POLICY=off|admin|all`.

```bash
npm run test:totp     # vecteurs RFC 6238 + parcours serveur complet
npm run test:rls      # dont 10 assertions aal1/aal2 contre PostgreSQL réel
```

## Chiffrement des photos

AES-256-GCM via WebCrypto, dans le navigateur — les images ne quittent pas
l'appareil.

- Une clé de données (DEK) de 256 bits par parking, **jamais stockée en clair** :
  elle est emballée par une clé dérivée (PBKDF2-SHA256, 310 000 itérations, sel
  de 16 octets) de la phrase de coffre. La table `vaults` ne contient que
  `{sel, iv, clé emballée}`.
- Chaque image **et chaque vignette** est chiffrée séparément avec un IV aléatoire
  de 96 bits : deux photos identiques donnent deux chiffrés différents.
- `openMedia()` déchiffre à la lecture ; coffre fermé, l'interface affiche une
  tuile « coffre verrouillé » et n'obtient jamais le clair.
- Verrouillage manuel et automatique (10 min d'inactivité par défaut), cache de
  vignettes vidé au verrouillage, `sealExistingMedia()` pour les photos déjà
  présentes (idempotent).

**Limites assumées** : un appareil déverrouillé avec l'application ouverte garde
la clé en mémoire (une XSS ou une extension peut la lire) ; une phrase de coffre
faible est attaquable hors ligne ; une phrase perdue rend les photos
irrécupérables — il n'existe aucune clé de secours, par choix.

```bash
npm run test:crypto    # 13 assertions : altération, troncature, cloisonnement…
```
