# Suivi natif d’Assist

Cette intégration adapte les métriques, événements bornés et vues de progression
de [rork-swiftllm-mobile-stack, révision `dbd1a56`](https://github.com/ales27pm/rork-swiftllm-mobile-stack/tree/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a).
Les contrôles locaux ci-dessous vérifient l’intégration et son contrat. Ils ne
remplacent pas la vérification du suivi sur un iPhone.

| Source examinée à la révision épinglée | Adaptation dans Assist |
| --- | --- |
| [MetricsLogger.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Services/MetricsLogger.swift), [InferenceMetrics.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Models/InferenceMetrics.swift) | Instantanés, codes d’événements et résumés de générations en mémoire dans `AssistRuntimeMonitor` ; durées et compteurs issus du natif Core AI. |
| [ThermalGovernor.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Services/ThermalGovernor.swift) | Observation thermique et pression mémoire uniquement ; nouvelles mesures Darwin, sans gouverneur d’inférence. |
| [MetricsDashboardView.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Views/MetricsDashboardView.swift) | Organisation du panneau React Native `MonitoringPanel` : état courant, courbes, événements, générations et partage explicite. |
| [DiagnosticEngine.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Services/DiagnosticEngine.swift), [DiagnosticsView.swift](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Views/DiagnosticsView.swift) | Progression et compteurs des **48 cas RMSNorm existants** : deux frontières F16/F32 × deux modes demandés × douze fixtures ; résultats réellement produits par leur runner. |
| [Guide de journalisation du cycle de vie](https://github.com/ales27pm/rork-swiftllm-mobile-stack/blob/dbd1a56fc8130c5de77e6d11b2be58cc23699f8a/ios/NeuralEngine/Docs/LifecycleInferenceSignpostLogging.md) | Corrélation des phases, requêtes et transitions d’activité dans les événements en mémoire. Les signposts et le journal système amont ne sont pas portés. |

Les empreintes Git des sources et le texte Apache 2.0 complet figurent dans
[MonitoringAttribution.txt](../mobile/ios/Assist/MonitoringAttribution.txt).
Les vues SwiftUI et le moteur amont ne deviennent pas des dépendances d’Assist.

## Mesures et limites

Le moniteur démarre avec le moteur natif et vise un prélèvement **chaque seconde
au premier plan**, même si le panneau est fermé ou le JavaScript occupé. Le
panneau lit ces mesures environ une fois par seconde ; ses exports ne créent pas
de nouveaux prélèvements. Les historiques gardent au plus **60 échantillons**,
**200 événements à codes constants** et **100 générations**. Le natif borne les
appels système à un prélèvement par 500 ms. Les retards d’ordonnancement peuvent
toujours masquer une pointe. Le minuteur s’arrête en arrière-plan et reprend au
premier plan ; l’intervalle sans observation n’est pas interpolé.

| Champ | Sens et limite |
| --- | --- |
| `sessionElapsedMs`, `generationElapsedMs`, `ttftMs` | Durées natives avec `ContinuousClock` ; TTFT jusqu’au premier jeton généré. Les dates murales ne servent pas à calculer ces durées. |
| `promptTokens`, `generatedTokens` | Compteurs du moteur, après tokenisation ; ni caractères ni nombre de notifications UI. |
| `decodeTokensPerSecond` | Moyenne après le premier jeton : `(generatedTokens - 1) / ((generationElapsedMs - ttftMs) / 1000)`, seulement avec au moins deux jetons et un intervalle positif fini. Ce n’est pas une fenêtre glissante. |
| `physicalFootprintBytes` | `task_info(TASK_VM_INFO).phys_footprint`, empreinte physique du processus ; ni taille du modèle ni RSS. |
| `peakPhysicalFootprintBytes` | Maximum des prélèvements de la session. Les pics entre deux prélèvements peuvent être manqués. |
| `availableMemoryBytes` | `os_proc_available_memory()` : budget mémoire restant estimé **pour l’app**, pas RAM libre de l’iPhone, pas garantie d’allocation. |
| `cpuPercent` | Différence des temps CPU utilisateur + système de `getrusage`, divisée par la durée monotone entre prélèvements. **100 % = un cœur** ; plusieurs cœurs peuvent dépasser 100 %. Ce n’est pas la charge CPU totale de l’appareil. |
| `thermalState`, `memoryPressure`, `lowPowerMode` | État thermique iOS, notifications de pression et mode économie d’énergie. La pression reste `unknown` avant une observation ; les états ne mesurent ni degrés ni watts. |
| `voiceStage` | Repère natif borné : préparation, PocketTTS, Parakeet, Silero, session de lecture, démarrage audio, écoute, parole, arrêt ou échec. Distinct de `phase`, qui décrit Core AI : `ready` ne signifie pas que la pile vocale est inactive. Aucun libellé libre, texte dicté ou détail de chemin n’est transmis au moniteur. |
| Événement `observedElapsedMs` | Instant monotone d’observation de la notification. `elapsedMs` conserve l’ordre de livraison sans revenir en arrière ; le champ d’observation permet de reconnaître une notification livrée en retard. Une ancienne notification d’arrière-plan ne peut pas arrêter un suivi repris plus récemment. |

Une métrique indisponible reste absente ou `null`, un état indisponible vaut
`unknown`. L’interface ne remplace pas l’inconnu par zéro ou par « sain ».
`aneExecution` reste `unverified` : options de calcul, débit, CPU et température
ne mesurent pas l’utilisation ANE/GPU ni le placement effectif des opérations.

Le suivi observe l’exécution : il ne réduit pas le contexte 32K, ne change pas le
backend, n’impose pas de délai thermique entre jetons et ne modifie pas la
température de génération. Le coût de cette instrumentation reste inclus dans
les durées mesurées ; il n’est pas soustrait. Les résultats du diagnostic de
primitives restent distincts de la
[fidélité numérique de Gemma](gemma-numeric-fidelity.md) et de sa qualification.

## Données conservées et choix amont écartés

Les instantanés contiennent des nombres, états et identifiants opaques de
requêtes ; les événements utilisent des codes constants. Aucun prompt, réponse
de conversation, transcription, audio ou chemin de modèle n’est enregistré dans
ce suivi. Aucun envoi automatique : le partage est une action explicite.

Le natif sauvegarde progressivement dans le répertoire privé Application Support
`AssistDiagnostics/RuntimeMonitoring`, avec deux fichiers fixes : `current.json`
et `previous.json`. Chaque rapport est borné à **128 Kio**, les anciens éléments
étant supprimés si nécessaire. Les écritures sont atomiques, exclues des
sauvegardes système et protégées sur iOS jusqu’au premier déverrouillage.
Une sauvegarde est visée toutes les cinq secondes de prélèvement, ainsi qu’aux
transitions importantes, avec limitation de fréquence. Un échec d’écriture
n’interrompt ni le suivi ni l’inférence et apparaît dans `persistence.status`.
Ces petites écritures sont synchrones sur l’acteur du moniteur, jamais sur le
thread principal ; un appelant natif qui attend une transition peut en payer le
coût. L’instrumentation ne prétend pas être sans coût.
`lastSuccessfulCheckpointAt` indique le dernier succès, pas une garantie que les
observations ultérieures sont sur disque.

Au premier démarrage du moniteur, le dernier fichier courant valide devient la
session précédente avant la première nouvelle sauvegarde. Un fichier courant
tronqué, invalide ou surdimensionné ne remplace pas une session précédente
valide. Le bouton **Exporter la session précédente** lit ce rapport à la demande,
le valide puis ouvre le partage. Il n’exporte pas silencieusement la session
courante si la précédente manque. Le rapport conserve son identifiant de
session, ses dates et sa version native d’origine.

Ce journal **n’est pas un gestionnaire de crash** et ne prouve pas pourquoi une
session s’est arrêtée : fermeture volontaire, arrêt système et plantage peuvent
laisser le même dernier checkpoint. Une terminaison brutale peut perdre les
dernières secondes ; aucun code n’attend un signal fatal pour écrire. La session
précédente est conservée jusqu’au prochain démarrage produisant une rotation
valide, et non indéfiniment. Un ancien binaire sans cette API affiche qu’une
version native compatible est nécessaire ; une mise à jour JavaScript seule ne
peut pas ajouter le minuteur et le stockage natifs.

Le calcul amont `physicalMemory - resident_size` n’est pas repris : il ne donne
pas la mémoire libre ou le budget de l’app. Ses valeurs zéro en cas d’échec, son
état thermique inconnu ramené à `fair`, ses horodatages de jetons sans borne et
ses durées calculées avec `Date` ne définissent pas les mesures Assist. Ses
notifications de pression n’écoutent pas le retour à `normal` ; Assist doit
observer cette transition. Les labels « compute units », « Neural Engine
eviction » et « Optimal » du tableau de bord ne constituent pas des preuves
matérielles ou de santé.

Le gouverneur de délais, température, récupération et contexte n’est pas porté.
La grande suite base de données, fichiers, mémoire personnelle, voix et réseau
n’est pas importée. Un test amont qui indique « passed » en l’absence de données
de santé ne qualifie pas Assist. L’annulation par simple drapeau et l’écriture
automatique d’un rapport temporaire du moteur amont ne sont pas reprises comme
contrat du diagnostic RMSNorm.

## Validation et essai iPhone

### Journal persistant (modifications du 17 octobre 2026)

Les vérifications ajoutées couvrent le prélèvement sans lectures JavaScript,
l’arrêt/reprise, la libération du moniteur, les bornes et la limitation des
écritures, la rotation sur fichiers temporaires réels, les rapports incomplets
ou trop grands et l’échec du stockage. Les tests d’interface couvrent la lecture
paresseuse, l’absence de session précédente, l’ancien binaire, le refus des
données privées et les réponses tardives après fermeture ou arrière-plan.
Ces contrôles ne constituent pas un essai du correctif sur l’iPhone.

Validation de cette modification : **739 tests React Native**, TypeScript,
ESLint, génération du pont iOS, 12 gardes d’intégration vocale et deux contrôles
de lancement passent. Le moniteur et ses contrôles sont compilés et exécutés sur
la VM Mac avec Swift 6.2.4 en concurrence stricte. Un sous-processus de test est
tué par SIGKILL après sauvegarde, puis son dernier checkpoint est récupéré par
une nouvelle session, sans export préalable ni arrêt gracieux. Le moniteur
passe aussi le contrôle de types ARM64 iOS avec UIKit/Darwin. Les changements
du pont Swift/voix passent l’analyse syntaxique ; l’app complète n’a pas été
compilée ni réinstallée, et aucune build EAS n’a été lancée.

À qualifier lors d’une prochaine installation native autorisée : fermer le
panneau, charger les modèles complets, démarrer l’écoute puis quitter et rouvrir
l’app ; exporter la session précédente **avant une nouvelle relance**. Vérifier
son identifiant et ses repères vocaux, puis le passage arrière-plan/premier plan.
Un arrêt forcé ne doit pas effacer le dernier checkpoint valide. Aucun essai ne
garantit la capture du pic exact ni ne remplace le rapport système de crash.

### Résultats historiques

Les vérifications locales du 16 octobre 2026 passent : TypeScript, ESLint,
**73 tests React Native**, génération du pont iOS, 17 cas de prévol,
64 cas du vérificateur de paquets et deux contrôles de lancement. Le projet
Xcode contient le moniteur dans les sources et l’attribution dans les ressources.
Les **64 fichiers synthétiques** du diagnostic sont identiques à ceux de la
build 6.

Les contrôles Swift 6 avec concurrence stricte vérifient le réducteur, les
bornes 60/200/100, les unités CPU, le débit, les valeurs absentes, la
confidentialité, les fins de génération et diagnostics partiels, ainsi que
l’arrêt terminal. Les 91 contrôles de politique d’inférence passent aussi.
Ces compilations Foundation sur Linux ne compilent pas les branches Darwin,
UIKit ou Core AI.

Six instantanés encodés par le vrai moniteur Swift sont acceptés par le parseur
TypeScript. Leur lecteur système Linux est remplacé, dans une copie privée
de test uniquement, par une mesure explicitement synthétique avec
`lowPowerMode: false` ; ils ne constituent pas des mesures iPhone.

Le rapport iPhone du build **7**, reçu ensuite sous iOS 27.2 (24B5110a), contient
60 échantillons, 59 événements et deux résumés de génération. Il enregistre le
chargement, les générations, le déchargement puis les 48 contrôles numériques,
avec les 12 échecs effectivement présents dans leurs résultats et un retour
à `idle`. Les durées et débits sont cohérents avec les compteurs ; les métriques
de mémoire et de thermique sont renseignées, tandis que la pression reste
`unknown` faute d’événement. Ce rapport confirme ce parcours observé, sans
valider la mise en page, l’arrière-plan, l’annulation ou les pointes manquées
entre échantillons.

Sur la build distribuée, vérifier le chargement, la génération, l’EOS,
l’annulation et la progression des 48 cas. Tester le panneau ouvert puis fermé,
le passage arrière-plan/premier plan, l’absence de nouvelles requêtes de suivi
en arrière-plan et le partage déclenché uniquement par l’utilisateur. Les tests
avec pont simulé ne remplacent pas ces observations iPhone, une analyse
Instruments ou un rapport système de terminaison.
