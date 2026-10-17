# Voix locale — mode vocal au premier plan

Le **build 16** introduit un **Mode vocal** distinct de la conversation
au clavier : fin de tour automatique, envoi au modèle local, lecture progressive
et écoute du tour suivant. **L’utilisateur confirme que ce parcours fonctionne
sur son iPhone.** Ce retour valide une référence utilisable pour l’étape 3 de la
[feuille de route](voice-roadmap.md); il ne remplace pas une qualification
formelle des latences, des routes audio ou des erreurs.

Le **build 17**, livré dans TestFlight interne, ajoute l’interruption par la
voix pendant la lecture. Un essai utilisateur affiche toutefois une interruption
audio avant la première transcription. Le message regroupe plusieurs causes :
la raison exacte reçue sur cet iPhone n’est pas encore établie.

Le **build 18**, livré sur TestFlight interne, corrige les reconfigurations de
route et l’état d’erreur. L’essai utilisateur suivant échoue au contrôle du graphe
après `engine.start()`, avant la première transcription : « Le graphe audio avec
annulation d’écho est inutilisable ». La capture ne révèle pas le prédicat fautif.

Le **candidat build 19** configure explicitement la liaison mixeur → sortie au
même format client que le micro et son tap, avec les vérifications strictes
après démarrage. Les détails audio nomment la cause du refus et montrent aussi
les formats complets du tap et du lecteur. L’archive, la livraison et les essais
physiques de ce candidat restent à confirmer. Aucune parité avec ChatGPT n’est
revendiquée.

Les builds 13 à 15 ont été livrés sur TestFlight. Ils utilisaient une dictée vers
un brouillon, un envoi manuel, puis une lecture facultative; les versions 14 et
15 ajoutaient la lecture progressive, les diagnostics et des états plus clairs.
Sur iPhone, une dictée après relance et avant lecture a été confirmée au build 13.
Un autre essai avait échoué avec « No speech detected ». Le retour positif du
build 16 ne mesure pas encore la fiabilité de toutes les transitions, ni
l’interruption vocale introduite par le candidat 17.

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
4. Hors interruption, le tour suivant attend la fin de génération et la fin de
   lecture native. Le candidat 17 peut réutiliser une reconnaissance locale
   conservée brièvement à la fin de la lecture. Si la lecture est désactivée,
   l’écoute reprend après la réponse texte. Il faut toujours rester dans le
   mode vocal, au premier plan.

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

Le build 16 était **demi-duplex**, avec le bouton **Interrompre** pour reprendre
la parole. Le candidat 17 conserve ce bouton et ajoute le parcours ci-dessous.
Il ne fournit aucune écoute continue en arrière-plan.

## Interruption vocale depuis le build 17

Pendant la lecture, le candidat maintient une reconnaissance Apple **locale**
avec le traitement vocal Apple VPIO activé dans un graphe `.voiceChat`.
`AVSpeechSynthesizer.write` fournit du PCM à un `AVAudioPlayerNode` du même
graphe. Ce chemin donne au traitement d’écho le signal effectivement joué;
son efficacité acoustique et ses limites restent à mesurer sur iPhone.

Le déclenchement repose sur du texte reconnu contenant des lettres ou des
chiffres, pas sur le seul niveau sonore. Quand cette reconnaissance détecte une
intervention, le natif coupe et purge la lecture, invalide ses anciennes
identités et **promeut la même requête et la même tâche STT** en nouvelle capture.
Le début déjà reçu reste dans ce STT; aucun redémarrage de dictée ni prébuffer
PCM d’entrée séparé n’est nécessaire au transfert.

Le natif publie ensuite l’événement de transfert :

```json
{
  "kind": "interruption",
  "sessionId": "ancienne-reponse",
  "captureSessionId": "nouvelle-capture",
  "phase": "listening",
  "monitoring": false
}
```

Le hook adopte la nouvelle identité avant ses premières transcriptions. Le
coordinateur retire immédiatement l’ancienne file JavaScript et demande
l’annulation coopérative de Gemma, **sans `cancelVoice()` ni seconde capture**.
La nouvelle transcription peut avancer pendant cette attente; son envoi attend
à la fois son texte final, sa fin de capture et le règlement de l’ancienne
génération et de son annulation. Les anciens segments, événements et retours
de commandes sont rejetés. L’intention utilisateur interrompue est conservée;
une correction peut la compléter sans créer deux rôles utilisateur consécutifs
dans le contexte Gemma. L’écran marque **Réponse interrompue** et retire
l’ancien partiel du flux de conversation en cours.

**Micro actif pendant la réponse** n’apparaît que lorsque le statut natif
`speaking` porte `monitoring: true` : moteur, entrée traitée et tâche STT sont
effectivement actifs selon le code. Une demande de surveillance seule, un
réarmement, un arrêt ou un ancien retour de commande ne suffisent pas à afficher
cet état. Les mesures du watcher ne décident pas la fin d’un tour utilisateur.

Après la fin naturelle de la lecture, le natif peut retenir cette entrée/STT
**au maximum 5 secondes**, afin que le prochain tour adopte une parole commencée
près du dernier son. Cette rétention est détruite si elle n’est pas adoptée;
pause, fermeture, arrière-plan ou invalidation la détruisent immédiatement,
sans attendre ce délai. La fin de production PCM et la fin effective de lecture
des buffers sont suivies séparément.

Les files de sortie sont bornées dans le code : au plus **15 secondes de frames
PCM à 48 kHz**, transfert limité à **4 Mio et 2 048 paquets**, et file textuelle
limitée à **64 segments et 32 Kio**. Ce sont des plafonds de protection, pas des
mesures de mémoire totale ou de latence; leur comportement à saturation reste
à qualifier.

Exécuter le STT pendant le TTS coûte davantage que le parcours demi-duplex.
L’impact CPU/ANE, mémoire, batterie et thermique, l’efficacité AEC, les fausses
interruptions dues à l’écho ou au bruit, la conservation acoustique du premier
mot et le délai jusqu’au silence ne sont **pas encore prouvés sur appareil**.

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

Le candidat 18 compare les identités des entrées/sorties en mémoire et vérifie
le moteur, le traitement vocal et les formats du graphe. Une reconfiguration
interne compatible ne devient plus automatiquement une interruption. Une perte
de périphérique, un changement effectif, une entrée absente, un moteur inutilisable
ou une interruption système continuent d’arrêter la session. Une reconfiguration
acceptée doit aussi être suivie de nouveaux buffers micro; le silence reste valide.
Aucune fenêtre de démarrage n’ignore toutes les notifications. L’arrêt retire
la propriété de la session avant les appels au lecteur, au moteur et à sa
désactivation; leurs notifications synchrones ne peuvent relancer l’arrêt.

En cas d’erreur, **Détails audio** permet de consulter un historique local borné
à huit lignes de 400 caractères : raison de notification, phase, types de ports,
état du moteur/traitement vocal, formats et décision. Les identités de ports
restent privées en mémoire; aucun UID, nom d’accessoire, texte dicté ou audio
n’est exposé. L’historique survit à l’arrêt et est renouvelé pour une nouvelle
session. Il n’est pas envoyé à un service.

Une erreur reste **Mode vocal interrompu** après un passage inactif/arrière-plan;
le retour n’ouvre pas le micro. **Reprendre** attend l’arrêt en cours avant une
nouvelle capture. Les fermetures et Réglages continuent d’attendre cet arrêt.

Ces garanties de code demandent des essais natifs : les tests JavaScript ne
prouvent pas la libération effective du microphone, l’arrêt audible ou la
transition correcte entre routes.

## Formats du graphe — candidat 19

Le chemin18 ne configurait explicitement que lecteur → mixeur en48kHz mono.
La liaison mixeur → sortie restait automatique. Apple précise que cette liaison
peut suivre le format de sortie au démarrage, tandis que VPIO exige le même
format client entre la sortie du nœud micro et l’entrée du nœud de sortie.
Le format du tap18 était relevé avant le démarrage, puis comparé après.

Le candidat19 configure les deux côtés avec le même format client avant le tap
et avant `prepare/start`. Le lecteur conserve son format canonique48kHz mono;
le mixeur assure la conversion vers le format client choisi. Le contrôle du
graphe reste strict, y compris l’égalité des formats I/O de VPIO. Le réarmement
STT ne reconfigure pas un graphe en cours de lecture.

Les diagnostics indiquent les prédicats refusés et les formats `in/tap/out/player`
avec fréquence, canaux, type PCM et entrelacement. Ils restent bornés à8lignes
et400caractères par ligne, sans identifiants ni noms de périphériques.

Sources primaires : [exemple Apple de traitement vocal](https://developer.apple.com/documentation/avfaudio/using-voice-processing),
[liaison du mixeur principal](https://developer.apple.com/documentation/avfaudio/avaudioengine/mainmixernode),
[formats client/matériel de sortie](https://developer.apple.com/documentation/avfaudio/avaudiooutputnode).
Le câblage est corrigé à partir de ces contrats; le prédicat réellement refusé
sur l’iPhone du signalement18 reste à confirmer avec les détails audio.

## Vérification du candidat 19 avant archive

`npm run check` passe :522tests/22suites, TypeScript, ESLint et codegen.
Les8contrôles statiques du contrat local et les2contrôles de démarrage passent.
Six sources Swift6 strict arm64-iOS27.1 passent sur SDK26.2; le projet19 passe
`plutil`. Le banc duplex passe24contrôles au premier essai, dont deux moteurs
réels en rendu manuel hors ligne vérifiant le helper de câblage partagé et la
conversion du lecteur48kHz mono vers des formats client44,1/48kHz mono.
Le cas implicite stéréo/client mono est constaté avant la connexion explicite;
la connexion corrigée et le signal converti sont vérifiés après.

Le banc n’active ni microphone ni sortie matérielle ni VPIO réel, reconnaissance
ou synthèse réelle. Les autres suites natives inchangées seront rejouées dans
le pré-install EAS. Archive, acceptation Apple et essai iPhone restent des
étapes distinctes. La cause exacte du signalement18 reste inconnue sans ses
Détails audio; aucune disparition du problème sur appareil n’est encore prouvée.

## Validation du candidat 18 avant archive

- `npm run check` : **522 tests JavaScript dans 22 suites**, TypeScript,
  ESLint sans avertissement et génération du bridge réussis.
- Contrat local : **8 contrôles statiques**; démarrage iOS : **2 contrôles**.
- Les six sources Swift passent le typecheck Swift6 strict arm64-iOS27.1 sur
  SDK26.2. Le projet Xcode porte le numéro 18 et passe `plutil`.
- Bancs natifs synthétiques : duplex **19**, mesure **8**, file **9**, callbacks
  **9** avec 128 frames et deux pièges d’isolation attendus. Le premier contrôle
  négatif Intel VM a terminé comme attendu mais sa backtrace était insuffisamment
  symbolisée; une relance unique a passé le matcher strict.
- La revue croisée couvre la catégorie propre à l’activation, les notifications
  retardées, les UID différents malgré le même type de port, les formats et le
  moteur invalides, les compteurs PCM entre deux reconfigurations, l’annulation
  et les détails d’erreur reçus dans un ordre différent sur le bridge.

L’archive SDK27.1, l’acceptation Apple et la livraison TestFlight sont des étapes
séparées, encore à confirmer à la préparation de cette révision. Aucun moteur,
micro, STT ou TTS réel n’est démarré par ces bancs synthétiques. La raison exacte
sur l’iPhone du signalement initial et le comportement acoustique restent à
valider sur l’appareil.

## Référence de validation du build 17

Le contrôle local complet est terminé :

- `cd mobile && npm run check` : typecheck TypeScript, ESLint sans avertissement,
  **508 tests JavaScript dans 22 suites** et génération du bridge iOS réussis.
- `python3 scripts/test-local-voice-contract.py` : **8 contrôles statiques**
  réussis pour les permissions, sources Xcode, contrat du bridge et exigences
  locales.

Les six sources Swift passent le typecheck Swift6 strict arm64-iOS27.1 sur
SDK26.2. Les scripts natifs synthétiques passent : duplex10, mesurePCM8,
fileTTS9, callbacks9 avec128frames ordonnées et2contrôles négatifs attendus.
Le premier essai négatif sur VM a produit la terminaison attendue avec une
backtrace insuffisamment symbolisée; une relance unique a passé le contrôle
strict. Ces résultats précèdent l’archive SDK27.1, l’acceptation Apple et la
livraison TestFlight; ils ne constituent pas ces preuves. Les tests JavaScript utilisent des frontières natives
simulées; ils vérifient les identités, ordres, annulations et états, pas l’audio.

Une revue **web simulée du build 16** couvrait **144 cas** : largeurs
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
| Interruption vocale | Dire « non, attends » pendant un TTS : son coupé, premier mot conservé, un seul nouveau tour, ancienne file purgée; tester avant et après EOS et pendant les retours de commandes différés |
| Écho et fausses interruptions | TTS seul à plusieurs volumes, bruit et voix distante : compter les déclenchements; vérifier le statut réel de surveillance et l’absence d’auto-interruption par le haut-parleur |
| Fin naturelle | Commencer à parler près du dernier son : adoption du même STT, aucun premier mot perdu ni capture doublée; sans adoption, entrée libérée au terme du délai borné |
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

Le [comparatif des voix Apple fr-CA](voice-comparison.md) prépare la référence
auditive avant ce prototype lourd : phrases identiques entières et segmentées,
noms masqués, critères d’écoute et choix persistant pour le mode vocal. L’aperçu
reste une lecture seule, avec un arrêt ciblé, sans capture micro.

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
