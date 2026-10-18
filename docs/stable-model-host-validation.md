# Lot local : hôte vocal stable et packs remplaçables

Branche isolée : `work/stable-model-host`, base `1129342d1c7bd95ba20d4f9a45da7587010a5467`.
Cette page décrit les preuves préparatoires du lot build27/runtime
`1.0.0-native27`, pas une installation ni un crash iPhone corrigé.
Le [journal EAS27/TestFlight](voice-testflight-27.md) consigne séparément
l’échec de compilation, sa correction et la livraison de la nouvelle tentative
explicitement autorisée, sans les confondre avec une qualification iPhone.
Les modifications non liées du checkout original sont conservées.

## Incident de référence

Le rapport texte et le rapport JSON portent le même identifiant
`D28D663F-A83E-4A44-B486-49DF2A65F0B0`, build 26,
UUID Mach-O `4A12E79E-80DB-3AEF-85A4-0CF10D0705EF`.
Assist est lancé le 17 octobre 2026 à 22:07:44.2650 et termine à 22:13:01.8506
(Toronto). Le thread 10 lève une exception Objective-C dans
`MLE5ExecutionStream.prepareAsyncSubmissionForInputFeatures` sur la file
`com.apple.coreml.DefaultAsyncPredictionQueue`, puis appelle abort/SIGABRT.
Le motif textuel de l’exception n’est pas présent. Ce n’est pas la pile OOM
Hermes du crash distinct de la build 25. Une pression mémoire critique antérieure
est observée, sans prouver le déclencheur de cette exception.

## Changements préparés

- Les sessions Pocket retirées restent suivies jusqu’à la fin réelle de leur
  producteur. Un arrêt complet attend ces retraits avant d’autoriser le prochain
  chargement ou une mutation des ressources. La régression est reproduite avec
  un producteur bloqué, sans conclure qu’elle causait cet incident précis.
- Les lectures Float32 de Flow/Silero contrôlent type, nombre et layout avant
  déréférencement. Les descripteurs d’entrée sont contrôlés avant prédiction.
  Les échecs de chargement Parakeet et de synthèse conservent des codes techniques
  bornés, pas les chemins ou descriptions arbitraires.
- Un observateur natif attend la consignation d’un début de prédiction avant
  soumission Core ML. Il couvre six composants asynchrones Pocket/Parakeet,
  avec UUID, route configurée et métadonnées de tenseur bornées. Le moniteur ne
  stocke ni valeurs, texte, audio ni noms de features arbitraires.
  Ce n’est pas un gestionnaire NSException et il ne protège pas toutes les
  prédictions de tous les moteurs. Le checkpoint peut être antérieur à l’échec.
- Les [packs versionnés signés](versioned-voice-packs.md) permettent de varier
  des poids compatibles avec ce moteur, sans nouvel hôte. Import vérifié,
  publication atomique et restauration du précédent sont testés localement.
- La [conservation des dSYM](eas-build.md) est préparée avec manifeste d’identité
  UUID/SHA-256/version/runtime/révision. Le succès réel de la collecte sur le
  runner et la concordance avec le prochain IPA restent à contrôler.

Les modèles actuels, poids, précision, routes par défaut, contexte 32K et texte
prononcé ne sont pas remplacés. Aucune intégration PostHog ou autre collecte
distante n’est activée.

## Garde de validation

Les preuves locales doivent rester distinctes :

| Frontière | Validation attendue |
| --- | --- |
| JS et pont | TypeScript, ESLint, Jest complet, Codegen ; pas une compilation ObjC++ de l’app |
| Packs | Signateur Node et vérificateur Swift/CryptoKit, vrai disque, poids synthétiques ; pas une inférence |
| Swift natif | Tests de contrats/moniteur et SDK source, contrôle ARM64 iOS26 ; pas une archive SDK27 signée |
| Release | Profils EAS résolus localement, artefact de symboles testé avec fixture ; pas une soumission Apple |
| iPhone | À faire sur le futur binaire avec les vrais packs, aucune preuve remplacée par les tests ci-dessus |

La CI de contrats sélectionne explicitement Xcode 26.3/Swift 6.2, installé sur
l’[image macOS 15 documentée par GitHub](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md#xcode),
plutôt que son Xcode 16.4 par défaut. Cette configuration n’annonce pas une
exécution réussie de GitHub Actions et ne compile pas l’app Core AI SDK 27.

Les nouveaux contrôles de descripteurs concordent avec les fichiers du pack
épinglé déjà présent, lus sans extraction ni chargement : Silero
`metadata.json` (`2740be542c611e1ba358e1849b4e265c65cdf0b17192767e1e5de86a31ac94d6`)
déclare les entrées Float32 `[1,4160]`, `[1,128]`, `[1,128]` ; Flow `model.mil`
(`0257898b9a6ce06c961959aae993bb27c558f509fbea7407d094b879f872ec3f`)
déclare les entrées Float32 `[1,32]` et `[1,1024]`, puis la sortie `[1,32]`.
Les empreintes correspondent au manifeste embarqué inchangé. Les strides et
types effectifs fournis par Core ML pendant l’exécution restent à observer.

Résultats du lot local : `npm run check` passe (TypeScript, ESLint,
757 tests dans 31 suites et Codegen). Les tests Node passent pour la signature
(6) et les symboles (9), y compris la recherche dans l’arborescence
`ArchiveIntermediates` observée dans le vrai log de build 26. Les 14 groupes de
contrôles fichiers Swift passent, dont l’interop Node→CryptoKit et la restauration
Redux/Ultra. Le SDK passe 49 tests en 7 suites et compile pour ARM64 iOS 26.
Les 15 contrôles Fluid, 32 duplex et le moniteur passent ; ce dernier récupère un
début de prédiction après SIGKILL d’un vrai sous-processus de test.

Un ancien test supposait une deuxième mesure du sampler en 650 ms. Sur la VM,
un checkpoint valide n’en contenait encore qu’une : aucune erreur disque.
Le harness attend désormais l’observation persistée avec une borne de 5 s et teste
les exports sans sampler concurrent ; la progression autonome reste vérifiée
séparément. Le passage final est vert, sans changement de cadence en production.

Toutes les sources `Voice/*.swift`, le moniteur et le bloc observateur exact
extrait de `AssistCoreAI` passent le contrôle de types strict contre le vrai
module FluidAudio ARM64. Le moteur Core AI complet SDK 27 n’est pas remplacé par
un faux module : sa compilation reste une frontière non vérifiée localement.
L’en-tête Objective-C réel des sources Voice est aussi généré en mode app,
puis consommé par Clang Objective-C++ avec un appel à `restorePreviousPack`.
Les deux compilations passent. Le patch SDK se rejoue sur les neuf sources
modifiées, depuis les empreintes upstream épinglées jusqu’aux octets finaux.

Sur le téléphone, après autorisation de la build unique : vérifier d’abord
l’identité IPA/dSYM et le chargement du pack existant sans réimportation, puis
trois tours vocaux, interruption pendant la réponse, pause/reprise, arrière-plan,
fermeture pendant préparation et reprise. Conserver le checkpoint précédent en
cas de fermeture. Tester ensuite deux packs réellement qualifiés et leur
restauration, sans nouveau binaire. Surveiller le pic mémoire et les composants
en cours ; un succès d’import ne suffit pas.

Un nouveau moteur, une modification Swift/Objective-C ou une nouvelle clé
publique nécessitent un binaire. Un pack compatible ne répare pas à lui seul
une erreur native. Les mises à jour JS doivent conserver le même contrat natif
et le runtime ciblé ; aucun OTA n’est publié dans ce lot préparatoire.
