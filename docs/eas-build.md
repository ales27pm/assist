# EAS — compilation et distribution iPhone

EAS compile cette application React Native **bare**, avec son projet Xcode et
son vrai TurboModule. Il n’ajoute ni Expo Go, ni repli d’inférence distant, ni
EAS Update. Le code est envoyé au service de compilation ; les modèles, imports
et conversations de l’iPhone ne le sont pas.

## Projet et image

- Projet : [@27pm/assist](https://expo.dev/accounts/27pm/projects/assist).
- Identifiant iOS inchangé : `org.27pm.assist`, séparé de monGARS.
- EAS CLI épinglé : `24.14.0`.
- Image : `macos-tahoe-26.6-xcode-27.1` (Xcode 27.1 RC).
- Le minimum iOS de l’app reste **27.2**.

Au contrôle du 15 octobre 2026, Expo liste cette image mais pas Xcode 27.2.
Le paquet Apple accepte Core AI à partir du SDK 27.0, tandis que l’export Gemma
requiert **iOS 27.2 à l’exécution**. La compilation avec 27.1 reste à vérifier
réellement ; ce n’est pas une garantie de compatibilité. Le contrôle
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
proposer un import manuel. Elle reste bloquée tant que l’export Core AI épinglé
n’est pas produit, vérifié et intégré aux ressources natives. Ne pas présenter
une build sans poids comme cette livraison complète.

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
Inspecter l’archive avant envoi :

```sh
inspection_dir=$(mktemp -d)
npx --yes eas-cli@24.14.0 build:inspect --platform ios --profile preview \
  --stage archive --output "$inspection_dir/archive"
```

Ne pas faire passer une compilation interrompue, refusée ou en attente pour une
build signée : conserver l’URL, l’identifiant et le statut final EAS.
