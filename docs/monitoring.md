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

Le panneau demande un instantané environ **une fois par seconde au premier
plan**. Les historiques gardent au plus **60 échantillons**, **200 événements à
codes constants** et **100 générations**. Le natif borne aussi la fréquence des
appels système ; les compteurs d’inférence ne dépendent pas de la fréquence des
rafraîchissements JavaScript. Une suspension en arrière-plan crée un intervalle
sans observation, pas une série de points extrapolés.

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

Les instantanés contiennent des nombres, états et identifiants de requêtes ; les
événements utilisent des codes constants. Aucun prompt, réponse de conversation
ou chemin de modèle n’est enregistré dans ce suivi. Les historiques restent en
mémoire, sans fichier ni envoi automatique. Le partage est une action explicite
de l’utilisateur.

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

Sur la build distribuée, vérifier le chargement, la génération, l’EOS,
l’annulation et la progression des 48 cas. Tester le panneau ouvert puis fermé,
le passage arrière-plan/premier plan, l’absence de nouvelles requêtes de suivi
en arrière-plan et le partage déclenché uniquement par l’utilisateur. Les tests
avec pont simulé ne remplacent pas ces observations iPhone, une analyse
Instruments ou un rapport système de terminaison.
