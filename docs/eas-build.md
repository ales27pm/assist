# EAS — compilation et distribution iPhone

EAS compile cette application React Native **bare**, avec son projet Xcode et
son vrai TurboModule. Il n’ajoute ni Expo Go, ni repli d’inférence distant, ni
EAS Update. Le code est envoyé au service de compilation. La livraison avec
Gemma embarqué nécessitera aussi l’envoi de cet export public vérifié ; les
imports privés et conversations de l’iPhone ne sont jamais récupérés ni envoyés.

## Projet et image

- Projet : [@27pm/assist](https://expo.dev/accounts/27pm/projects/assist).
- Identifiant iOS inchangé : `org.27pm.assist`, séparé de monGARS.
- EAS CLI épinglé : `24.14.0`.
- Image : `macos-tahoe-26.6-xcode-27.1` (Xcode 27.1 RC).
- Le minimum iOS de l’app est **27.1** ; Gemma reste bloqué avant **27.2**.

Au contrôle du 15 octobre 2026, Expo liste cette image mais pas Xcode 27.2.
Le paquet Apple accepte Core AI à partir du SDK 27.0, tandis que l’export Gemma
requiert **iOS 27.2 à l’exécution**. Le premier essai EAS a rejeté le minimum
de déploiement 27.2 avant compilation ; l’app et ses Pods ciblent donc 27.1,
avec une garde native avant tout chargement Gemma. La compilation ARM64 complète
a réussi au [troisième essai](https://expo.dev/accounts/27pm/projects/assist/builds/9000a844-455c-43b8-bd09-158483a065a9),
sans signature ni poids ; l’exécution Gemma reste non vérifiée. Le contrôle
`eas-build-pre-install` refuse un environnement sans Core AI. Aucun export de
poids ni compilation AOT de Gemma ne s’exécute sur EAS.

Sources : [images Expo](https://docs.expo.dev/build-reference/infrastructure/),
[projets React Native existants](https://docs.expo.dev/build-reference/build-configuration/),
[paquet Apple épinglé](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/Package.swift),
[runtime Gemma](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md).

## IPA signée pour l’iPhone

Depuis `mobile/`, après revue et commit des changements :

```sh
npx --yes eas-cli@24.14.0 build --platform ios --profile preview
```

Ce profil produit une build Release de distribution interne. Il nécessite un
certificat Apple de distribution et un profil **ad hoc** pour `org.27pm.assist`
incluant l’UDID de l’iPhone. Les identifiants sont gérés par EAS, jamais ajoutés
au dépôt. Si EAS exige une connexion Apple, le propriétaire doit effectuer cette
étape ; aucun mot de passe ou code 2FA ne doit être publié dans une issue.
Pas de soumission App Store/TestFlight automatique ni changement d’abonnement.

La livraison demandée doit inclure Gemma dans l’application, pas seulement
proposer un import manuel. `preview` impose `ASSIST_REQUIRE_BUNDLED_GEMMA=1` :
le contrôle initial et la copie Xcode échouent si l’export et son inventaire
cryptographique revu sont absents. Voir [le contrat d’empaquetage](bundled-gemma.md).
L’export réel n’est pas encore préparé ; ne pas présenter une build sans poids
comme cette livraison complète.

Une signature valide et une IPA téléchargeable ne prouvent pas que Gemma
fonctionne : exécuter ensuite la qualification physique 8K avant 32K.

## Contrôle natif facultatif sans signature

```sh
npx --yes eas-cli@24.14.0 build --platform ios --profile ios-compile
```

Ce profil personnalisé lance les tests JavaScript, Codegen, CocoaPods et
`xcodebuild` Release pour `generic/platform=iOS`, avec la signature désactivée.
Il conserve uniquement des journaux de compilation. **Il ne produit pas d’IPA
installable** et ne remplace pas le profil `preview` demandé pour distribution.

## Archive envoyée

La règle racine `.easignore` n’inclut que `mobile/` et `scripts/` ; elle exclut
notamment les poids, secrets, certificats, crash reports, caches et artefacts.
Avant la première livraison embarquée, ajouter une exception limitée au seul
export approuvé dans `mobile/ios/Assist/BundledModels/Gemma`, puis vérifier que
l’archive contient exactement l’inventaire approuvé. Cette exception n’est pas
encore activée tant que le vrai paquet et son lock n’ont pas été revus.
Inspecter l’archive avant envoi :

```sh
inspection_dir=$(mktemp -d)
npx --yes eas-cli@24.14.0 build:inspect --platform ios --profile preview \
  --stage archive --output "$inspection_dir/archive"
```

Ne pas faire passer une compilation interrompue, refusée ou en attente pour une
build signée : conserver l’URL, l’identifiant et le statut final EAS.
