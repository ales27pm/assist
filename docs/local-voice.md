# Voix locale — parcours iOS et lecture progressive

Le build 13 a été archivé et livré sur TestFlight. Sur iPhone, l'utilisateur a
confirmé une dictée après relance, avant toute lecture, puis un envoi manuel et
une réponse écrite. Il avait aussi entendu une réponse lors d'un essai antérieur.
L'enchaînement lecture → dictée reste à qualifier : un essai avait échoué avec
« No speech detected » et le contrôle de lecture a été signalé absent.

Le **build 14, livré sur TestFlight interne**, ajoute la lecture progressive, un contrôle de lecture
sur sa propre ligne et des diagnostics micro agrégés. Les changements de session
audio visent la transition lecture/dictée; ils ne prouvent pas encore sa réparation
sur l'appareil. Voir la [feuille de route](voice-roadmap.md) pour les étapes suivantes.

## Parcours

1. L'utilisateur lance la dictée. L'app demande les autorisations microphone et
   reconnaissance vocale si nécessaire, puis vérifie la reconnaissance locale
   pour `fr-CA`.
2. La transcription remplit le brouillon. L'utilisateur peut arrêter la dictée,
   corriger le texte ou l'effacer. Aucun résultat partiel n'est envoyé au modèle.
3. **Envoyer** soumet explicitement le brouillon au même moteur Gemma que la
   saisie clavier. La dictée ne déclenche aucune action de l'agent à elle seule.
4. Si **Lire les réponses** est activé, les instantanés textuels de Gemma sont
   découpés en phrases ou segments bornés, puis ajoutés à une file Apple TTS
   identifiée par la réponse. La première phrase peut être lue avant la fin de
   génération; la fin ferme la file après le dernier segment. Une erreur vocale
   conserve la réponse texte. Une réponse interrompue peut avoir déjà été
   partiellement prononcée; aucun segment restant ne doit reprendre ensuite.
5. L'utilisateur peut arrêter la lecture. Recommencer une dictée interrompt la
   lecture avant d'ouvrir le microphone. Le contrôle de lecture reste sur sa
   propre ligne, y compris sur un écran étroit.

Le parcours est **demi-duplex** : capture et lecture ne fonctionnent pas
simultanément. Il n'inclut pas encore de fin de tour automatique, d'interruption
détectée par la voix ou d'AEC qualifié. L'envoi reste manuel.

Pendant l'écoute, un indicateur montre le signal agrégé reçu, sans prétendre
qu'il s'agit de parole. En cas d'erreur, un détail local expose nombres de
buffers/frames, format, type de route, délai du premier buffer, niveau et
domaine/code d'erreur. Ces diagnostics n'enregistrent ni audio ni transcription.
Le tap transmet toujours les buffers à Speech de façon synchrone; une tâche
séparée publie les agrégats au plus cinq fois par seconde.

## Capacités et confidentialité

La dictée crée un `SFSpeechRecognizer` pour `fr-CA`, exige
`supportsOnDeviceRecognition`, puis fixe
`requiresOnDeviceRecognition = true` sur chaque requête. Si la capacité, la
disponibilité ou une permission manque, l'app explique l'indisponibilité et
conserve la saisie clavier. Elle ne relance pas la reconnaissance sur serveur et
ne change pas silencieusement de langue. Apple documente que
[l'exigence locale](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition)
dépend de la
[capacité du recognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition).

La synthèse choisit une voix parmi les
[voix disponibles](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/speechvoices())
dont la locale est `fr-CA`. Si aucune ne convient, la réponse reste lisible sous
forme de texte. La présence d'une locale canadienne ne garantit ni une voix
particulière, ni un accent ou une naturalité évalués par des Québécois. Aucun
échantillon personnel ou clonage de voix n'est nécessaire à ce lot.

Les descriptions `NSMicrophoneUsageDescription` et
`NSSpeechRecognitionUsageDescription` expliquent les accès demandés. Les API
système peuvent dépendre de ressources installées par iOS; leur présence doit
être vérifiée dans les conditions de qualification. L'absence de repli cloud
dans le parcours ne constitue pas une observation du trafic réseau.

Les anciennes cibles de recherche ne sont pas une déclaration de compatibilité
du produit : l'app cible actuellement iOS **27.1**, et son chargeur Gemma exige
iOS **27.2** à l'exécution. Ce lot ne revendique pas la prise en charge de
l'iPhone SE2. Les prérequis du modèle restent dans
[la procédure iOS](ios-build.md), et ses limites dans
[l'état de vérification](verification.md).

## Arrêt et cycle de vie

L'arrêt de dictée ferme l'entrée audio et termine ou annule la tâche native.
Les callbacks tardifs d'une ancienne session doivent être ignorés; ils ne
doivent ni réécrire un nouveau brouillon, ni lancer une lecture. L'arrêt TTS
coupe l'énoncé et abandonne la file de lecture. Réinitialiser la conversation ou
lancer une nouvelle opération invalide aussi toute lecture différée de
l'ancienne réponse.

Le passage en arrière-plan, les interruptions audio et les changements de route
doivent arrêter l'opération vocale active et ramener l'interface dans un état
cohérent. Le retour au premier plan ne doit reprendre ni microphone ni ancienne
phrase automatiquement. Ce lot ne maintient aucun service d'écoute permanent.
Ces transitions demandent des essais natifs; les tests JavaScript ne suffisent
pas à établir la libération effective du microphone ou de la session audio.

## Qualification physique à exécuter

Contrôles du candidat build 14 :

- `cd mobile && npm run check` : typecheck, ESLint, **357 tests JavaScript dans
  18 suites** et génération du bridge iOS réussis. Les doublures couvrent lecture
  avant fin de génération, ordre des segments, annulation, erreurs facultatives,
  brouillon, diagnostics et événements périmés; elles ne produisent pas d'audio.
- `python3 scripts/test-local-voice-contract.py` : **8 contrôles statiques** des
  permissions, sources Xcode, contrat du bridge et exigences locales réussis.
- Les quatre sources vocales passent un typecheck Swift 6 strict arm64 iOS avec
  SDK 26.2. Les harnesses synthétiques vérifient **8 cas de mesure PCM** et
  **9 cas de file TTS**. Le harness de callbacks a réussi 9 cas positifs et
  2 pièges d'isolation attendus au second lancement; le premier a été rejeté
  pour une backtrace insuffisamment symbolisée sur la VM Intel.
- Le build 13 avait passé l'archive complète SDK 27.1 et ses contrôles de
  callbacks sur EAS. Le build 14 a repassé ces étapes avec les nouveaux
  harnesses et a été accepté par Apple. Sa qualification audio sur iPhone reste
  à faire. Un typecheck avec SDK 26.2 n'est
  pas une archive SDK 27.1.

Aucune mesure acoustique, latence iPhone, qualification de l'accent ou capture
réseau n'est déduite de ces vérifications. Les essais physiques du build 14
restent à exécuter après sa livraison.

Consigner révision Git, build, iOS, modèle d'iPhone, locale du recognizer,
identifiant de la voix et état des permissions. Utiliser un build Release avec
JavaScript embarqué et un modèle Gemma déjà transféré; Metro ne doit pas être
nécessaire. Ne pas effacer de données utilisateur pour préparer les essais.

| Série | Vérification et preuve attendue |
| --- | --- |
| Autorisations | Premier accord, refus, accès révoqué dans Réglages puis retour dans l'app; aucun microphone actif après échec, brouillon conservé |
| Capacités | Reconnaissance locale ou voix `fr-CA` indisponible : message explicite, saisie/réponse texte utilisable, aucune bascule distante |
| Parcours | Dicter, arrêter, corriger, attendre : aucune génération avant **Envoyer**; première phrase lue pendant la génération uniquement si l'option est activée; refaire Dicter après lecture |
| Annulations | Arrêter pendant dictée, génération et lecture; désactiver les réponses vocales, réinitialiser, puis recommencer; aucune transcription ou lecture périmée |
| Cycle de vie | Arrière-plan, verrouillage, interruption système et changement de route pendant dictée et lecture; absence de reprise automatique, nouvel essai possible |
| Français québécois | Phrases avec hésitations, autocorrections, noms locaux, montants et alternance français/anglais; transcription et qualité vocale évaluées séparément |
| Hors réseau | Après installation des ressources, terminer l'app, activer le mode Avion et désactiver Wi-Fi/cellulaire, relancer puis effectuer tout le parcours, y compris après redémarrage du téléphone |
| Trafic disponible | Réseau contrôlé avec journaux DNS et connexions sortantes, session de 15 minutes, ressources déjà présentes; vérifier les tentatives attribuables à l'app, pas seulement les connexions réussies |
| Stabilité | Séance de 30 minutes avec tours courts/longs et arrêts; relever mémoire, état thermique, erreurs et coupures, avec outil et fréquence de mesure |

Le test en mode Avion établit le fonctionnement sans réseau. Le test sur réseau
disponible cherche les tentatives de communication; il faut préciser les limites
d'attribution des journaux du routeur. Compléter par l'examen des dépendances et
des chemins réseau de l'app. Ne pas confondre un asset Apple déjà installé avec
un téléchargement déclenché pendant l'essai.

Mesurer séparément parole → texte partiel, arrêt → texte stable, premier segment Gemma stable → premier son, fin de parole → premier son, et commande d'arrêt → silence. Conserver p50/p95 et les
échecs sur plusieurs essais. Sans instrumentation, noter **non mesuré**. Aucun
budget de latence ni résultat physique de cette fonction n'est établi ici.

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

## Interface vocale — candidat build 15

La zone vocale commence par un état explicite : vérification, prêt à dicter,
préparation du micro, écoute, finalisation, lecture et arrêt. L'action principale
est mise en évidence; aucune annulation de dictée n'est proposée pendant l'arrêt.
Le contrôle de lecture garde sa propre ligne, avec un état désactivé accessible.
Les mises à jour du niveau micro restent séparées du bandeau d'état.

Les commandes vocales natives, l'envoi manuel et les capacités locales du build 14
restent identiques. Dix tests de composant couvrent ces états et les commandes;
les tests intégrés existants couvrent le parcours. Une revue visuelle simulée de
72 combinaisons (8 états, 3 thèmes, largeurs 320/375/430) ne révèle aucun
excès de largeur; un essai de texte web agrandi passe également. Ce banc n'ouvre
pas de microphone. Deux essais initiaux par navigation ont expiré pendant le
chargement du banc; le contrôle final change les scénarios dans une page montée
et a terminé sans erreur JavaScript. Il ne prouve pas le comportement de VoiceOver,
de Dynamic Type, du clavier ou de l'audio sur iPhone.

FreakUI fournit des composants SwiftUI; ce lot utilise les composants React Native
existants et les couleurs des trois apparences, sans ajouter cette dépendance.
