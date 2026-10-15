# Prérequis et compilation iOS

## Environnement requis

- Mac Apple Silicon pour la préparation/qualification de ce prototype Gemma.
- Installation complète de Xcode 27.1+ et SDK iPhoneOS 27.1+ sélectionnés
  pour tenter la compilation du moteur Core AI.
- iPhone physique sous iOS 27.2+ pour le moteur Gemma ; le simulateur ne valide
  pas le Neural Engine ni la mémoire disponible sur l’iPhone.
- Node conforme à `mobile/package.json`, gestionnaire npm, Ruby/Bundler et
  dépendances CocoaPods du projet.
- Pour une installation physique ultérieure : équipe Apple et provisionnement
  appropriés, configurés par le propriétaire. Aucun certificat n’est fourni.

Il faut distinguer **SDK de compilation** et **version d’exécution du modèle**.
Le paquet Apple épinglé annonce Xcode 27.0+ et une plateforme iOS 27.0 ; sa
recette Gemma exige iOS **27.2+ sur l’appareil**. Cette dernière exigence ne
prouve pas à elle seule qu’il faut le SDK 27.2 pour compiler l’application.
Le minimum de déploiement de l’app et des Pods est **27.1**. Une garde native
refuse tout chargement Gemma avant **27.2**, avant même la lecture du paquet.

Le premier essai EAS a confirmé que Xcode 27.1 rejette une cible de déploiement
27.2. Après cette correction et celle d’un import de header React Native,
la compilation complète ARM64 a réussi sur EAS avec Xcode 27.1 RC : voir
[les preuves](verification.md). Cela ne prouve ni signature ni inférence.
L’export du modèle et sa spécialisation sur iPhone restent des
étapes séparées. Voir le [parcours EAS](eas-build.md).

Un Mac Intel exécutant Xcode 26.3 ne satisfait toujours pas les prérequis de
ce prototype. Le contrôle ne change pas `xcode-select`, ne met pas macOS à
jour et ne redémarre aucune VM.

Sources : [prérequis Core AI](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/README.md#requirements-running-and-app-integration),
[plateformes du paquet](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/Package.swift),
[matrice Gemma officielle](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md).

## Contrôles reproductibles

Depuis la racine :

```sh
bash scripts/test-preflight.sh
bash scripts/preflight-ios.sh
```

Le test de prérequis utilise des doublures de commandes pour couvrir les
plateformes et versions acceptées/refusées ; il ne simule pas la compilation de
Core AI. Le contrôle réel ne fait que lire l’environnement sélectionné. Il reste
à résoudre les dépendances, compiler et exécuter sur le matériel.

Dans `mobile/`, une fois les dépendances obtenues :

```sh
npm ci
npm test -- --runInBand
npm run lint
npx tsc --noEmit
```

Les tests JavaScript peuvent tourner sur Linux, contrairement à la compilation
iOS. Sur le Mac compatible, préparer CocoaPods :

```sh
bundle install
cd ios
bundle exec pod install
```

Depuis `mobile/ios`, vérifier ensuite la compilation sans signature :

```sh
xcodebuild -workspace Assist.xcworkspace \
  -scheme Assist -configuration Debug \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO build
```

Le produit Swift Apple `CoreAILM` doit résoudre la révision
`9db747612f972001279f02adb04d3ef982310d0e`. Ne pas remplacer cette révision par
`main` pour faire passer une erreur : conserver l’erreur et revoir le contrat.
Le Codegen React Native fait partie de l’intégration CocoaPods ; le TurboModule
ne doit pas être remplacé par un simple module JavaScript simulant une réponse.

## Ce qui reste distinct

Une compilation sans signature n’est ni une IPA signée ni une installation.
Configurer ensuite l’équipe et la signature dans `Assist.xcworkspace`, sans
versionner les certificats/profils. L’archivage, l’installation, une éventuelle
page privée et la publication GitHub restent des opérations séparées.

Le premier import doit utiliser le dossier complet préparé dans
[le guide d’export](gemma-export.md). La spécialisation initiale peut être longue
et volumineuse ; la qualifier séparément du chargement chaud. Pour prouver
l’indépendance réseau, utiliser une build Release avec le bundle JavaScript
embarqué, pas une session Debug dépendant de Metro.
