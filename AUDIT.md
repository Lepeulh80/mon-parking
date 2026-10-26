# Audit correctif — MON PARKING v11

Base : archive v10 fournie dans cette conversation. Audit exécuté sur une copie séparée ; aucune base distante réelle modifiée.

## Résultats avant / après

| Contrôle | Avant (v10) | Après (v11) |
|---|---|---|
| Tests métier existants (9 scripts) | Réussis | Réussis, maintenus |
| 14 régressions métier ajoutées | 14 échecs reproduits | 14 réussites |
| 2 défauts SQL ajoutés | 2 échecs reproduits | 2 réussites + 2 contrôles positifs/isolation |
| Sécurité / compatibilité / PDF / tarif nul | Non couverts par ces nouveaux cas | 6 contrôles réussis |
| Navigateur | Non réexécuté avant corrections dans cet audit | 53 contrôles : 19 + 20 + 14 |
| Build PWA | Réussi | Réussi |
| Lint | Script absent ; scan direct : 0 erreur, 69 avertissements | Script présent ; 0 erreur, 0 avertissement |
| Vérification JS/JSX | Script absent ; contrôle direct réussi | Script présent ; contrôle réussi |
| Duplication jscpd (10 lignes / 80 tokens) | 1 bloc de reçus PDF | Aucun bloc détecté au même seuil |
| Audit dépendances de production | 3 paquets signalés : 1 critique, 1 élevé, 1 modéré | 0 ; audit incluant aussi dev : 0 |

Le script typecheck contrôle le graphe JS/JSX avec checkJs=false : ce n’est pas une preuve de typage TypeScript strict. Les anciens tests étaient verts malgré les 16 nouveaux défauts reproduits. Deux fixtures de test sans type de document ont été complétées avec type=vente pour continuer à tester spécifiquement le refus du véhicule indisponible ; aucune assertion supprimée.

## Problèmes, causes et corrections

| ID | Problème et repère v11 | Cause | Correction |
|---|---|---|---|
| B01 | **Création multi-parking cassée** — `src/lib/admin.js:3` | La requête where(ownerKey) ciblait une propriété non indexée et échouait dans Dexie. | Suppression de la requête inutile ; validation du nom et autorisation relue dans le stockage. |
| B02 | **Retour appliqué à une vente** — `src/lib/db.js:250` | Le retour ne contrôlait pas le type du document et pouvait remettre une voiture vendue en stock. | Retour limité aux locations. |
| B03 | **Retour de location inter-parking/non autorisé** — `src/lib/db.js:254` | L’acteur et son parking n’étaient pas contrôlés dans returnRental. | Contrôle des permissions persistées dans la transaction, sans faire confiance au rôle transmis. |
| B04 | **Annulation financière destructrice** — `src/lib/db.js:282` | Une vente payée pouvait être supprimée avec ses règlements sans contrepassation ; l’écran transmettait un administrateur fictif. | Acteur réel depuis Sales.jsx ; autorisation serveur local relue, refus des documents encaissés, refus de libérer un véhicule encore mobilisé. Erreur affichée. Aucun faux remboursement créé. |
| B05 | **Montants conservés sous forme de texte** — `src/lib/db.js:149` | Les contrôles numériques ne remplaçaient pas les valeurs stockées ; les additions pouvaient concaténer des chaînes. | Normalisation et arrondi des montants à l’entrée, contrôle du type vente/location, additions numériques au retour/règlement. |
| B06 | **Arrivée sur une place réservée impossible** — `src/lib/parking.js:243` | createTicket exige une place libre, alors que saveReservation avait passé la place en reserve. | Conversion atomique réservation/place/ticket, relecture de la réservation, de sa période et de son parking ; double arrivée refusée. |
| B07 | **Réservation d’une place étrangère** — `src/lib/parking.js:199` | saveReservation ne vérifiait pas le parking de la place ou de la réservation modifiée. | Validation du rattachement de la place et de la réservation au parking. |
| B08 | **Réservations aux dates incohérentes** — `src/lib/parking.js:195` | Dates invalides, absentes ou fin antérieure au début acceptées. | Validation des bornes avant écriture, dans la transaction anti-chevauchement existante. |
| B09 | **L’apprentissage pouvait dégrader un score OCR** — `src/lib/match.js:112` | Une substitution visuelle coûtait 0,25 mais son premier coût appris actif valait 0,45. | Coût appris plafonné au coût de base de la même substitution ; direction des confusions conservée. |
| B10 | **Import CSV acceptant un montant vide** — `src/lib/financeHub.js:34` | Number("") donnait zéro et créait une fausse opération. | Montant vide traité comme invalide avant import. |
| B11 | **Prestataire d’intégration écrasable** — `src/lib/securityHub.js:22` | L’étalement du payload après provider permettait de remplacer le prestataire déjà validé. | provider validé écrit en dernier, sans introduire d’identifiants externes. |
| B12 | **Recettes affectées au mauvais jour/mois** — `src/lib/parking.js:263` | Comparaison d’une date UTC avec le jour civil du poste, incorrecte près de minuit. | Agrégation sur les composantes calendaires locales du poste ; test explicite en fuseau America/Los_Angeles. Un fuseau propre à chaque parking reste à définir si les postes diffèrent. |
| B13 | **Un conflit gelait toutes les places** — `src/lib/parkingSync.js:77` | Le prédicat bloquait chaque place dès qu’un ticket quelconque était en attente. | Seules les places réellement concernées sont protégées ; les autres reçoivent les mises à jour cloud. |
| B14 | **Encaissements cloud comptés deux fois** — `src/lib/parkingSync.js:90` | Un mouvement provisoire restait pendingCloud après intégration au total de caisse serveur. | Rapprochement des mouvements et du total serveur dans une même transaction locale ; les conflits restent visibles. |
| B15 | **Politiques RLS récursives** — `migrations/011_13_audit_integrity.sql:3` | is_member/is_lot_admin relisaient memberships protégée par des politiques faisant appel à ces mêmes fonctions. | Fonctions SECURITY DEFINER à search_path fixe et tables qualifiées ; exécution réservée à authenticated, pas de SQL dynamique. |
| B16 | **Coffre acceptant des archives incomplètes** — `migrations/011_13_audit_integrity.sql:15` | Les métadonnées AES/KDF suffisaient ; sel, nonce et ciphertext pouvaient manquer. | Validation structurelle, Base64, longueurs, version et taille ; MFA AAL2 conservé. Contrainte NOT VALID pour ne pas détruire les anciens objets invalides. |
| B17 | **Un clic OCR pouvait activer plusieurs confirmations** — `src/lib/learning.js:94` | Une même confusion répétée dans une plaque était comptée plusieurs fois dans un seul événement. | Décompte d’une paire au maximum une fois par validation ; seuil minimal inchangé. |
| B18 | **Protection cryptographique insuffisante des PIN** — `src/lib/db.js:94` | Trois tours de SHA-256, sel Math.random et ancien fallback non cryptographique étaient trop faibles contre les essais hors ligne. | Nouveaux PIN PBKDF2-SHA256 310000 itérations, sel cryptographique de 16 octets. Compatibilité anciens SHA/fallback et migration à la connexion réussie ; création refusée sans Web Crypto. Ne transforme pas l’authentification locale en frontière serveur. |
| B19 | **Dépendances PDF vulnérables** — `package.json:25` | npm audit remontait jsPDF critique, AutoTable élevé et DOMPurify modéré dans l’arbre de production. | jsPDF 4.2.1 et jspdf-autotable 5.0.9 ; adaptation de l’import nommé et tests PDF. Audit final complet sans avis connu à la date du contrôle. |
| B20 | **Tarif gratuit remplacé par le tarif du parking** — `src/lib/parking.js:277` | L’opérateur || considérait un tarif horaire explicitement nul comme absent. | Utilisation de ?? dans l’estimation et le reçu PDF ; test conservant une estimation à zéro. |

## Nettoyage effectué

- Imports, variables et calculs sans usage supprimés après inventaire de références et analyse ESLint/AST ; avertissements inutiles retirés.
- Dépendance animejs supprimée (aucun import de l’application). GSAP, Framer Motion et Three.js conservés car utilisés.
- En-tête des deux petits reçus PDF mutualisé sans changer leur taille (80 × 160 mm et 80 × 150 mm).
- Constantes de coût dupliquées dans learning.js retirées ; définition du matcher conservée. Fonction securityStatus sans consommateur supprimée.
- PIN historiques gardés uniquement pour leur vérification/migration. Les clés pinHash/salt restent explicitement exclues des sauvegardes ; leur omission n’a pas été supprimée comme un faux « code mort ».
- Inventaire des exports sans référence interne conservé dans audit-evidence/unused-exports.json. Les API publiques potentiellement utilisées par un consommateur externe restent conservées par prudence.
- Knip a échoué pour des raisons d’outil/runtime (allocation du parseur puis API TypeScript incompatible). Ce n’est pas une preuve de syntaxe cassée du projet. Inventaire de repli : AST TypeScript + références, ESLint et jscpd.

## Déploiement et compatibilité

1. Faire une sauvegarde locale et cloud avant remplacement des fichiers.
2. Installer avec npm ci, puis npm run lint, npm run typecheck, npm test, npm run test:audit, npm run build.
3. Si Supabase est déjà en v10, appliquer uniquement migrations/011_13_audit_integrity.sql en tant que propriétaire de la base. Installation neuve : schéma principal, SQL OCR, puis toutes les migrations numérotées dans l’ordre.
4. Examiner les anciens objets avec SELECT id FROM public.v10_encrypted_snapshots WHERE NOT public.v11_valid_envelope(envelope); réparer/quarantainer suivant la politique de sauvegarde, puis ALTER TABLE public.v10_encrypted_snapshots VALIDATE CONSTRAINT v11_complete_envelope; aucune ancienne archive n’est effacée automatiquement.
5. Les comptes existants gardent leur PIN ; le hash est renforcé après une connexion réussie. HTTPS ou localhost obligatoire. Les comptes de démonstration ne doivent pas être utilisés en production.
6. Les factures avec règlements ne sont plus supprimables : un avoir et un remboursement contrôlés sont nécessaires. Aucun moteur d’avoirs ou remboursement bancaire réel n’est livré dans cet audit.
7. Tests navigateur : lancer npm run preview sur le port 4173 puis BASE=http://127.0.0.1:4173/ CHROME=/chemin/vers/chrome npm run test:browser. Le parcours de cet audit utilise un preview isolé sur 4186.

## Limites et risques restant à traiter

- Pas de connexion ni test de charge sur votre vrai projet Supabase ; SQL vérifié sur PostgreSQL embarqué (PGlite), SDK/multi-postes avec adaptateurs de test. Les migrations doivent être essayées sur une préproduction sauvegardée.
- RLS corrigée ne signifie pas durcissement complet de tous les anciens accès directs : certaines politiques historiques donnent encore des écritures larges aux membres. Verrouiller les écritures financières côté serveur et imposer globalement AAL2 restent des chantiers de production.
- L’authentification PIN locale et les règles JavaScript ne protègent pas contre un propriétaire malveillant du poste ou une modification d’IndexedDB. Authentification serveur unifiée et MFA global restent nécessaires.
- Les données actives IndexedDB restent en clair ; seul le fichier de sauvegarde chiffré offre la confidentialité annoncée. Aucun chiffrement de bout en bout global ni certification RGPD/WCAG n’est revendiqué.
- Banques, WebAuthn, Drive/Dropbox et push distant restent des adaptateurs non connectés sans services externes. Aucune fonctionnalité annoncée comme connectée fictivement.
- Synchronisation tickets/OCR existante conservée (polling, files d’attente et conflits) ; pas de garantie de disponibilité serveur, d’instantanéité ou d’absence de tout bug.
- Le jour comptable corrigé utilise le fuseau du navigateur. Définir un fuseau par parking pour des postes répartis géographiquement.
- Tests limités à des scénarios contrôlés et à la fixture OCR incluse ; une précision caméra terrain universelle n’est pas démontrée.

## Preuves et reproduction

Les logs, rapports JSON avant/après et inventaires sont fournis dans audit-evidence/. Les tests de non-régression portables sont dans scripts/audit-regressions.mjs, scripts/audit-sql-regressions.mjs et scripts/test-v11-security.mjs. Le script SQL peut rejouer la chaîne v10 avec AUDIT_PHASE=before (exclut la migration 011). Pour rejouer les défauts métier avant correction, utiliser l’archive v10 originale avec le même harnais. Les journaux initiaux/partiels d’itération ne remplacent pas les logs finaux tests-after.log, audit-after.log, build-after.log et browser-after.log.
