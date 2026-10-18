# EAS — compilation et distribution iPhone

EAS compile cette application React Native **bare**, avec son projet Xcode et
son vrai TurboModule. Il n’ajoute ni Expo Go, ni repli d’inférence distant. EAS
Update est configuré séparément : il ne peut livrer que du JavaScript et des
assets compatibles avec le runtime natif déjà installé. Le code est envoyé au
service de compilation. La livraison avec
Gemma embarqué nécessitera aussi l’envoi de cet export public vérifié ; les
imports privés et conversations de l’iPhone ne sont jamais récupérés ni envoyés.

## Projet et image

- Projet de livraison : [@ales27/assist](https://expo.dev/accounts/ales27/projects/assist).
  Les liens historiques sous `@27pm/assist` restent des preuves des essais antérieurs.
- Identifiant iOS inchangé : `org.27pm.assist`, séparé de monGARS.
- EAS CLI exécuté pour la livraison : `24.14.0`; versions acceptées :
  `>=24.14.0 <26.0.0`, pour permettre aussi la préparation GitHub avec EAS CLI 25.
- Image : `macos-tahoe-26.6-xcode-27.1` (Xcode 27.1 RC).
- Le minimum iOS de l’app est **27.1** ; Gemma reste bloqué avant **27.2**.

Au contrôle du 15 octobre 2026, Expo liste cette image mais pas Xcode 27.2.
Le paquet Apple accepte Core AI à partir du SDK 27.0, tandis que l’export Gemma
requiert **iOS 27.2 à l’exécution**. Le premier essai EAS a rejeté le minimum
de déploiement 27.2 avant compilation ; l’app et ses Pods ciblent donc 27.1,
avec une garde native avant tout chargement Gemma. La compilation ARM64 complète
a réussi au [troisième essai](https://expo.dev/accounts/27pm/projects/assist/builds/9000a844-455c-43b8-bd09-158483a065a9),
sans signature ni poids. Cet essai ne vérifiait pas l’exécution Gemma ; les
[rapports physiques ultérieurs](verification.md) concernent un import manuel.
Le contrôle
`eas-build-pre-install` contrôle la configuration de scène UIKit, puis vérifie
le paquet Gemma s’il est présent (et l’exige pour
`preview`), puis valide l’hôte Apple Silicon et les versions Xcode/SDK. Il ne teste
ni l’import du framework Core AI, ni sa compilation, ni son exécution. Aucun
export de poids ni compilation AOT de Gemma ne s’exécute sur EAS.

Sources : [images Expo](https://docs.expo.dev/build-reference/infrastructure/),
[projets React Native existants](https://docs.expo.dev/build-reference/build-configuration/),
[paquet Apple épinglé](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/Package.swift),
[runtime Gemma](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md).

## IPA signée pour l’iPhone

### Prototype TestFlight avec import manuel

Le build historique **1.0.0 (3)** a été signé et traité par TestFlight,
comme décrit dans le [rapport de vérification](verification.md). Le profil
`testflight` utilise les versions du projet Xcode (`MARKETING_VERSION` et
`CURRENT_PROJECT_VERSION`) ; vérifier ces valeurs avant chaque nouvelle build.
Ce profil autorise l’absence de Gemma embarqué et demande son import local
depuis l’app ; le chargement Gemma reste réservé à iOS 27.2+. Le profil `preview`
conserve son exigence de modèle embarqué. Une build TestFlight ne constitue pas
une qualification de l’inférence, des 32K ou de l’ANE.

Les changements Swift, Xcode, Pod ou de résolution du bundler sont natifs. Ils
font partie de la build **1.0.0 (27)** et du runtime
`1.0.0-native27`; ils ne sont donc jamais diffusables à une app encore en
`1.0.0-native26` par OTA. Une fois cette build installée, seules les mises à
jour JavaScript/assets qui gardent ce runtime et le canal correspondant peuvent
être publiées via EAS Update.

Depuis `mobile/` pour les deux commandes :

```sh
npx --yes eas-cli@24.14.0 build --platform ios --profile testflight
npx --yes eas-cli@24.14.0 submit --platform ios --profile testflight --id <build-id>
```

La soumission nécessite une signature de distribution App Store et l’accès à
la fiche `org.27pm.assist` dans App Store Connect. Elle ne publie pas l’app sur
l’App Store public. Vérifier séparément la compilation, la signature, la réception
Apple et le traitement TestFlight ; ne pas soumettre une build ad hoc ou sans signature.

### Livraison privée avec Gemma embarqué

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
Un [export réel 32K a été préparé et contrôlé](gemma-32k-export-2026-10-15.md),
puis importé manuellement sur l’iPhone ; ses limites numériques et les essais
suivants sont conservés dans le [diagnostic de fidélité](gemma-numeric-fidelity.md).
Sa présence dans une archive EAS ou une IPA signée n’est pas établie : ne pas
présenter une build sans poids comme cette livraison complète.

Une signature valide et une IPA téléchargeable ne prouvent pas que Gemma
fonctionne : exécuter ensuite la qualification physique 8K avant 32K.

## Contrôle natif facultatif sans signature

Depuis `mobile/` :

```sh
npx --yes eas-cli@24.14.0 build --platform ios --profile ios-compile
```

Ce profil personnalisé lance les tests JavaScript, Codegen, CocoaPods et
`xcodebuild` Release pour `generic/platform=iOS`, avec la signature désactivée.
Il conserve uniquement des journaux de compilation. **Il ne produit pas d’IPA
installable** et ne remplace pas le profil `preview` demandé pour distribution.

## Archive envoyée

### Conservation et contrôle des symboles iOS

La build 26 a bien généré son `Assist.app.dSYM` sur le runner Xcode, mais
l’artefact exposé par EAS ne le contenait pas. Il n’est donc pas récupérable
via les artefacts EAS exposés de cette build, et une IPA seule ne permet pas de
recréer son dSYM. À partir de la build native 27, les
profils `preview` et `testflight` produisent explicitement
`artifacts/ios/assist-symbols.zip` dans le hook `eas-build-on-success`, puis
le déclarent dans `buildArtifactPaths`. Le hook échoue si le dSYM arm64 est
absent ou ambigu : l’archive de symboles n’est jamais produite à partir d’un
bundle manquant ou ambigu.

Le ZIP contient uniquement `Assist.app.dSYM` et `symbol-identity.json`. Ce
manifeste lie le SHA-256 du DWARF et ses UUID aux champs suivants : identifiant
de bundle, version, numéro de build, runtime et hash Git source. Il ne contient
ni certificat, ni identifiant d’équipe, ni modèle, ni conversation. Le hash de
source vient de `EAS_BUILD_GIT_COMMIT_HASH`, fourni par EAS sur le runner.

Après une build, télécharger tous les artefacts avec la CLI EAS (elle affiche
le chemin local de `buildArtifacts`), extraire l’archive d’artefacts si EAS
l’a empaquetée, puis vérifier le ZIP de symboles sur un Mac disposant de
`dwarfdump` :

```sh
npx --yes eas-cli@24.14.0 build:download --build-id <build-id> --all-artifacts
node ../scripts/verify-ios-symbol-artifact.mjs <chemin-vers>/assist-symbols.zip
```

Ce contrôle établit la présence, l’empreinte et les UUID du dSYM ; la
symbolication complète d’un crash requiert toujours un rapport portant le même
UUID. Il ne prouve ni la signature de l’IPA, ni un lancement sur appareil, ni
une exécution ANE.

La règle racine `.easignore` inclut `mobile/` et `scripts/`, avec une exception
explicite pour le bundle complet dans
`mobile/ios/Assist/BundledModels/Gemma`, asset `.aimodel`, PLE et tokenizer
compris. Les checkpoints bruts, secrets, certificats,
crash reports, caches et artefacts restent exclus. Cette exception rend le
chemin d’archive utilisable par `preview` ; elle ne remplace pas le verrou
`mobile/gemma-bundle.lock.json` revu ni la vérification des empreintes avant
copie. Vérifier que les fichiers Gemma archivés correspondent exactement à
cet inventaire. Aucune archive EAS contenant le vrai bundle ni IPA signée
avec Gemma embarqué n’est démontrée.
EAS CLI 24.14.0 limite l’archive source compressée à **2 Gio**
(`MAX_ALLOWED_PROJECT_TARBALL_SIZE` dans `build/utils/repository.js`). Mesurer
l’archive complète, modèle compris, avant l’envoi. Si elle dépasse cette limite,
la livraison nécessite une autre voie de transfert vérifiée à la construction ;
ne pas omettre Gemma ni publier les poids sur un nouvel hébergement pour contourner
silencieusement le blocage. Cette limite concerne l’upload des sources, pas une
mesure de la mémoire nécessaire à l’inférence. Le ZIP group8 vérifié occupe
**2 784 586 364 octets**, déjà plus de 2 Gio ; son format ne remplace pas la
mesure de l’archive source EAS complète. L’exception d’inclusion ne résout donc
pas cette limite de transfert, qui reste à vérifier avant toute livraison.
Inspecter l’archive avant envoi depuis `mobile/` :

```sh
inspection_dir=$(mktemp -d)
npx --yes eas-cli@24.14.0 build:inspect --platform ios --profile preview \
  --stage archive --output "$inspection_dir/archive"
```

Ne pas faire passer une compilation interrompue, refusée ou en attente pour une
build signée : conserver l’URL, l’identifiant et le statut final EAS.

## Compilation depuis GitHub

Dans le projet EAS payé, choisir la branche `codex/local-voice-build-13`,
le sous-dossier de base `mobile`, le profil `testflight` et l'environnement
`production`. Le profil de soumission est aussi `testflight`. Le bundle iOS et
la fiche App Store Connect demeurent ceux d'Assist.

L'essai GitHub du 16 octobre sur `main` au commit `43641a4` visait l'ancienne
version 11 et a échoué pendant la préparation : le service utilisait EAS CLI
25.1.1 alors que `eas.json` exigeait exactement 24.14.0. La plage de compatibilité
ci-dessus corrige cette frontière sans modifier le code natif du candidat 13.
