# Voix locale — mode vocal au premier plan

Le candidat **build 16** introduit un **Mode vocal** distinct de la conversation
au clavier : fin de tour automatique, envoi au modèle local, lecture progressive
et écoute du tour suivant. À la préparation de ce candidat, les contrôles
locaux passent; l’archive EAS, l’acceptation Apple et la qualification audio
sur iPhone sont des étapes séparées à vérifier.

Les builds 13 à 15 ont été livrés sur TestFlight. Ils utilisaient une dictée vers
un brouillon, un envoi manuel, puis une lecture facultative; les versions 14 et
15 ajoutaient la lecture progressive, les diagnostics et des états plus clairs.
Sur iPhone, une dictée après relance et avant lecture a été confirmée au build 13.
Un autre essai avait échoué avec « No speech detected ». La fiabilité de
l'enchaînement lecture → reconnaissance et celle des tours automatiques du
candidat 16 restent à qualifier sur appareil. Voir la
[feuille de route](voice-roadmap.md) pour les étapes suivantes.

## Parcours actuel

1. Après chargement du modèle, **Mode vocal** ouvre son propre écran et démarre
   l'écoute. Les autorisations microphone et reconnaissance vocale sont demandées
   si nécessaire; la reconnaissance locale `fr-CA` doit être disponible.
2. La transcription apparaît dans **Ton message**. Une heuristique locale observe
   sa stabilité et des mesures agrégées du micro pour proposer une fin de tour.
   L'app ferme ensuite l'entrée et attend le texte final natif ainsi que la fin
   de capture avant d'envoyer un message non vide au même moteur Gemma local.
3. La réponse apparaît progressivement. Si la lecture est activée, des phrases
   ou segments bornés rejoignent une file Apple TTS propre à cette génération;
   une première phrase peut être lue avant la fin du texte. Une erreur vocale ne
   supprime pas la réponse écrite et interrompt le parcours pour permettre une
   reprise explicite.
4. L'écoute suivante démarre après la fin de génération et la fin de lecture
   native. Si la lecture est désactivée, elle reprend après la réponse texte.
   Il faut toujours rester dans le mode vocal, au premier plan.

Cet écran n'a ni compositeur, ni bouton **Envoyer**, ni contrôle de dictée intégré
au chat. La conversation au clavier garde son envoi manuel et ne déclenche pas
la lecture automatique. Aucun brouillon clavier n'est envoyé par le mode vocal.
Les réponses partielles ou interrompues restent distinctes d'un tour terminé.

## Fin de tour et commandes

La politique actuelle utilise des délais de prototype, **pas un VAD neuronal ni
une compréhension sémantique de la fin de phrase** :

| Fin du texte reconnue | Pause initiale recherchée |
| --- | --- |
| Forme ordinaire | 900 ms |
| Hésitation reconnue, par exemple « euh », « attends » ou « dans le fond » | 1 800 ms |
| Mot suggérant une suite, par exemple « et », « pour » ou « pis » | 2 200 ms |
| Mesure micro absente, périmée ou inexploitable | Repli textuel d'au moins 2 200 ms |

Le texte doit être non vide et stable. Quand les mesures micro sont utilisables,
la politique attend aussi une période de faible niveau; le bruit peut retarder
la décision et une voix faible peut être manquée. Un niveau faible ne prouve
pas le silence. Sans texte après environ 15 secondes et sans activité récente,
le parcours affiche une erreur et demande de reprendre. iOS peut aussi fournir
un résultat final avant la décision heuristique. Ces seuils demandent une
qualification avec des pauses naturelles et des locuteurs québécois.

**Mettre en pause** arrête la capture, la lecture et la génération en cours.
L'état **Arrêt du mode vocal** reste affiché pendant la confirmation de l'arrêt;
**Reprendre** ouvre une nouvelle écoute après la pause ou une erreur.
**Interrompre**, offert pendant la préparation ou la lecture d'une réponse,
annule ce travail puis reprend l'écoute après son arrêt. **Fermer le mode vocal**
revient au chat après confirmation de l’arrêt. Un échec reste visible dans
le mode vocal. Ouvrir **Réglages du mode vocal** met la session en pause;
revenir à son écran ne la relance pas sans **Reprendre**.

Le parcours est **demi-duplex** : le microphone est fermé pendant la génération
et la lecture. **Interrompre est un bouton**, pas une interruption acoustique.
Parler pendant une réponse ne la coupe pas. Ce lot ne fournit ni barge-in vocal,
ni AEC qualifié, ni écoute continue en arrière-plan.

## Lecture et préférence locale

**Lire les réponses à voix haute** est activé par défaut dans **Réglages**. Le
choix est conservé sur l'appareil dans `UserDefaults`, sous la clé
`assist.voice.readResponses`. Le chargement du choix enregistré précède le
démarrage d'une session; une lecture tardive ne doit pas remplacer un choix
explicite. Si l'enregistrement échoue, le choix reste appliqué à la session et
un message indique l'échec de sauvegarde.

Le réglage reste utilisable même si aucune voix locale n'est disponible. Avec
la lecture activée, une voix `fr-CA` et les API de file TTS sont nécessaires au
démarrage du mode vocal; sinon l'app demande d'installer une voix adaptée ou de
désactiver la lecture. Désactiver la lecture abandonne la file courante. Ce
réglage ne rend pas vocal un envoi effectué au clavier.

## Capacités et confidentialité

La reconnaissance crée un `SFSpeechRecognizer` pour `fr-CA`, exige
`supportsOnDeviceRecognition`, puis fixe
`requiresOnDeviceRecognition = true` sur chaque requête. Si la capacité, la
disponibilité ou une permission manque, l'app explique l'indisponibilité et
conserve la conversation au clavier. Elle ne relance pas la reconnaissance sur
serveur et ne change pas silencieusement de langue. Apple documente que
[l'exigence locale](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition)
dépend de la
[capacité du recognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition).

La synthèse choisit une voix parmi les
[voix disponibles](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/speechvoices())
dont la locale est `fr-CA`, sans repli `fr-FR`. La présence d'une locale canadienne
ne garantit ni une voix particulière, ni un accent ou une naturalité évalués par
des Québécois. Aucun échantillon personnel ou clonage n'est requis par ce lot.

Les descriptions `NSMicrophoneUsageDescription` et
`NSSpeechRecognitionUsageDescription` expliquent les accès demandés. Consulter
les capacités n'ouvre pas de demande d'autorisation. Les API système peuvent
dépendre de ressources installées par iOS; leur présence doit être vérifiée dans
les conditions de qualification. L'absence de repli cloud dans ce parcours ne
constitue pas une observation du trafic réseau.

Pendant l'écoute, l'indicateur montre le signal agrégé reçu, sans prétendre
qu'il s'agit de parole. Les diagnostics locaux exposent nombres de buffers et
frames, format, type de route, délai du premier buffer, niveau et domaine/code
d'erreur. Ces diagnostics n'enregistrent ni audio ni transcription. Le tap
transmet les buffers à Speech de façon synchrone; une tâche séparée publie les
agrégats au plus cinq fois par seconde.

Les anciennes cibles de recherche ne déclarent pas la compatibilité du produit :
l'app cible actuellement iOS **27.1**, et son chargeur Gemma exige iOS **27.2** à
l'exécution. Ce lot ne revendique pas la prise en charge de l'iPhone SE2. Les
prérequis du modèle restent dans [la procédure iOS](ios-build.md), et ses limites
dans [l'état de vérification](verification.md).

## Annulation et cycle de vie

Chaque capture et chaque réponse possède une identité. Annuler invalide les
callbacks, segments et commandes différées de la session; une ancienne
transcription ou phrase ne doit pas réapparaître. L'arrêt audio précède l'attente
de l'annulation coopérative de Gemma. Une reprise attend cet arrêt avant d'ouvrir
une nouvelle capture. La finalisation native de reconnaissance possède une
attente bornée, pour ne pas rester indéfiniment dans cet état.

Le passage en arrière-plan, une interruption audio ou un changement effectif de
route arrêtent l'opération vocale. Une désactivation temporaire causée par les
premières demandes d'autorisation peut terminer son parcours d'accord; le micro
n'est ouvert qu'une fois l'app active. Un véritable passage en arrière-plan
invalide cette demande. Le retour au premier plan ne reprend automatiquement ni
microphone ni ancienne phrase. Fermer l'écran, quitter vers Réglages ou démonter
le module annule également le travail vocal.

Ces garanties de code demandent des essais natifs : les tests JavaScript ne
prouvent pas la libération effective du microphone, l'arrêt audible ou la
transition correcte entre routes.

## Validation du candidat 16

Le contrôle local complet est terminé :

- `cd mobile && npm run check` : typecheck TypeScript, ESLint sans avertissement,
  **461 tests JavaScript dans 22 suites** et génération du bridge iOS réussis.
- `python3 scripts/test-local-voice-contract.py` : **8 contrôles statiques**
  réussis pour les permissions, sources Xcode, contrat du bridge et exigences
  locales.
- Les quatre sources vocales passent un typecheck Swift 6 strict arm64 iOS avec
  le SDK 26.2. Ce contrôle ne remplace pas une archive avec le SDK 27.1.

Ces résultats ont été enregistrés avant l’archive EAS avec SDK 27.1. Ils ne
constituent pas une preuve d’IPA, d’acceptation Apple ou de livraison TestFlight.

Une revue **web simulée** de l'écran réel couvre **144 cas** : largeurs
320/375/430, hauteurs 568/750, trois thèmes et huit états. Aucun débordement
horizontal ni bouton hors écran n'a été observé. Les callbacks simulés de pause,
reprise, interruption, fermeture et Réglages répondent; le texte long défile avec
les commandes accessibles hors de la zone de défilement. Un essai de texte web
agrandi à 1,5 fois passe aussi. Les fixtures portaient « APERÇU SIMULÉ · aucun
micro actif » et ont été retirées après le contrôle.

Ce banc ne prouve ni l'audio sur iPhone, ni VoiceOver natif, ni Dynamic Type,
ni la latence. Aucun résultat acoustique, qualification d'accent ou capture
réseau n'est déduit des contrôles logiciels ou de l'aperçu.

## Qualification physique à exécuter

Consigner révision Git, build, iOS, modèle d'iPhone, locale du recognizer,
identifiant de voix et permissions. Utiliser un build Release avec JavaScript
embarqué et un modèle Gemma déjà transféré; Metro ne doit pas être nécessaire.
Ne pas effacer de données utilisateur pour préparer les essais.

| Série | Vérification et preuve attendue |
| --- | --- |
| Autorisations | Premier accord, refus, accès révoqué puis retour; aucun micro après échec ou annulation, aucune ouverture pendant l'arrière-plan |
| Capacités | Reconnaissance locale absente ou voix `fr-CA` manquante : erreur explicite, Réglages utilisables, aucune bascule distante |
| Tours automatiques | Ouvrir Mode vocal, parler, attendre : un seul envoi après texte final et capture arrêtée; réponse progressive; écoute suivante après la fin du TTS, ou après le texte si lecture désactivée |
| Hésitations | Pauses, « euh », autocorrections et phrases incomplètes : relever coupures prématurées, attentes excessives et faux tours dans le bruit |
| Séparation clavier | Brouillon clavier conservé, aucun envoi ou TTS déclenché par ce brouillon; aucun compositeur dans Mode vocal |
| Préférence | Valeur par défaut activée, désactivation conservée après relance; échec de sauvegarde signalé; absence de voix n'empêchant pas de désactiver la lecture |
| Annulations | Pause ou Interrompre pendant génération et lecture; fermeture, retour Réglages et nouvelle session : aucune ancienne transcription, génération ou phrase ne reprend |
| Cycle de vie | Arrière-plan, verrouillage, interruption système et changement de route à chaque phase; absence de reprise automatique; reprise explicite possible |
| Français québécois | Hésitations, noms locaux, montants et alternance français/anglais; transcription et qualité vocale évaluées séparément |
| Hors réseau | Ressources installées, app terminée, mode Avion avec Wi-Fi/cellulaire désactivés; parcours complet après relance et redémarrage du téléphone |
| Réseau disponible | Journaux DNS et connexions sortantes pendant 15 minutes; relever les tentatives attribuables à l'app, pas seulement les connexions réussies |
| Stabilité | Session de 30 minutes, tours courts/longs, arrêts et reprises; mémoire, thermique, erreurs, faux déclenchements et coupures avec outil et fréquence de mesure |

Le mode Avion établit le fonctionnement sans réseau. Un réseau disponible
contrôlé cherche les tentatives de communication; préciser les limites
d'attribution des journaux du routeur et examiner aussi les dépendances et
chemins réseau de l'app. Distinguer un asset déjà installé d'un téléchargement
pendant l'essai.

Mesurer séparément parole → texte partiel, fin de parole → décision de fin de
tour, fin de capture → texte stable, premier segment Gemma → premier son,
fin de parole → premier son et commande d'arrêt → silence. Conserver p50/p95 et
les échecs sur plusieurs essais. Sans instrumentation, noter **non mesuré**.
Les seuils de fin de tour ci-dessus sont des réglages, pas des latences mesurées
sur iPhone.

## Pourquoi PocketTTS attend

PocketTTS French 24L reste un candidat pour une étape ultérieure : il offre une
session audio incrémentale, mais ni son accent québécois ni sa coexistence
mémoire avec Gemma ne sont qualifiés pour cette app.

À la révision de modèles
[`91748676`](https://huggingface.co/FluidInference/pocket-tts-coreml/tree/91748676fe3c8b2eb3007b3125253bcd898202c3/v2.1/french_24l),
la somme des tailles déclarées par l'API Hugging Face pour les fichiers français
sélectionnés par le
[downloader FluidAudio épinglé](https://github.com/FluidInference/FluidAudio/blob/2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042/Sources/FluidAudio/TTS/PocketTTS/Assets/PocketTtsResourceDownloader.swift#L138-L172)
et ses
[modèles requis](https://github.com/FluidInference/FluidAudio/blob/2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042/Sources/FluidAudio/ModelNames.swift#L1231-L1269)
donne environ **1,94 Go en fp16** ou **1,63 Go en int8**, avec les 26 voix
fournies. Il s'agit d'un calcul de taille brute de fichiers, sans téléchargement
des poids ni mesure de mémoire. Une distribution avec moins de voix pourrait
réduire ce total; l'encodeur de clonage optionnel et les caches ajoutent d'autres
ressources. Les chiffres du petit pack anglais ne décrivent pas ce pack français.

Son
[annulation de session](https://github.com/FluidInference/FluidAudio/blob/2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042/Sources/FluidAudio/TTS/PocketTTS/Pipeline/PocketTtsSession.swift#L34-L42)
attend la fin de la tâche de génération; elle ne mesure pas l'arrêt audible d'un
lecteur externe. Une intégration future devra qualifier stockage, mémoire avec
Gemma, écoute fr-CA, file audio et annulation sur l'iPhone réellement supporté
avant de remplacer le premier parcours Apple.
