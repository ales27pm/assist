# TestFlight 29 — candidat et livraison

État courant : la quatrième tentative produit un IPA29 exporté, dont les signatures
et capacités sont vérifiées, puis échoue pendant la collecte des dSYM. Le bundle
dSYM original n’est pas publié; la validation complète des symboles reste
inachevée. Sur l’instruction explicite « Submit » d’Alexis, cet IPA est ensuite
soumis sans nouvelle compilation. Le traitement Apple est suivi séparément.

## Autorisation

Le 19 octobre 2026, Alexis demande explicitement : « Commit, push / Build and
submit with eas ». Cette instruction autorise le commit et le push de la branche
`feature/private-web-research`, puis une build EAS iOS du profil `testflight` et
la soumission de son ID exact après vérification des artefacts. Elle ne déclenche
ni OTA, publication App Store, diffusion externe, déploiement Ubuntu ni relance
payante automatique. Les anciens produits TestFlight sont conservés.

## Candidat source

Assist 1.0.0 (29), runtime `1.0.0-native29`, trois produits App/Share/Widget.
Le modèle complet Gemma 32K et les packs vocaux restent importables; le profil
TestFlight conserve `ASSIST_REQUIRE_BUNDLED_GEMMA=0`. Aucun poids, clé privée ou
contenu de l’iPhone n’est ajouté à Git ou envoyé comme ressource de build.

Le lot est détaillé dans les rapports de
[stabilisation](native29-stabilization-2026-10-19.md) et de
[compléments natifs](native29-native-bundle-2026-10-19.md) : 31 outils négociés,
cartes/météo avec attribution, AlarmKit/Live Activity, traduction locale,
scanner/PDF/Quick Look, MessageUI, Spotlight choisi et brouillons App Intents.
Le pont v1 garde ses 13 outils; aucun permis de mutation n’est créé par Siri,
Raccourcis ou Spotlight. La passerelle Ubuntu active reste v1, sans lecteur v2.

## Contrôles avant lancement

- 1 690 tests Jest / 57 suites, TypeScript, lint sans erreur et Codegen passants.
- 53 contrôles workspace et 25 contrôles de capacités; 31 schémas fermés,
  107 Tool Host, 44 boucle, 307 transactions, 35 alarmes, 57 traduction,
  78 documents; 47 tests d’archivage/symboles passent localement.
- Les nouvelles sources Swift et les deux extensions ont été compilées en
  objets optimisés sur SDK simulateur 26.2, concurrence stricte. Ce résultat ne
  remplace pas la compilation complète CoreAI sur la cible EAS Xcode/SDK27.1.
- La sérialisation native expo-updates est normalisée avant gel du commit,
  avec runtime29 et BSDiff conservés. L’archive réelle doit être contrôlée
  depuis le commit propre avant upload.
- Vérifier les trois profils distants, App Group et WeatherKit; ne pas révoquer
  de certificat existant ou réparer un compte sans nécessité identifiée.

## Vérifications avant et après soumission

Attendre le résultat du seul ID EAS lancé. En cas d’échec, conserver son état et
son diagnostic, sans relance automatique. Si la build réussit : télécharger IPA
et symboles de cet ID, vérifier signature/profils/entitlements des trois produits,
UUID et empreintes des symboles, source, runtime/canal, métadonnées App Intents,
confidentialité et exemption de chiffrement. Soumettre uniquement cet ID via EAS,
sans `--latest`, groupe automatique ou diffusion externe.

Le résultat EAS, le traitement Apple, la disponibilité TestFlight et le
fonctionnement physique iPhone sont consignés séparément. Les résolutions
Podfile.lock/Package.resolved produites par le runner doivent être conservées
comme preuves; leur absence dans ce candidat limite la reproductibilité native.

Aucune build29 n’existait dans la liste EAS consultée avant préparation.
Le résultat du lancement et les identifiants seront ajoutés après observation.
La [checklist iPhone](native29-iphone-acceptance.md) reste à exécuter sur le binaire.

## Préparation de signature avant création

Le commit initial `29beae48` est poussé sur la branche de travail. Son archive
réelle contient 775 fichiers vérifiés; aucun poids ou secret ajouté.
Le contrôle de credentials EAS a révélé une incompatibilité du parseur Expo :
les références des nouvelles dépendances/configurations Xcode, valides comme
IDs nus pour Xcode, devaient porter leurs commentaires pour la représentation
`{value}` attendue par Expo. Le correctif couvre les deux dépendances et les
quatre configurations des extensions; une régression utilise le vrai parseur
installé. **54 contrôles workspace** passent, et le résolveur EAS identifie
les trois cibles avec leurs entitlements attendus.

La session interactive Apple était expirée. Le service EAS contient déjà une
clé API de soumission avec issuer; son contenu n’est pas reproduit ici. Avant
préparation, seul le profil principal historique existait, sans App Group ni
WeatherKit; les profils Partage/Widget manquaient. Il faut préparer les profils
adaptés avant d’engager une build, plutôt que découvrir cela pendant l’archive.
Aucune build ou soumission distante n’a été créée par ces contrôles.

Le correctif du parseur est poussé sous `d8b96ba8`; son archive réelle a de
nouveau été vérifiée avec 775 fichiers. La clé API existante authentifie bien
la préparation, mais la synchronisation EAS25.1.1 des deux capacités est refusée
par Apple (HTTP400 : attributs inline de `bundleIdCapabilities` non acceptés).
Le code EAS indique en outre que la création/association des App Groups exige
une session Apple avec cookies, et ignore cette étape avec la clé API seule.
La procédure officielle distingue bien [activation et association du groupe](https://developer.apple.com/help/account/identifiers/enable-app-capabilities/).

Une lecture Apple après le refus, le 20 octobre à 00:14 UTC, confirme : App ID
principal présent sans WeatherKit ni App Groups, identifiants Partage/Widget
absents, aucune build Apple29. Aucun état partiel à interpréter comme livraison.
Les fichiers temporaires de clé ont été supprimés; aucune clé n’est conservée
dans ce document ou ce dépôt. La poursuite attend une réauthentification Apple
dans `eas credentials:configure-build --platform ios --profile testflight`,
puis la préparation des trois profils. Aucun lancement EAS payant, upload de
build ou soumission n’a encore eu lieu.

## Profils prêts puis tentative EAS unique

Après réauthentification par Alexis, le profil principal est régénéré avec
WeatherKit et `group.org.27pm.assist`; les deux identifiants/extensions et leurs
profils App Store sont créés avec le même certificat existant. Une lecture des
trois profils distants confirme App Group, absence de signature debug/ad-hoc et
expiration au 16 octobre 2027; WeatherKit n’est présent que dans l’app principale.

- Révision envoyée : `0aa03bb8d88e7b13409b845ee73e060864cfac6e`.
- [Build EAS29](https://expo.dev/accounts/ales27/projects/assist/builds/1735c30f-6b5d-44b6-ad08-a4aa4873210d) :
  `1735c30f-6b5d-44b6-ad08-a4aa4873210d`, créée le 20 octobre 2026 à
  00:18:34 UTC, terminée `ERRORED` à 00:21:26 UTC.
- Profil/canal `testflight`, versions 1.0.0 (29), credentials gelés avec
  `--freeze-credentials`. Aucun auto-submit ou `--latest`.
- Les prérequis Apple Silicon/Xcode27.1/SDK27.1 ont passé sur le runner,
  ainsi que les premiers contrôles natifs. L’archive Xcode n’a pas commencé.

Cause exacte : `check-task-checkpoints.sh` compile désormais
`AssistExtendedTools.swift`, dont le constructeur de requête utilise
`AssistJSON.encode`, mais n’incluait pas `InferencePolicy.swift`, qui définit
ce helper. Le runner s’arrête sur `cannot find 'AssistJSON' in scope`.
L’erreur ultérieure d’upload des symboles absents est une conséquence, pas la
cause de l’échec. Aucun IPA ni symbole n’a été produit; aucune soumission Apple.

## Correctif après échec, sans nouvelle build

Le harnais inclut maintenant la vraie source `InferencePolicy.swift`.
**61 contrôles checkpoints** passent dans le conteneur Swift6.2 en lecture seule
et sur le Mac. Un audit des listes de compilation Foundation ne trouve pas
d’autre source manquante; les 16 autres harnais Foundation compilent également.

Les huit hooks à partir des checkpoints sont rejoués sur le Mac : checkpoints61,
alarmes35, traduction57, documents78, workspace et deux extensions en objets
simulateur, recherche125, Apple Places69, attribution50 et ImageIO5. Exit0.
SDK simulateur26.2 seulement : ce rejeu ne remplace pas l’archive CoreAI complète
sur Xcode27.1, qui reste à obtenir.

Le contrôle privé initial passe déjà sur Darwin, mais son rejeu Linux révèle
que l’ancrage regex `$` peut accepter un saut de ligne final. Les validateurs
de clé et d’identifiant exigent maintenant que la plage reconnue couvre toute
la valeur. Les cas négatifs existants passent sur Linux et macOS : **89 contrôles**
sur chaque hôte; la boucle recherche est également rejouée avec **125 contrôles**.
Aucun secret ni requête réelle utilisé dans ces tests.

Logs et reçus privés :
`/home/ales27pm/.local/share/assist/releases/1.0.0-29-1735c30f/`.
La prochaine tentative EAS reste soumise à un nouvel accord explicite, selon
la limite de relance payante automatique fixée par Alexis. Le numéro29 peut
être conservé : aucun binaire correspondant n’a été transmis à Apple.

## Deuxième tentative autorisée et correction des captures Swift

Après le nouvel accord explicite d’Alexis (« Oui »), une seule deuxième tentative
est lancée depuis le commit propre et poussé
`408ae6309bf34430820ac380a6ab7ea2f1f2d23f`. Son archive réelle contient toujours
775 fichiers vérifiés, sans poids ou secret ajouté.

- [Deuxième build EAS29](https://expo.dev/accounts/ales27/projects/assist/builds/fd1d0b0c-2257-4460-8b10-9e5adf2731a1) :
  `fd1d0b0c-2257-4460-8b10-9e5adf2731a1`, créée le 20 octobre à
  00:29:09 UTC, terminée `ERRORED` à 00:32:24 UTC.
- Les checkpoints61 passent désormais sur le runner, ainsi que les contrôles
  alarmes35, traduction57 et documents78.
- L’arrêt survient ensuite dans `check-native-workspace.sh` : le compilateur
  Xcode27.1 signale `ImplicitStrongCapture` dans le callback biométrique de
  `AssistDeviceCapabilities.swift`. La tâche interne capturait `self` faiblement,
  tandis que le callback externe le capturait implicitement fortement.
- Aucun IPA, symbole ou archive Xcode n’a été produit; aucune soumission Apple.

Le callback externe déclare maintenant lui aussi `[weak self]`; la vérification
du jeton biométrique reste en place. Une revue des 106 captures faibles repère
le même schéma dans le callback `onTermination` de FluidAudio : sa capture externe
devient également faible. Le changement est consigné dans `LOCAL-PATCH.diff`,
sans modifier les empreintes des sources amont dans `UPSTREAM.json`.

Vérifications ciblées après correction sur le Mac :

- Compilation optimisée, concurrence stricte et avertissements traités comme
  erreurs : sous-ensemble de l’app et les deux extensions sur SDK simulateur26.2.
- **49 tests FluidAudio / 7 suites** passants, sans modèles, microphone ou réseau.
- Compilation Swift arm64 sur SDK iPhoneOS26.2 avec émission du vrai header,
  puis contrôle positif/négatif du consommateur Objective-C++. Ce harnais omettait
  six sources agent/contrats désormais nécessaires; elles sont ajoutées, sans
  remplacer les implémentations par des doublures. Il ne compile pas le pont RCT
  complet et n’est pas un hook EAS.

Ces résultats ne reproduisent pas le diagnostic propre au compilateur27.1 et
ne prouvent ni archive complète CoreAI ni fonctionnement iPhone. Les journaux
et le reçu d’échec restent hors Git dans
`/home/ales27pm/.local/share/assist/releases/1.0.0-29-fd1d0b0c/`.
Une nouvelle tentative payante exige un nouvel accord explicite; aucune relance,
OTA ou soumission n’est déclenchée par ces corrections.

## Troisième tentative autorisée et examen des étapes suivantes

Le nouvel accord d’Alexis autorise la tentative depuis le commit propre et poussé
`dd44486546b7ce84d3b6e16f80aaa7d5c4903a45` :

- [Troisième build EAS29](https://expo.dev/accounts/ales27/projects/assist/builds/ee7b22d4-b1e2-4d5e-b4cd-5f5f5291866c),
  créée le 20 octobre à 00:40:25 UTC, terminée `ERRORED` à 00:47:34 UTC.
- Tous les contrôles pré-installation passent sur Xcode27.1, dont le workspace,
  les deux extensions, les 49 tests FluidAudio et les checkpoints61.
- Les extensions Partage et Widget atteignent l’édition des liens, la production
  des dSYM, l’extraction de métadonnées et la signature. Aucun IPA final n’existe.
- Le journal Xcode complet contient cinq erreurs, toutes dans le header
  `Assist-Swift.h` consommé par `RCTNativeAssist.mm` : protocoles et enums
  MessageUI, et protocole Quick Look inconnus. Les préimports AVFoundation/UIKit/CoreLocation
  existants ne suffisent pas aux interfaces du nouveau service de documents.

Le pont importe désormais MessageUI, QuickLook et VisionKit avant le header Swift.
Le harnais inclut les vraies classes de documents et leurs dépendances, puis
extrait les préimports Apple du pont de production. Sur SDK iPhoneOS26.2 arm64,
il reproduit les erreurs quand on retire les imports et compile le consommateur
avec ces imports. Il fait maintenant partie du hook pré-installation EAS; ses
**35 tests de contrat** prouvent aussi l’arrêt avant les contrôles suivants en cas
d’échec. Il ne remplace pas la compilation du pont RCT complet sous Xcode27.1.

À la demande d’Alexis, les étapes non atteintes sont aussi examinées avant toute
nouvelle tentative payante :

| Frontière | Preuve et résultat |
| --- | --- |
| Interface du pont | Les 90 méthodes du vrai `AssistSpec.h` généré RN0.88 correspondent au pont; revue des sélecteurs Swift et passages sur l’acteur principal. Aucun autre défaut concret relevé. |
| Bundle de production | `expo export:embed`, plateforme iOS, production/minification et bytecode Hermes : 681 modules, 1 754 136 octets, en-tête Hermes confirmé sur Linux. Aucun lancement iPhone. |
| Collecte des symboles | Nouveau blocage reproduit : Xcode crée `BuildProductsPath/Release-iphoneos/Assist.app` comme lien vers `InstallationBuildProductsLocation/Applications/Assist.app`. Le collecteur rejetait ce lien. Il choisit maintenant directement ce chemin réel pour ce seul layout, sans suivre de lien arbitraire. Régression rouge avant correction, 40 tests verts après, dont les refus de liens internes et externes. |
| Collecte avec outils Apple réels | Sur le Mac/SDK26.2 : trois minuscules exécutables C arm64 et leurs vrais dSYM, même disposition et lien Xcode, `plutil`, `dwarfdump`, ZIP et vérificateur réels : exit0. Ce sont des fixtures, sans compilation Assist ni signature de production. |
| Déclaration de confidentialité | L’import vocal vérifie l’espace disponible puis refuse visiblement la copie si nécessaire, mais le manifeste principal omettait DiskSpace. Ajout du motif `E174.1` pour cet usage, sans collecte ni suivi supplémentaires, selon les [motifs publiés par Apple](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype). |
| Empreintes archive/export | Le vérificateur privé comparait le SHA global d’un exécutable archivé à celui de l’IPA exporté. Une fixture de re-signature ad hoc démontre que ce SHA peut changer, malgré signatures strictes valides et UUID/dSYM/sections de code inchangés. Les SHA des deux stades sont maintenant rapportés distinctement, écarts explicites, avec validation du SHA archivé; signatures, profils, entitlements, identités/source/ID, SHA des dSYM et concordance UUID restent exigés. Un UUID ne prouve pas cryptographiquement tous les octets de code. |
| Source/configuration/artefacts | 129 contrôles Node combinés passent : workspace, capacités, archivage et symboles; lint du test de hook passant. |
| Fin d’archive et export | Liaison de l’app principale, extraction AppIntents principale, embedding final, export IPA et hook de succès restent à démontrer. Les profils/capacités Apple sont prêts; cela ne prouve pas un IPA signé. |

Les reçus et le journal Xcode complet sont conservés hors Git dans
`/home/ales27pm/.local/share/assist/releases/1.0.0-29-ee7b22d4/`.
Les helpers privés de vérification ont aussi leurs tests complémentaires :
11 passants sur Linux avec le vrai validateur de capacités et 11 sur Mac, avec
un scénario spécifique à l’autre hôte explicitement sauté sur chacun. Les versions
de helpers gelées avant la tentative échouée restent intactes; une nouvelle
tentative devra lier de nouveaux attendus à son propre ID et au nouveau commit.
Une nouvelle build payante attend un nouvel accord explicite; aucune OTA,
soumission ou diffusion n’est déclenchée par l’examen préventif.

## Quatrième tentative : IPA produit, collecte des dSYM inachevée

Après le nouvel accord explicite d’Alexis, la tentative utilise le commit propre
et poussé `b6a7757176e7af1f5e257ea8bbddf9254366aadf`, archive source vérifiée
de 775 fichiers :

- [Quatrième build EAS29](https://expo.dev/accounts/ales27/projects/assist/builds/f1cbfd7a-4198-45ac-9b37-72ec6a97ae92),
  créée le 20 octobre à 01:08:41 UTC, terminée `ERRORED` à 01:16:39 UTC.
- Tous les contrôles pré-installation passent, dont le nouveau consommateur du
  header Swift sous Xcode27.1. La compilation du vrai pont RCT, l’édition des liens,
  le bundle de production, les métadonnées AppIntents et l’archive/export aboutissent.
- L’IPA est uploadé par EAS avant le hook de succès : 24 059 801 octets,
  SHA-256 `84b00c0450bef49e920dc94a2399cfcfd17de1a0e9dd1b5d5136e5b317b1a895`.
- Le hook de succès s’arrête ensuite sur `Build product paths must not contain symlinks`.
  Le ZIP de dSYM est absent des artefacts publiés; aucune soumission Apple n’est lancée.

### Inspection du véritable IPA

L’IPA téléchargé est inspecté sur le Mac, avec contrôle de son empreinte de
transport et des références gelées. **41 contrôles passent**, ainsi que le vrai
validateur Linux des profils/capacités :

- signatures `codesign --deep --strict` de l’app, Partage et Widget;
- profils App Store, App Group exact des trois produits, WeatherKit dans l’app;
- versions 1.0.0 (29), runtime `1.0.0-native29`, canal `testflight`, SDK iOS27.1,
  ressources, clé publique des packs et métadonnées AppIntents;
- déclarations source préservées. Les raisons supplémentaires du manifeste
  principal proviennent du manifeste ExpoFileSystem58.0.9 embarqué, identique
  octet pour octet à celui de la dépendance épinglée; aucune collecte ni suivi ajouté.

UUID des exécutables : Assist `73A736DC-6349-3FF8-ACAB-74BDCDDB1851`,
Partage `96E60432-B622-3679-AE89-DF0F3714D347`, Widget
`971B9AA1-471F-30BA-8975-6B8E89A13BCB`.

L’IPA contient aussi quatre fichiers Apple `.symbols`, acceptés par l’outil
Apple et correspondant aux UUID des trois produits et d’ExpoModulesJSI. Ils
contiennent des fonctions et informations de lignes : notamment 111 592 symboles
et 424 657 `SourceInfos` pour Assist. Les mentions `Found-dSYM` et chemins DWARF
affichés sont des métadonnées conservées dans ces fichiers : les chemins originaux
du runner n’existent pas sur le Mac inspecteur. Ces données utiles ne sont pas le
bundle dSYM original et son manifeste/hash attendu. Les rapports restent donc
**`partial=true`, `symbolsVerified=false`, `canSubmit=false`**.

L’API EAS actuelle ne publie pour cet ID que l’IPA et les journaux :
`buildArtifactsUrl` nul, aucun artefact Workflow ou session SSH. La création
du ZIP de dSYM par Fastlane sur le runner ne prouve pas sa récupération.

### Correction de la collecte après une vraie archive

Les régressions sur alias du dossier `Products` ou du dSYM reproduisent d’abord
le raccourci `stat()` qui suivait un lien. La découverte est maintenant bornée
aux dossiers physiques, et tout refus indique le chemin relatif fautif.

Un essai supplémentaire produit une vraie archive Xcode locale de trois minuscules
cibles, sans code Assist, dépendances externes ni signature de production. Il
révèle que l’app est déplacée dans l’archive externe après `ARCHIVE SUCCEEDED` :
`InstallationBuildProductsLocation` disparaît et le lien voisin pointe vers un
emplacement disparu. Le collecteur corrigé lit les trois produits de l’IPA exact
`ios/build/Assist.ipa`, puis lie leurs identités et UUID aux dSYM physiques. Il
refuse un IPA présent mais invalide, sans revenir aux produits intermédiaires.
La lecture ZIP est bornée et seuls les six fichiers Info.plist/exécutable attendus
sont extraits; chemins dangereux, doublons et liens sont refusés.

Le manifeste conserve le SHA-256 et la taille de l’IPA exporté, ainsi que les trois
SHA-256 exécutables portant explicitement `executableHashStage: exported_ipa`.
La vérification finale exigera ces mêmes octets, en plus des identités, signatures,
profils, capacités, ressources, SHA-256 dSYM et UUID. Elle ne confond pas les
empreintes d’un produit avant signature avec celles de l’IPA exporté.

Preuves après correction :

- **61 tests Node passent**, avec contrôles de syntaxe et `git diff --check`.
- La vraie archive Xcode locale à trois cibles minimales (SDK26.2, sans signature
  de production) passe le collecteur et le vérificateur, exit0. Son ZIP dSYM fait
  875 500 octets, SHA-256 `9cf5a5c8804e7b72290b7638af33ccb3f3f6129be424702d3f99dce755bce03d`.
- Le lecteur accepte également le véritable IPA de la quatrième tentative, puis
  refuse les dSYM de la fixture pour UUID différents. Aucun dSYM n’est modifié
  ni artefact de remplacement produit.
- Les helpers privés de validation couvrent **20 tests**, dont 19 exécutés sur
  Linux et 18 sur Mac, les contrôles propres à l’autre hôte étant explicitement
  ignorés. Le refus couvre notamment un SHA différent à UUID identique, un stade
  absent et une empreinte ou taille globale d’IPA différente.

Le test local Xcode vérifie le parcours d’archivage; il ne recompile pas Assist
et ne qualifie pas l’iPhone. Les helpers et attendus gelés de la quatrième
tentative restent intacts; une prochaine tentative utilisera de nouveaux
attendus liés à son propre ID et au nouveau commit.

L’IPA, journaux, profils/capacités et symboles embarqués sont conservés hors Git :
`/home/ales27pm/.local/share/assist/releases/1.0.0-29-f1cbfd7a/`.
Les preuves du correctif sont conservées séparément sous `post-failure-xcode-symbols/`
et `post-failure-export-binding/`, avec leurs inventaires d’empreintes.
Aucune OTA, nouvelle build ou soumission n’est déclenchée automatiquement.

## Soumission de l’IPA existant sur instruction explicite

Alexis demande ensuite « Submit ». Avant l’envoi, la relecture Apple ne trouve
aucune build29 et les dix dernières soumissions EAS ne montrent ni soumission29
ni envoi récent non résolu. L’empreinte de l’IPA et les 41 contrôles de son rapport
partiel sont revérifiés. L’autorisation de soumettre cet IPA existant, avec le
dSYM original toujours indisponible, est consignée séparément; les rapports
`partial=true`, `symbolsVerified=false`, `canSubmit=false` restent intacts.

La [soumission EAS29](https://expo.dev/accounts/ales27/projects/assist/submissions/05525496-9daf-4489-801f-5e8d5fd6c19a)
est créée le 20 octobre à 01:39:47 UTC, depuis le fichier local vérifié, avec
`--path`, profil `testflight` et `--no-auto-testflight-setup`. Le binaire correspond
au commit `b6a7757176e7af1f5e257ea8bbddf9254366aadf`; la correction ultérieure
du collecteur de symboles ne change pas ce binaire. Aucun nouvel essai payant,
changement de groupes externes, OTA ou envoi App Store de production n’est lancé.

L’upload vers EAS Submit et sa planification sont réussis; l’état Apple final et
la disponibilité TestFlight ne sont pas encore attestés à ce point du relevé.
