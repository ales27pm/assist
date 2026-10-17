# Vers une conversation vocale locale fluide

L’objectif est de réduire les attentes, respecter les hésitations et permettre
une interruption naturelle, tout en gardant STT, LLM et TTS sur l’iPhone. Les
expériences vocales de ChatGPT et Gemini servent de références perceptuelles;
ce plan ne promet ni leur qualité ni leur fluidité sur le matériel local.

**Le build 13 a maintenant une preuve positive de dictée après relance.**
L’utilisateur a relancé complètement l’app, chargé le modèle puis lancé
**Dicter avant toute lecture** : transcription dans le brouillon, envoi manuel
et réponse écrite ont fonctionné. La lecture vocale avait aussi fonctionné lors
d’un essai antérieur. Ces observations ne qualifient pas encore leur enchaînement.

L’erreur « No speech detected » reste à reproduire, notamment après TTS;
l’hypothèse d’une transition TTS → STT défaillante n’est pas confirmée. L’utilisateur
signale aussi que le contrôle **Lire les réponses** n’est plus visible ensuite;
la cause de cette disparition reste inconnue. Ce sont des points de fiabilité
ciblés, pas la preuve d’une panne générale du STT.

## Référence du build 13 et candidat build 14

Le parcours du build 13 est en demi-duplex :

```text
Dictée Apple locale fr-CA → brouillon modifiable → Envoyer manuellement
    → génération Gemma locale → réponse terminée → lecture Apple facultative
```

Le micro est fermé pendant la lecture. Recommencer une dictée coupe d’abord la
lecture. Il n’existe pas encore de fin de tour automatique, de détection vocale
d’interruption, d’AEC qualifié ou de synthèse des segments en cours de génération.
Les événements `onProgress` du LLM exposent déjà des instantanés textuels cumulés;
la lecture du build 13 attend la réponse complète terminée par EOS. Le candidat
build 14 ajoute une file TTS par génération et un découpage de ces instantanés;
la lecture avant EOS reste à confirmer acoustiquement sur iPhone.

Le projet cible **iOS 27.1**; le chargeur Gemma exige **iOS 27.2 à l’exécution**.
Ces contraintes figurent dans le projet Xcode, le Podfile et
`AssistCoreAI.load`. Les hypothèses iOS 17 et iPhone SE2 du dossier de recherche
ne décrivent donc pas la compatibilité de cette app. Une nouvelle cible doit
d’abord satisfaire le système, charger le modèle réel et passer les mesures.

Le [parcours local actuel](local-voice.md) détaille le fonctionnement et ses
limites; le [build EAS 13](https://expo.dev/accounts/ales27/projects/assist/builds/8a84b33f-6a07-4d0e-b1c9-2777594616cf)
a été livré sur TestFlight, avec les limites physiques décrites ci-dessus.

## Séquence de livraison

Chaque étape produit un parcours utilisable et un rapport sur iPhone physique.
Le parcours clavier et l’envoi manuel restent disponibles pendant cette progression.

**Candidat implémenté : build 14.** Indicateur et diagnostics micro agrégés,
session audio commune après accord micro, contrôle de lecture sur sa propre ligne
et lecture progressive avec une file TTS par génération.
Ce lot combine les travaux ciblés de l’étape 0, leur mesure à l’étape 1 et la
lecture progressive de l’étape 2. Le code et les tests sont prêts; la livraison et la
qualification audio sont suivies séparément. Fin de tour automatique et barge-in attendent les
portes de qualification physique suivantes.

### 0. Rendre la capture observable et qualifier les enchaînements

**Tranche : dicter une phrase, la voir, terminer, recommencer.**

- Conserver le domaine/code d’erreur Speech, le format et la route d’entrée,
  le nombre de buffers/frames reçus, le délai du premier buffer et un niveau
  sonore agrégé. Ne conserver ni PCM ni transcription dans les diagnostics.
- Distinguer absence de buffers, signal silencieux, absence de parole reconnue,
  indisponibilité des ressources et refus de permission. Un message convivial
  doit guider une nouvelle tentative sans masquer une capture défaillante.
- Afficher un état micro et un indicateur de niveau agrégé pendant la capture,
  avec des mises à jour bornées. L’interface doit permettre de distinguer une
  écoute demandée d’un signal effectivement reçu.
- Reproduire après lancement neuf, après TTS terminé et après TTS interrompu;
  commencer avec le micro intégré, puis qualifier les routes réellement visées.
- Reproduire le contrôle de lecture signalé absent après le premier échange.
  Son activation, son arrêt et une indisponibilité éventuelle doivent rester
  compréhensibles pendant les échanges suivants.
- Préserver les callbacks non isolés, l’append synchrone sur le tap et les gardes
  de génération. Aucun traitement lourd ni événement JavaScript par buffer.

**Passage à l’étape suivante :** conserver la réussite fr-CA après relance,
réussir les essais répétés après TTS, confirmer l’arrêt effectif du micro et
l’absence de résultats périmés. Un essai volontairement silencieux doit finir
proprement et permettre de repartir. Le contrôle de lecture reste utilisable
après plusieurs tours. Toute correction doit être confirmée sur appareil;
une compilation ou le banc de callbacks ne suffit pas.

### 1. Qualifier le parcours manuel et établir la référence

**Tranche : dix échanges dictés, corrigés si nécessaire, envoyés puis lus.**

Instrumenter capture, premier texte partiel, fin acoustique, texte stable,
départ de génération, premier texte LLM exploitable, demande TTS et premier son
audible. Mesurer séparément chargement à froid et tours avec modèles résidents.
L’essai couvre aussi le refus de permission, l’arrière-plan, le verrouillage,
l’interruption système, la route audio et les annulations successives.

**Passage :** flux complet reproductible hors réseau après préparation des
ressources, erreurs expliquées, aucune génération avant l’envoi manuel, aucune
lecture d’une réponse annulée. Publier les distributions et les échecs avant
d’ajouter de l’automatisme.

### 2. Parler avant la fin de la génération

**Tranche : une question envoyée manuellement reçoit une première phrase parlée
pendant que Gemma termine sa réponse.**

- Exploiter `onProgress` avec l’identité de requête; déterminer un préfixe stable
  avant de le rendre irréversible à l’oral. Les instantanés cumulés ne sont pas
  des segments prêts à lire : gérer suffixes modifiés et décodages incomplets.
- Découper aux petites unités prosodiques et à la ponctuation, avec une limite
  d’attente pour le premier segment. Ne pas envoyer chaque jeton au TTS.
- Créer une file/session de lecture par réponse, ordonnée et annulable. Le
  `speak()` actuel annule la lecture précédente : le rappeler pour chaque
  fragment ne constitue pas une implémentation de streaming.
- Borner la file et mesurer la concurrence LLM/TTS. Éviter répétitions, trous,
  fragments techniques lus à voix haute et attente d’une longue réponse entière.

**Passage :** premier son avant EOS sur une réponse longue, segments prononcés
une seule fois dans l’ordre et arrêt utilisateur immédiat. Une génération
interrompue après une phrase doit être présentée comme incomplète.

### 3. Ajouter un mode conversation avec fin de tour prudente

**Tranche : dans un mode explicitement activé, poser une question sans bouton
Envoyer; conserver un bouton pour terminer ou annuler.**

Combiner VAD, silence, stabilité de transcription et indices de phrase inachevée.
La durée de silence seule ne décide pas. Tester « euh… », « attends… », les
conjonctions, autocorrections et faux départs québécois. Une fenêtre de silence
plus courte pour une phrase complète et une attente plus longue pour une
hésitation sont des paramètres à calibrer avec le corpus.

Une décision de fin de tour ne doit pas envoyer du texte instable ou doubler un
tour. L’automatisme concerne la conversation; il ne donne aucune autorisation
supplémentaire pour exécuter des actions de l’agent. En cas de confiance faible,
garder le brouillon et permettre de terminer manuellement.

**Passage :** mesures de tours coupés trop tôt et d’attente excessive, avec des
locuteurs et enregistrements de validation distincts du corpus de calibration.
Le gain de latence doit rester compatible avec le respect des pauses.

### 4. Permettre l’interruption vocale avec annulation complète

**Tranche : l’agent parle; l’utilisateur dit « non, attends »; le son s’arrête
et la nouvelle intervention devient le tour suivant.**

Ouvrir une surveillance micro pendant le TTS seulement dans ce mode. Qualifier
un traitement d’écho, avec le graphe audio de traitement vocal Apple ou une
solution locale qui reçoit la référence audio effectivement jouée. Éviter de
cascader deux AEC sans mesure. Commencer par VAD/AEC pendant la lecture, sans
imposer un STT complet permanent. Un court prébuffer en RAM peut préserver le
début de l’interruption; sa durée et sa purge doivent être explicites.

L’interruption suit un invariant commun au natif et au JavaScript :

1. Invalider l’identité de l’ancienne réponse et couper sa sortie audible.
2. Purger les buffers et les segments TTS en attente, y compris ceux du lecteur.
3. Demander l’annulation coopérative de Gemma et du moteur TTS.
4. Rejeter tout événement ou tampon tardif portant l’ancienne identité.
5. Former le nouveau tour sans reprendre automatiquement l’ancienne phrase.

Mesurer le **silence audible**, séparément du retour de la méthode d’annulation.
Qualifier haut-parleur fort, bruit ambiant, voix distante et changements de route.
La voix de l’agent ne doit pas déclencher sa propre interruption.

**Passage :** pas de phrase ancienne rejouée, début de l’utilisateur conservé,
faible taux de fausses interruptions et reprise cohérente après annulations
répétées. Le plein duplex reste désactivé sur les profils non qualifiés.

### 5. Comparer les voix fr-CA avant d’intégrer un moteur plus lourd

**Tranche : écouter à l’aveugle les mêmes réponses, entières puis segmentées.**

Établir d’abord une référence avec les voix Apple fr-CA installées. Comparer
ensuite un prototype isolé de PocketTTS French 24L, avant de l’embarquer dans le
parcours principal. Son nom et sa langue ne prouvent ni l’accent québécois ni le
débit utilisable avec Gemma sur cet iPhone. Le
[dossier local](local-voice.md#pourquoi-pockettts-attend) consigne les premières
contraintes du pack français; les chiffres d’un petit pack anglais ou d’un Mac
ne servent pas de benchmark iPhone.

Évaluer accent perçu, intelligibilité, rythme, noms propres, montants,
alternance français/anglais, continuité entre segments et stabilité de la voix.
Une référence vocale québécoise exige un consentement documenté couvrant cet
usage et un traitement conforme à la licence du modèle; aucune transmission
d’échantillon n’est implicite. Mesurer taille téléchargée, stockage après
compilation, démarrage, TTFA, débit soutenu, mémoire et thermique avec le LLM.

**Passage :** amélioration auditive constatée par plusieurs Québécois, objectifs
de latence tenus et coexistence mémoire acceptable. Sinon, garder la voix Apple.
Les poids, versions, conditions d’usage et preuves sont épinglés avant intégration.

## Protocole et objectifs d’acceptation

Ces nombres sont des **objectifs initiaux à valider**, pas des résultats, des
garanties ou des estimations de performances actuelles. Les fixer par profil
d’appareil après la référence de l’étape 1. Un profil peut rester au parcours
manuel si ses mesures ne permettent pas les fonctions suivantes.

| Mesure | Objectif initial proposé | Définition et condition |
| --- | --- | --- |
| Premier texte STT | p50 ≤ 500 ms; p95 ≤ 1 000 ms | Début de parole → premier texte partiel non vide, modèle disponible |
| Finalisation STT manuelle | p50 ≤ 400 ms; p95 ≤ 800 ms | Commande Terminer → transcription stable, hors temps de parole |
| Fin de tour automatique | p50 ≤ 650 ms; p95 ≤ 1 100 ms | Vraie fin acoustique annotée → décision, hors pauses intentionnelles |
| Premier audio TTS | p50 ≤ 300 ms; p95 ≤ 600 ms | Segment textuel validé → premier son audible, moteur chaud |
| Réponse conversationnelle | p50 ≤ 1 200 ms; p95 ≤ 2 000 ms | Fin de parole → premier phonème utile, incluant EOT, STT, LLM et TTS |
| Interruption → silence | p50 ≤ 200 ms; p95 ≤ 300 ms | Début acoustique de l’interruption → arrêt audible de l’agent |
| Pauses respectées | ≤ 2 % de tours coupés trop tôt | Jeu indépendant avec hésitations et autocorrections annotées |
| Faux déclenchements | ≤ 1 par 30 min; zéro auto-déclenchement par le TTS | Scénario fixe de bruit, silences et lecture seule; rapporter le nombre d’essais |
| Lecture soutenue | Zéro underrun audible en 30 min | Mesurer aussi débit de génération et profondeur de file |
| Annulations | Zéro ancien segment/transcript réinjecté | Série de 100 interruptions et annulations avec identités distinctes |
| Hors réseau | Parcours complet après relance sans réseau | Tous les assets présents; aucune dépendance à Metro |
| Réseau disponible | Zéro tentative réseau attribuable au parcours vocal après provisionnement | Journaux contrôlés plus audit des dépendances; préciser les limites d’attribution |
| Thermique | Pas d’arrêt; dégradation p95 ≤ 25 % entre début et fin | 30 min, mêmes tours et conditions, état thermique consigné |
| Mémoire | Pas d’éviction; pas de croissance persistante après retour au repos | Pic et plateau mesurés avec STT/LLM/TTS concurrents; marge chiffrée par profil |
| Transcription fr-CA | WER ≤ 10 % au calme; ≤ 20 % en bruit modéré | Corpus indépendant, normalisation explicitée; compter séparément erreurs de noms, montants et heures |
| Français québécois | Naturalité et accent médians ≥ 4/5; intelligibilité ≥ 4/5 | Écoute aveugle, plusieurs évaluateurs québécois; rapporter dispersion et erreurs de noms |

Pour chaque appareil : 5 lancements froids, au moins 50 tours chauds et une
séance de 30 minutes. Utiliser un corpus fr-CA fixe de 100 à 200 phrases, puis
un jeu de validation distinct; inclure pièce calme, bruit et TTS actif. Garder
révision, build, modèle/quantification, iOS, route, voix, taille de corpus et taux
d’échecs avec p50/p95. L’absence de résultat ne disparaît pas du calcul : publier
le taux d’échec à côté des latences des essais réussis.

Le premier phonème doit être une réponse utile, sans remplissage artificiel
destiné à améliorer le chronomètre. Distinguer horodatage logiciel, audio mis en
file et son réellement audible. Les budgets mémoire et stockage exigent des
valeurs par appareil mesurées; aucun seuil universel de mémoire disponible ou
de terminaison iOS n’est supposé.

## Dépendances dans le dépôt

| Surface existante | Travail futur concerné |
| --- | --- |
| `mobile/ios/Assist/Voice/AssistVoice.swift` | Capture, diagnostics agrégés, session audio, file TTS et états de tour |
| `mobile/ios/Assist/Voice/AssistVoiceCallbacks.swift` | Adaptateurs Sendable, snapshot d’erreur enrichi, append audio synchrone |
| `mobile/ios/Assist/Inference/AssistCoreAI.swift` | Mesure du premier texte, instantanés stables et annulation Gemma |
| `mobile/ios/Assist/RCTNativeAssist.mm`, `mobile/specs/NativeAssist.ts` | Contrat natif/JS, identité des réponses et nouveaux événements bornés |
| `mobile/src/voice.ts`, `mobile/src/useLocalVoice.ts` | Validation des événements, état de conversation et rejet des sessions périmées |
| `mobile/App.tsx`, `mobile/src/VoiceControls.tsx` | Activation explicite du mode, brouillon, streaming et commandes d’arrêt |
| `mobile/ios/Assist/Info.plist`, projet Xcode, `mobile/ios/Podfile` | Permissions, inclusion des sources et minimum système réel |
| `scripts/check-voice-callbacks.*`, `scripts/test-local-voice-contract.py`, `mobile/__tests__/localVoice.test.tsx`, `mobile/__tests__/VoiceApp.test.tsx` | Contrats et régressions; compléter par les essais physiques, sans les leur substituer |

Choisir les capacités d’après des profils **mesurés**, pas seulement un nom de
puce : parcours manuel, conversation avec streaming, puis interruption vocale
et voix lourde si elles passent les portes correspondantes. Vérifier capacité
locale fr-CA, présence des assets, OS, stockage, mémoire et comportement thermique.
Les cibles de comparaison telles que l’iPhone 14 Pro ne deviennent supportées
qu’après qualification de la configuration exacte. Aucun engagement SE2 n’est
pris par cette feuille de route.

Le candidat build 14 améliore donc un parcours déjà réussi après relance :
micro observable, échanges successifs fiables et lecture progressive. Les
automatismes de conversation attendent ensuite leurs propres preuves et décisions
de capacité. Ce document n’autorise ni téléchargement de poids ni nouvelle
publication et ne bloque pas une correction ciblée de fiabilité.
