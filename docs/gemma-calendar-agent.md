# Première boucle Gemma → calendrier → réponse

Préparation de source du 18 octobre 2026, base `6a26dcf27042d73833d8ce5b51178bdeb5f17562`.
Cette branche ne reconstruit ni l’assistant, ni le moteur, ni les outils iOS.
Elle ne constitue pas une livraison ni une qualification sur l’iPhone.

Ce document conserve la réception de la première tranche calendrier. Pour
l’extension ultérieure aux 13 outils, aux écritures confirmées, à la voix et à
l’OCR Apple, voir [Outils iOS conversationnels et OCR local](device-tool-agent.md).
Les exclusions et décomptes ci-dessous concernent uniquement cette première tranche.

## Inventaire et décision

Le manifeste épingle React Native **0.88.0**, React **19.3.0** et Expo **58**.
La documentation d’architecture mentionnait 0.87.1 : elle est corrigée, sans
modification de dépendances ou de poids. CoreAILM reste à `9db7476…` et
Tokenizers à `eed7264…`; Swift 6, concurrence stricte complète et isolation par
défaut nonisolated sont conservés. Le dossier de travail principal et la branche
séparée d’enchaînement TTS ne sont pas modifiés.

Le panneau PR2, ses confirmations et ses méthodes natives sont déjà présents.
`protocol.ts` et `InferencePolicy.swift` restent compatibles avec la génération
texte user/assistant terminée par user. Le nouveau protocole agentique est interne
au natif : appel et observation structurés occupent le même tour assistant dans
le template Gemma. Aucun résultat n’est déguisé en demande utilisateur.

Choix : **étendre CoreAILM direct**, avec le même propriétaire de moteur.
L’adaptateur Foundation Models est présent à la révision Apple épinglée, mais son
détecteur ne reconnaît pas les marqueurs de cette fixture Gemma. Il n’est donc pas
adopté pour cette tranche. Voir la [comparaison et les références primaires](gemma-tools-adapter.md).
Ni génération guidée, ni système Apple, ni fournisseur distant ne sont introduits.
La comparaison réelle du tokenizer a aussi exposé une différence Swift-Jinja;
une adaptation du template en mémoire, limitée au hash canonique vérifié, est
décrite et testée séparément. Les fichiers importés ne sont pas réécrits.

## Contrat borné et propriétaire des opérations

Le bouton **Consulter mon calendrier aujourd’hui** émet une demande dédiée avec
`schemaVersion:1`. Un handshake fermé exige `protocolVersion:1` et
`calendarReadOnly:true`; une ancienne build, une réponse malformée ou le navigateur
laissent cette commande désactivée. Aucun changement de permission ne découle de
la découverte.

Le natif capture le jour civil et le fuseau de l’appareil une seule fois. Les
journées de changement d’heure peuvent durer 23 ou 25 heures. L’unique déclaration
autorisée est `calendar_list(start_iso, end_iso, limit:5)`. Les arguments doivent
reproduire exactement cette fenêtre. Le modèle ne peut ni élargir la période, ni
choisir un autre outil, ni accorder une permission.

L’admission est créée synchroniquement avant la planification du travail. Une
annulation la révoque immédiatement et attend la fin de cette opération exacte,
même si le coordinateur d’inférence n’était pas encore entré. Une fois admise, la
tâche conserve `operationInFlight` et `generationTask` sur les deux passes et la
lecture. L’état de tâche (planning/executing/observing/terminal) est distinct de
l’état du moteur. Le cycle natif annule au passage inactif sans attendre JS.

Budgets initiaux : **un outil, deux passes, aucune reprise automatique**, 384 jetons
pour la proposition, au plus 1 024 pour la réponse et une réserve initiale de
2 048 pour le résultat. Le budget réel de contexte est vérifié sur chaque prompt.
Les requêtes ordinaires conservent leurs budgets existants. Le délai de 60 secondes
est coopératif : EventKit synchrone ne peut pas être préempté pendant son appel.
Un résultat tardif après annulation ne reprend pas le modèle.

## Données privées et sorties

L’intégration visuelle et les événements de preuve sont décrits dans
[Outils dans le fil](tool-ui.md). Une carte ne transforme pas une réponse du
modèle en reçu de lecture.

La lecture passe par `AssistDeviceCapabilities.listCalendarEvents`, avec contrôle
de premier plan, invalidation et accès calendrier complet avant/après. Aucune
demande d’autorisation implicite. Le wrapper JS et le chemin agent natif vérifient
types, clés, dates, chevauchement, tailles et limites; un objet JSON n’est pas
considéré fiable par simple assertion de type.

Le modèle reçoit seulement titre, début, fin et journée entière des cinq lignes
au plus. Les identifiants et noms de calendriers sont retirés. L’ordre du préfixe
n’est pas garanti; une liste de cinq est marquée possiblement tronquée. Ce ne sont
pas nécessairement les cinq prochains événements et une liste plafonnée ne prouve
pas que l’agenda est libre ou complet. Les titres restent des données non fiables.
Les délimiteurs réservés sont refusés avant leur insertion dans le template.

Proposition, appel et résultat natif ne sont jamais publiés en progression ni
envoyés au TTS. Le frontend bloque aussi tout événement de progression de cette
action, puis valide la réponse finale et sa trace de métadonnées. Les tours
calendrier sont visibles mais exclus du contexte réutilisé par les tours suivants.
Ils ne sont pas persistés comme journal d’actions ou mémoire personnelle.

Les mesures du rapport portent sur **la dernière passe LLM**, pas sur la durée ou
le pic de toute la tâche agentique. Le moniteur conserve les passes séparément
avec suffixes `:agent-plan` et `:agent-answer`. Il ne journalise pas leur texte.
Les totaux de tâche, p50/p95, mémoire transitoire et thermique restent à mesurer
sur appareil. Aucune revendication d’exécution ANE n’en découle.

## Livraison et lots exclus

La source prépare le build **28** et le runtime **1.0.0-native28**, cohérents entre
configuration Expo, plist iOS, projet Xcode et chaîne de runtime Android. Le canal
de publication est inchangé. Ce changement de bridge et de Swift **n’est pas une
OTA pour native27**. Ces métadonnées ne prouvent ni compilation, ni signature, ni
publication, ni installation. Aucun commit/push, EAS Build/Update ou Actions n’est
autorisé par ce travail.

Le lot C n’est pas commencé : aucune écriture du modèle, permis d’action,
confirmation vocale, journal durable, réconciliation ou garantie exactly-once.
Les créations manuelles du panneau PR2 gardent leur parcours existant. Les autres
outils, le raccordement vocal agentique, MCP/web, la vision et la mémoire durable
restent des lots distincts.

## Réception manuelle sur iPhone après livraison autorisée

1. Identifier iPhone, iOS, export/tokenizer, code et runtime réellement installés.
   Vérifier le handshake de cette build, sans le déduire de son numéro seul.
2. Sans permission calendrier : presser le bouton, constater un refus contrôlé
   sans boîte de permission et sans lecture. Accorder ensuite l’accès séparément
   dans le panneau existant, uniquement si voulu.
3. Préparer des événements synthétiques aujourd’hui, dont accents, guillemets,
   virgules et accolades. Presser le bouton et observer un seul appel borné,
   une observation validée puis une réponse. Ne pas exporter de titres privés.
4. Tester zéro événement, plus de cinq, journée entière et changement d’heure.
   La réponse ne doit pas déclarer une liste plafonnée complète.
5. Tester demande ordinaire et dictée partielle : aucune lecture d’outil.
   Une lecture calendrier ne doit pas contaminer le contexte du message suivant.
6. Annuler immédiatement avant admission, pendant le plan, pendant la lecture et
   pendant la réponse; passer en arrière-plan puis revenir. Aucun résultat tardif,
   deuxième appel ou reprise automatique. L’ACK d’arrêt attend le drainage natif.
7. Mettre dans un titre une instruction hostile et un délimiteur de protocole.
   La première ne change aucune autorité; le délimiteur entraîne un refus sûr.
   Toute syntaxe d’outil finale/tronquée reste hors affichage/TTS.
8. Vérifier hors réseau après import des ressources; iOS peut synchroniser les
   calendriers quand le réseau est disponible. Inférence locale ne signifie pas
   absence de synchronisation système.

Les faux modèles/exécuteurs ne sont utilisés que dans les tests. Même des tests
Swift et un tokenizer natif passants ne qualifient pas la sélection d’outil par
les poids importés, la continuation Core AI réelle ou les permissions EventKit.

## Vérifications exécutées sur ce diff

- `cd mobile && npm run check` : TypeScript, ESLint, **1039 tests / 37 suites** et
  Codegen iOS réussis. Les deux méthodes versionnées figurent dans le contrat
  généré; les fichiers générés restent hors du diff suivi.
- `test-agent-wiring.py`, `test-device-capabilities-contract.py` et
  `test-local-voice-contract.py` : **8 + 9 + 12** gardes de source réussies.
  Ce ne sont pas des essais d’API iOS.
- Sur macOS, Swift **6.2.4**, concurrence stricte et avertissements bloquants :
  `check-agent-calendar.sh`, `check-gemma-tools.sh` et `check-agent-loop.sh`
  réussis, dont **81 contrôles** du coordinateur de production avec modèle et
  exécuteur synthétiques. Le parse syntaxique arm64 iOS des sources d’intégration
  passe avec SDK 26.2; il ne vaut pas typecheck complet ou compilation d’app.
- Vrai module Tokenizers épinglé compilé dans un paquet temporaire à partir de
  caches hors réseau, avec Jinja 2.5.1 et la résolution identifiée : six marqueurs
  vérifiés et égalité exacte des IDs de prompt planning/continuation avec la
  référence indépendante Python du template original. Le processus de test était
  placé sous sandbox interdisant le réseau. Les échecs initiaux et les preuves de
  leur correction sont conservés séparément, pas remplacés par des mocks.
- Contrôle de diff et cohérence build/runtime 28 réussis; les trois harnesses
  natifs sont ajoutés aux prérequis d’une future build iOS autorisée. La première
  passe JS a exposé une garde historique trop spécifique au nombre de références
  `Tokenizer`; elle vérifie maintenant leur qualification, pas un nombre fixe.

Le préflight d’app est bloqué sur Linux; la VM Intel possède Xcode 26.3 / SDK 26.2,
pas le Mac Apple Silicon et SDK27 nécessaires à cette app Core AI. Aucune
compilation complète, signature, installation, sélection d’outil par Gemma réel,
lecture EventKit réelle, mesure de tour sur iPhone ou attribution ANE n’est prouvée.
Le lot B est donc **implémenté côté source mais non réceptionné sur appareil**.
