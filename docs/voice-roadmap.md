# Vers une conversation vocale locale fluide

L’objectif est de réduire les attentes, respecter les hésitations et permettre
une interruption naturelle, tout en gardant STT, LLM et TTS sur l’iPhone. Les
expériences vocales de ChatGPT et Gemini servent de références perceptuelles;
ce plan ne promet ni leur qualité ni leur fluidité sur le matériel local.

**Référence actuelle : build 16, confirmé fonctionnel par l’utilisateur sur son
iPhone.** Son mode vocal distinct enchaîne écoute, fin de tour automatique,
envoi local, lecture progressive et tour suivant. Ce retour valide le parcours
de l’étape 3 comme base de travail; il ne constitue pas une qualification
formelle des latences, de l’accent, des permissions ou de toutes les routes.

**Build 17 livré : interruption vocale pendant la lecture.** Le code maintient
un STT Apple local avec AEC Apple VPIO pendant le TTS, puis promeut la même tâche
de reconnaissance lorsque l’utilisateur intervient. Après livraison TestFlight,
un essai utilisateur a affiché une interruption audio avant la première
transcription; sa raison native exacte reste inconnue.

**Build 18 livré : fiabilité des reconfigurations audio.** L’essai physique
suivant échoue au contrôle strict du graphe après démarrage, avant transcription.

**Candidat actuel : build 19, format client commun au micro et à la sortie.**
La liaison mixeur → sortie devient explicite et partage le format du tap micro.
Les diagnostics nomment les conditions refusées. Le contrôle strict et VPIO
restent actifs; la qualification physique de l’interruption vocale reste ouverte.

## Référence produit et limites

Les builds 13 à 15 formaient la progression depuis une dictée dans un brouillon
avec envoi manuel vers une lecture progressive et des états plus clairs. Le
build 13 avait un essai positif de dictée après relance et avant TTS; un autre
essai avait produit « No speech detected ». Le build 16 apporte le mode vocal
confirmé par l’utilisateur. Ces observations ne deviennent pas des mesures
homogènes de fiabilité pour le nouveau candidat.

Le projet cible **iOS 27.1**; le chargeur Gemma exige **iOS 27.2 à l’exécution**.
Ces contraintes figurent dans le projet Xcode, le Podfile et
`AssistCoreAI.load`. Les hypothèses iOS 17 et iPhone SE2 du dossier de recherche
ne décrivent donc pas la compatibilité de cette app. Une nouvelle cible doit
d’abord satisfaire le système, charger le modèle réel et passer les mesures.

Le [parcours local actuel](local-voice.md) détaille le fonctionnement, les preuves
et les limites. Aucune parité avec les expériences vocales de ChatGPT ou Gemini
n’est revendiquée pour l’app locale.

## Séquence de livraison

Le parcours clavier et l’envoi manuel restent disponibles. Les étapes 0 à 2
expliquent les fondations de la référence actuelle; leurs objectifs de mesure
restent ouverts lorsqu’aucun résultat physique n’est consigné. L’étape 3 possède
le retour positif du build 16. L’étape 4 est livrée au build 17; le candidat 18
traite la régression de route observée avant sa qualification sur appareil.

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

**Tranche de référence initiale : dix échanges dictés, corrigés si nécessaire,
envoyés puis lus.** Ce parcours manuel décrivait les builds 13 à 15; le build 16
réserve la dictée au mode vocal. Le chat clavier conserve son envoi manuel.

Instrumenter capture, premier texte partiel, fin acoustique, texte stable,
départ de génération, premier texte LLM exploitable, demande TTS et premier son
audible. Mesurer séparément chargement à froid et tours avec modèles résidents.
L’essai couvre aussi le refus de permission, l’arrière-plan, le verrouillage,
l’interruption système, la route audio et les annulations successives.

**Mesures à conserver :** flux complet reproductible hors réseau après
préparation des ressources, erreurs expliquées, aucune génération avant l’envoi
manuel dans le chat, aucune lecture d’une réponse annulée. Consigner les
distributions et les échecs pour comparer les automatismes suivants.

### 2. Parler avant la fin de la génération

**Tranche : une question du mode vocal reçoit une première phrase parlée pendant
que Gemma termine sa réponse.** La lecture automatique reste propre au mode
vocal; un envoi au clavier ne la déclenche pas.

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
Envoyer; conserver des commandes de pause, reprise et interruption.**

**Référence build 16 confirmée par l’utilisateur.** Le chat clavier reste manuel
et son brouillon est séparé. La lecture automatique est activée par défaut,
avec une préférence locale dans Réglages. Le prochain tour attend la fin du
modèle et de la lecture effective; aucune reprise automatique ne suit une
pause, un refus de permission, une erreur ou le retour d’arrière-plan.

La politique actuelle combine niveau agrégé du micro, stabilité de transcription
et indices de phrase inachevée. Ce n’est ni un VAD neuronal ni une compréhension
sémantique. La durée de silence seule ne décide pas. Tester « euh… », « attends… », les
conjonctions, autocorrections et faux départs québécois. Une fenêtre de silence
plus courte pour une phrase complète et une attente plus longue pour une
hésitation sont des paramètres à calibrer avec le corpus.

Une décision de fin de tour ne doit pas envoyer du texte instable ou doubler un
tour. L’automatisme concerne la conversation; il ne donne aucune autorisation
supplémentaire pour exécuter des actions de l’agent. En cas d’échec ou d’absence
de parole, arrêter le parcours et demander une reprise explicite.

**Passage :** mesures de tours coupés trop tôt et d’attente excessive, avec des
locuteurs et enregistrements de validation distincts du corpus de calibration.
Le gain de latence doit rester compatible avec le respect des pauses.

### 4. Permettre l’interruption vocale avec annulation complète

**Tranche : l’agent parle; l’utilisateur dit « non, attends »; le son s’arrête
et la nouvelle intervention devient le tour suivant.**

**Livrée au build 17, qualification acoustique encore ouverte.** Le
choix de cette tranche est un STT local actif pendant la lecture, avec le
traitement d’écho Apple VPIO et `.voiceChat`. Le TTS est produit par
`AVSpeechSynthesizer.write` et joué par `AVAudioPlayerNode` dans le même graphe.
Un texte STT contenant lettres ou chiffres déclenche la promotion; le niveau
sonore seul ne la déclenche pas. Le coût du STT pendant le TTS est plus élevé
que celui du demi-duplex et doit être mesuré avec Gemma.

La promotion conserve la même requête, la même tâche STT et leur début déjà
reçu, sans seconde capture ni prébuffer PCM d’entrée séparé. Après une fin
naturelle de lecture, cette entrée peut être retenue **5 secondes au maximum**
pour être adoptée par le prochain tour. Pause, fermeture, arrière-plan et
invalidation détruisent la rétention immédiatement; aucun délai de 5 secondes
n’est attendu dans ces chemins.

L’interruption suit un invariant commun au natif et au JavaScript :

1. Invalider l’identité de l’ancienne réponse et couper sa sortie audible.
2. Purger les buffers et les segments TTS en attente, y compris ceux du lecteur.
3. Adopter la capture native, retirer la file JS et demander l’annulation
   coopérative de Gemma sans `cancelVoice()` sur la nouvelle capture.
4. Rejeter tout événement ou tampon tardif portant l’ancienne identité.
5. Former le nouveau tour sans reprendre automatiquement l’ancienne phrase.

La nouvelle transcription est acceptée pendant l’arrêt du modèle précédent;
son envoi attend aussi la fin de cet arrêt et de la génération précédente.
L’intention utilisateur reste dans le contexte, avec coalescence des rôles
utilisateur successifs compatible avec Gemma. Les retours de commandes anciens
ne peuvent ni réarmer la lecture ni annuler la nouvelle capture. L’écran affiche
**Réponse interrompue** et n’affiche **Micro actif pendant la réponse** que si le
statut natif `speaking` contient `monitoring: true`.

Les plafonds actuels de sortie sont **15 secondes de PCM à 48 kHz**, **4 Mio et
2 048 paquets** pour le transfert, puis **64 segments et 32 Kio** pour le texte.
Ce sont des limites de protection du code, sans preuve de mémoire totale ni de
latence sur appareil; leur saturation fait partie de la qualification.

Mesurer le **silence audible**, séparément du retour de la méthode d’annulation.
Qualifier haut-parleur fort, bruit ambiant, voix distante et changements de route.
La voix de l’agent ne doit pas déclencher sa propre interruption.

**Passage :** pas de phrase ancienne rejouée, début de l’utilisateur conservé,
faible taux de fausses interruptions et reprise cohérente après annulations
répétées. AEC, faux déclenchements, premier mot conservé, latence d’arrêt et coût
thermique ne sont pas encore prouvés sur iPhone; le candidat ne constitue pas
une qualification de plein duplex conversationnel.

**Preuves logicielles actuelles :** `npm run check` passe avec **508 tests
JavaScript dans 22 suites**, TypeScript, ESLint et codegen; les **8 contrôles
statiques** du contrat local passent. Les six sources Swift passent le typecheck
strict SDK26.2; les bancs natifs synthétiques passent (duplex10, mesure8, file9,
callbacks9+128frames et2pièges d’isolation attendus). L’archive SDK27.1 reste
une vérification séparée à cette étape. Aucun résultat acoustique, IPA ou statut de livraison n’en
est déduit.

### 5. Comparer les voix fr-CA avant d’intégrer un moteur plus lourd

**Tranche : écouter à l’aveugle les mêmes réponses, entières puis segmentées.**

Le [comparatif Apple dans Réglages](voice-comparison.md) prépare cette référence :
voix disponibles `fr-CA`, noms masqués, cinq phrases fixes et leurs segments,
notes d’écoute partageables, puis choix local persistant pour les prochaines
réponses. Il n’ouvre pas le microphone. Son implémentation ne constitue pas
encore un résultat auditif ni une qualification hors réseau sur appareil.

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
| `mobile/ios/Assist/Voice/AssistVoiceCallbacks.swift`, `AssistVoiceDuplexState.swift`, `AssistVoicePCMTransfer.swift` | Callbacks Sendable, identités entrée/sortie, transfert PCM borné et fin effective de lecture |
| `mobile/ios/Assist/Inference/AssistCoreAI.swift` | Mesure du premier texte, instantanés stables et annulation Gemma |
| `mobile/ios/Assist/RCTNativeAssist.mm`, `mobile/specs/NativeAssist.ts` | Contrat natif/JS, identité des réponses et nouveaux événements bornés |
| `mobile/src/voice.ts`, `mobile/src/useLocalVoice.ts` | Validation des événements, état de conversation et rejet des sessions périmées |
| `mobile/App.tsx`, `mobile/src/VoiceConversationController.ts`, `mobile/src/VoiceConversationScreen.tsx` | Mode explicite, transfert de capture, annulation du modèle, brouillon séparé et commandes d’arrêt |
| `mobile/ios/Assist/Info.plist`, projet Xcode, `mobile/ios/Podfile` | Permissions, inclusion des sources et minimum système réel |
| `scripts/check-voice-callbacks.*`, `scripts/check-voice-duplex.*`, `scripts/test-local-voice-contract.py`, `mobile/__tests__/localVoice.test.tsx`, `mobile/__tests__/VoiceApp.test.tsx` | Contrats et régressions; bancs natifs synthétiques, puis essais physiques, sans les leur substituer |

Choisir les capacités d’après des profils **mesurés**, pas seulement un nom de
puce : parcours manuel, conversation avec streaming, puis interruption vocale
et voix lourde si elles passent les portes correspondantes. Vérifier capacité
locale fr-CA, présence des assets, OS, stockage, mémoire et comportement thermique.
Les cibles de comparaison telles que l’iPhone 14 Pro ne deviennent supportées
qu’après qualification de la configuration exacte. Aucun engagement SE2 n’est
pris par cette feuille de route.

Le build 16 constitue la référence fonctionnelle rapportée par l’utilisateur.
Le build 17 ajoute l’interruption vocale; le candidat 18 corrige sa gestion des
routes audio. La qualification physique reste distincte des contrôles logiciels,
de l’archive et de la livraison TestFlight. Aucun téléchargement de
poids ou remplacement des voix Apple n’est impliqué par cette étape.
