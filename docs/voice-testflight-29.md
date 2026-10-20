# TestFlight 29 — candidat et livraison

État courant : deux tentatives EAS29 échouées dans les contrôles pré-installation,
avant l’archive Xcode; correctifs locaux validés. Aucun IPA29, aucune soumission,
aucune relance automatique.

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
