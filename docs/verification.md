# État de vérification — 15 octobre 2026

Le build de diagnostic **1.0.0 (4)** est désormais signé et disponible en test
interne TestFlight (`VALID`, `IN_BETA_TESTING`). Il ajoute les
[observations numériques bornées](gemma-numeric-fidelity.md#diagnostic-de-lécart-restant)
nécessaires à l’analyse de l’erreur des cubes. La correction de cette erreur et
son opérateur responsable restent à isoler. Les
[rapports 20 à 23](gemma-numeric-fidelity.md#rapports-20-à-23--diagnostic-natif-et-récupération-longue)
séparent deux observations. Seul le rapport 20 contient `numericalDiagnostics` :
entrée exacte, moteur réinitialisé et inversion de classement entre `4` et `8`
avant le choix glouton. Les rapports 21 à 23, avec un budget de 256, n’activent
pas ce champ ; les trois textes longs donnent chacun
six lignes exactes sur six, jusqu’à 32 256 jetons d’entrée et 89 de sortie.
Il s’agit d’un passage par cas ; la répétabilité et l’usage ANE restent à qualifier.

L’[essai 32K avec normalisations HF32](gemma-numeric-fidelity.md#essai-séparé-avec-normalisations-hf32)
est suspendu après réception de [journaux d’échec du chargement](gemma-numeric-fidelity.md#échecs-natifs-du-chargement-journaux-de-23-h-07-et-23-h-08).
Un abandon Metal pendant le préchauffage et un arrêt mémoire d’un autre
processus Assist sont confirmés. L’utilisateur confirme le dossier HF32 ; les
journaux ne fournissent pas l’empreinte de ses fichiers installés.
L’export, ses neuf signatures, l’inventaire et le ZIP passent leurs contrôles,
et la référence CPU donne 8/8. Ces contrôles n’établissent pas sa viabilité native.

Le correctif **1.0.0 (3)** est signé et traité par TestFlight. La capture
utilisateur du 15 octobre à 02:49 EDT confirme l’affichage de l’interface initiale
sur l’iPhone après sa livraison. Les
[rapports physiques](gemma-32k-export-2026-10-15.md#rapports-2-à-8)
confirment ensuite le chargement, une annulation et des générations jusqu’à
32 256 jetons d’entrée. Les cas synthétiques 8K et 16K sont exacts ; près de 32K, une clé de
réponse est incorrecte. Deux essais courts échouent au calcul des carrés, alors
que les contrôles CPU BF16 source et FP16 intermédiaire répondent correctement.
Le [diagnostic numérique](gemma-numeric-fidelity.md) reproduit ensuite exactement
l’erreur avec les seuls poids palettisés, dans la référence HF. Le tokenizer
Swift épinglé, exécuté sous Linux, produit les mêmes 33 identifiants que Python.
Le nouvel export 32K à groupes de 8 réussit 8/8 contrôles CPU figés, contre 5/8
pour l’export initial avec le même script. Les
[rapports 9 à 19](gemma-numeric-fidelity.md#contre-vérification-iphone--rapports-9-à-19)
confirment ensuite son chargement et sa génération iPhone : 7/8 cas courts
exacts, avec une erreur sur les cubes. Les trois textes longs donnent quatre
premières lignes exactes, puis atteignent le budget demandé de 64 jetons ; leurs
six lignes attendues nécessitent 89 jetons avant EOS. Les reprendre avec un
budget de 256, en conservant le modèle 32K. Un seul essai de l’ancienne série
est confirmé hors réseau par l’utilisateur ; celui de la nouvelle série n’est
pas établi. La qualification reste partielle ; l’écart numérique natif, la
stabilité répétée et l’usage ANE restent à vérifier.

## Livraison du diagnostic 4

Le [build EAS](https://expo.dev/accounts/27pm/projects/assist/builds/6d215087-9160-46b1-a1e0-33108fa6e078)
compile et signe le commit `0cb24b2` avec le SDK iPhoneOS 27.1. Son journal
Xcode confirme `ARCHIVE SUCCEEDED`. La
[soumission](https://expo.dev/accounts/27pm/projects/assist/submissions/f6ea4397-929e-46e4-8401-82406656bc45)
est terminée ; la lecture App Store Connect confirme le build 4, version 1.0.0,
`VALID` et `IN_BETA_TESTING`. Le statut externe reste
`READY_FOR_BETA_SUBMISSION` ; aucune disponibilité publique n’est revendiquée.

L’IPA de **11 608 126 octets**, SHA-256
`88678833b1bb5981cdd974fd2df222deae63bd00e84dfd170423b0739af271bb`,
contient le manifeste de scène, le manifeste de confidentialité, le JavaScript
embarqué et les nouveaux champs de diagnostic dans le binaire. L’import du
modèle reste manuel. Les vérifications locales passent : 30 tests JavaScript,
typecheck, lint, codegen, 91 contrôles Foundation sous Swift 6 strict, 64 tests
d’empaquetage, 17 cas de prérequis et deux contrôles de lancement. Les contrôles
Foundation seuls ne compilent pas Core AI ; l’archive EAS le fait.

La première programmation automatique des notes de test a été refusée par EAS
(champ `changelog` réservé à l’offre Entreprise), après création du build. L’état
du build et l’absence de nouvelle soumission ont été vérifiés avant de
programmer **ce même build**, sans ce champ. Un seul build 4 a été créé.
Les consignes de reprise restent dans le diagnostic lié ci-dessus.

## Crash de lancement TestFlight

Le prototype **1.0.0 (2)** avait échoué au premier lancement sur l’iPhone
sous iOS 27.2.

Le rapport du 15 octobre à 02:32 EDT désigne l’assertion UIKit
`UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`. Son UUID binaire
correspond à l’IPA du build 2 : son `Info.plist` compilé ne contient aucun
`UIApplicationSceneManifest`. Cette adoption est
[obligatoire avec le SDK iOS 27](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle).

Le correctif du build **1.0.0 (3)** déclare une scène unique et crée sa fenêtre
dans `SceneDelegate`. Le moteur React Native reste conservé par `AppDelegate`.
Deux contrôles de configuration échouent sur le build précédent et passent
après correction ; ils sont exécutés avant les builds EAS et dans la CI.
Ils ne lancent pas l’application. Le build 3 a ensuite été compilé et signé ;
son IPA contient le manifeste de scène et la classe `Assist.SceneDelegate`.
Apple l’a traité avec les états `VALID` et `IN_BETA_TESTING`. La capture
utilisateur montre l’app ouverte depuis TestFlight, en état `idle`, sans modèle
embarqué, conformément au prototype avec import manuel choisi. La répétition des
démarrages à froid, la réouverture et le retour d’arrière-plan restent à vérifier.

## Contrôles locaux historiques, avant le diagnostic 4

Ce relevé conserve les résultats de l’étape antérieure. Les nombres de tests
plus récents du build 4 sont indiqués dans « Livraison du diagnostic 4 » ;
aucune nouvelle exécution n’est revendiquée par cette section historique.

- React Native 0.87.1, React 19.2.3 ; dépendances npm verrouillées.
- `npm run typecheck` et `npm run lint` : succès.
- `npm test -- --runInBand` : 28 tests de protocole et d’interface avec doublure
  du moteur natif. Ne prouve pas l’inférence.
- `npm run codegen:ios` : succès ; protocole, événements et fournisseur
  `NativeAssist` → `RCTNativeAssist` générés.
- Bundle JavaScript iOS Release produit par Metro : succès. Avertissement de
  résolution d’un sous-chemin privé `ReactNativeFeatureFlags` dans les
  dépendances amont ; aucune compilation native n’est impliquée par ce succès.
- Swift 6 : 28 contrôles Foundation de contexte, chemins, EOS et UTF-8 exécutés sur
  macOS ; sélecteur UIKit type-checké avec le SDK simulateur disponible.
- Syntaxe du moteur Swift et format du projet Xcode contrôlés. Une analyse
  syntaxique ne vérifie ni les symboles Core AI ni leur édition de liens.
- Tests de prérequis : 15 cas ; cible app/Pods 27.1 et runtime Gemma 27.2 séparés.
- Empaquetage : 64 tests Node sur de petits fichiers synthétiques, inventaire
  exact et SHA-256, confinement, copie/relecture et refus des ressources absentes
  en mode livraison. Le profil `preview` impose ce dernier contrôle.
- La garde native iOS 27.2 est exécutée avant toute lecture du modèle ; syntaxe
  Swift et branche de disponibilité vérifiées, puis compilation complète sur EAS.

## Essai EAS et préparation de Gemma

Le projet `@27pm/assist` est créé. Le premier
[build EAS sans signature](https://expo.dev/accounts/27pm/projects/assist/builds/e51768ff-69cd-480b-a90b-ab50d7819a22)
sur Xcode 27.1 RC a passé les tests JavaScript et CocoaPods, puis **échoué** :
le SDK refuse une cible de déploiement 27.2. L’app et les Pods ciblent désormais
27.1, tandis que le chargeur refuse Gemma avant iOS 27.2.

Le [deuxième essai EAS](https://expo.dev/accounts/27pm/projects/assist/builds/554adb9b-05db-4c0d-a257-c0080c293e72)
a franchi ce blocage et atteint les sources natives, puis échoué à l’import du
header Swift généré : la superclasse React Native de `ReactNativeDelegate` n’était pas
déclarée dans l’unité Objective-C++. L’import explicite de son header est ajouté
avant `Assist-Swift.h`.

Le [troisième essai EAS](https://expo.dev/accounts/27pm/projects/assist/builds/9000a844-455c-43b8-bd09-158483a065a9),
sur le commit `f3ed738`, est **réussi** le 15 octobre à 05:37:56 UTC :
compilation ARM64 du moteur Core AI et du TurboModule, édition de liens et bundle
React Native terminés (`BUILD SUCCEEDED`). Les journaux sont archivés. Il s’agit
du profil **sans signature et sans modèle** : aucune IPA installable n’en découle.

Les neuf fichiers source de `google/gemma-4-E2B-it` à la révision documentée
ont été téléchargés hors Git et vérifiés (10 278 849 571 octets). Le shard
`model.safetensors` possède le SHA-256
`2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550`.
La conversion Core AI sous Linux a été vérifiée sur un Gemma **miniature
synthétique**, y compris les graphes 8K/32K et leur relecture. Aucun de ces tests
ne produit ni ne valide l’export du vrai checkpoint.

Une première conversion du **vrai checkpoint à 32K** a ensuite été tentée dans
un environnement isolé : staging FP16 vérifié de 2 011 tenseurs, prétraitement
par blocs et palettisation avec un seul worker. Ces adaptations locales de la
recette Apple ont passé 34 tests ciblés ; elles ne constituent pas une preuve de
parité numérique de bout en bout. Le checkpoint BF16 original a été conservé.

Cette tentative a **échoué à terminer** dans son budget de préparation : arrêt
systemd `Result=timeout` à 20 minutes, le 15 octobre vers 05:55 UTC. Les limites
étaient 8 Gio de seuil de récupération mémoire, 10 Gio de maximum, aucun swap
et deux cœurs CPU au maximum. La palettisation des 275 modules et le traçage des
huit programmes ont terminé, mais pas leur conversion finale Core AI. Les
derniers relevés montrent un fort trafic de relecture disque et de récupération
mémoire, sans OOM ; ils ne démontrent pas une progression utile de la conversion.
Il n’existe **aucun `.aimodel` final validé** de cet essai. Les sources, le sidecar
partiel et les journaux sont conservés hors Git, sans nouvel essai automatique.
Ce résultat concerne la préparation sur l’hôte, pas l’inférence iPhone ni l’ANE.

Un nouvel export 32K a ensuite abouti grâce aux adaptations mémoire décrites dans
le [rapport de préparation](gemma-32k-export-2026-10-15.md). Le vrai paquet et son
archive ont été relus et contrôlés. Le rapport physique utilisateur confirme
ensuite un chargement et une génération de 251 jetons, pour 42 jetons d’entrée,
avec le build 3 sous iOS 27.2.

## Limites explicites

Le Mac utilisé pour les premiers contrôles disposait de Xcode **26.3**, antérieur au minimum Core AI
**27.0** du paquet Apple. L’exigence **27.2** de Gemma porte sur l’exécution
sur iPhone ; l’ancienne formulation imposant aussi le SDK 27.2 était trop forte.
Le moteur Core AI complet est compilé ; le vrai export Gemma 32K est préparé et
une génération physique courte est confirmée par le rapport utilisateur. Le
modèle a été importé manuellement : `bundledModelAvailable` reste `false`.
La signature de distribution et le profil Assist sont configurés ; le build 3
est traité par TestFlight et son interface est affichée sur l’iPhone. Le crash
du build 2 est décrit ci-dessus. Des essais à longueur réelle 8K/16K/près de 32K
et un essai hors réseau sont documentés, avec leurs échecs de qualité. La
stabilité répétée, les performances soutenues, la récupération sans rechargement
et l’attribution matérielle ANE restent à qualifier. Ces travaux concernent
Assist ; aucune signature, installation ou modification n’a été effectuée sur
l’application distincte monGARS.

Le sélecteur n’effectue pas de copie durable : le dossier doit rester disponible
sur l’iPhone. Les builds décrits ci-dessus demandaient une nouvelle sélection
après fermeture de l’app. La version de travail ajoute la
[restauration par signet privé](model-restoration.md), avec revalidation avant
chargement explicite ; ce nouveau parcours reste à vérifier sur iPhone.
L’historique de conversation est également limité au processus pour cette étape.
Les contrôles de structure ne certifient pas l’identité cryptographique des poids.

## Alerte dépendances non résolue

`npm audit --omit=dev --audit-level=high` échoue : 20 entrées transitives liées
à l’avis [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
sur `braces` 3.0.3, via Metro/CLI et leurs dépendances. Ce nombre n’est pas
20 vulnérabilités indépendantes. L’avis ne publie pas de version corrigée à la
date du contrôle. `npm audit fix --force` propose un retour incompatible à
React Native 0.72 : cette modification n’a pas été appliquée.

Ne pas exposer Metro au public ni donner des motifs glob non fiables à cet
outillage. Aucun correctif amont ni absence d’impact n’est revendiqué.
La CI de contrat ne doit pas être interprétée comme un audit sécurité vert ou
une autorisation de livraison. Réévaluer cet avis avant distribution.
