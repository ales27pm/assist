# Packs vocaux versionnés — hôte préparé localement

Ce changement prépare le prochain binaire, pas la build 26 déjà installée.
Les poids, la précision, le placement de calcul par défaut et le contexte 32K
ne sont pas réduits. Un pack signé ne peut pas ajouter un nouveau moteur natif.

## Contrat d’acceptation

Le dossier racine conserve `pocket`, `silero` et au moins une variante `redux`
ou `ultra`. Le marqueur `assist-voice-pack.json` contient une enveloppe v2 :
`schemaVersion`, `keyId`, `manifestBase64` et `signatureBase64`. La signature
Ed25519 porte sur le domaine `org.27pm.assist.voice-pack/v2\0` suivi des octets
exacts du manifeste, sans re-sérialisation par l’app.

Le manifeste contient `schemaVersion: 2`, `packVersion` (1–64 caractères ASCII
alphanumériques, point, tiret ou soulignement),
`runtimeABI: assist-fluid-fr24-estelle-v1`, la révision SDK épinglée et les
quatre inventaires de groupes. Chaque fichier a un chemin relatif, une taille
et un SHA-256. Les dépôts et composants racines doivent correspondre au contrat
embarqué. Les révisions des poids peuvent évoluer ; leurs fichiers internes
restent soumis aux bornes, à la signature et à la vérification d’intégrité.

Un marqueur v1, ou son absence, conserve l’import historique : seuls les octets
épinglés par l’app sont admis. Les imports déjà vérifiés migrent par pointeur,
sans recopier leurs gigaoctets. Aucune clé du dossier sélectionné n’est reconnue
comme autorité de confiance.

La signature authentifie l’éditeur et l’intégrité, **pas la validité numérique,
la qualité vocale ni la sûreté d’une inférence Core ML**. Les nouveaux poids
doivent être qualifiés avant signature. L’ABI est une déclaration vérifiée contre
les composants connus, pas une analyse complète de tous les graphes compilés.

## Signature locale

La clé privée approuvée est hors Git, sous
`/home/ales27pm/.local/share/assist/release-keys/voice-pack-2026-10-ed25519.pem`.
Le fichier est en 0600 et son dossier en 0700. Seules la clé publique et son
identifiant `assist-voice-release-2026-10` entrent dans l’app. Aucun envoi à
EAS, GitHub ou un service d’observabilité n’est nécessaire pour signer.

Ne pas recréer ni remplacer cette clé pour chaque pack. En conserver une
sauvegarde privée chiffrée sous le contrôle du mainteneur ; aucune sauvegarde
distante n’est créée automatiquement. La perte de la clé interdit de signer de
nouveaux packs pour cet ancrage ; sa rotation exigera un binaire qui connaît la
nouvelle clé publique. L’outil refuse les clés dans un worktree Git, les liens,
les chemins relatifs et les permissions trop larges.

Après préparation et qualification des fichiers compatibles :

```sh
node scripts/voice-pack-signing.mjs sign \
  --pack /chemin/absolu/pack \
  --manifest /chemin/absolu/inventaire.json \
  --private-key /home/ales27pm/.local/share/assist/release-keys/voice-pack-2026-10-ed25519.pem \
  --key-id assist-voice-release-2026-10 --version 1.0.1
```

L’inventaire source peut être v1 ou v2 compatible. L’outil contrôle les fichiers
réels avant de remplacer atomiquement le marqueur, sans téléchargement ni
modification des poids. La sortie contient seulement les identifiants publics
et le hash du manifeste. `prepare-voice-pack.py` reste le préparateur du pack
historique épinglé ; il ne fabrique pas automatiquement de nouveaux modèles.

## Import, arrêt et restauration

Le bridge attend la libération des ressources vocales avant import, sélection
ou restauration. L’app copie dans un nouveau dossier UUID, vérifie chaque
fichier par blocs de 1 Mio puis écrit le reçu. Une seule écriture atomique publie
le couple actif/précédent avec leurs variantes ASR. L’ancien actif reste le
précédent ; seule une sauvegarde plus ancienne gérée par l’app est retirée.

« Restaurer le pack précédent » échange les pointeurs et choisit une variante
réellement présente. Le terme précédent ne signifie pas « qualifié sans crash ».
L’échec d’intégrité, l’annulation ou le manque d’espace ne remplace pas l’actif.
Les originaux dans Fichiers ne sont jamais supprimés. Prévoir l’actif, le
précédent et l’espace du nouvel import plus 256 Mo pendant la transaction.

## Vérifications locales reproductibles

```sh
node --test scripts/test-voice-pack-signing.mjs
node scripts/create-voice-pack-interop-fixture.mjs /tmp/assist-interop-nouveau
# Sur macOS ; transférer uniquement ce dossier de fixtures publiques si besoin.
bash scripts/check-advanced-voice-files.sh /tmp/assist-interop-nouveau
```

Le test interop utilise une clé temporaire supprimée avant transfert, le vrai
signateur Node, CryptoKit et de vraies copies/SHA-256. Il utilise des poids
synthétiques minuscules et un budget disque injecté ; l’app continue d’utiliser
le vrai budget système et la réserve de 256 Mo. Les tests couvrent deux versions,
Redux/Ultra, restauration, signature falsifiée avec JSON valide, éditeur inconnu,
ABI incompatible et capacité nulle. Ils ne chargent aucun modèle Core ML.
