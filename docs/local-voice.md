# Voix locale — premier parcours iOS

Ce lot ajoute une dictée et une lecture avec les API système Apple, autour du
moteur Gemma local existant. Il ne qualifie pas encore leur fonctionnement sur
un iPhone physique. Une compilation, des tests avec doublures et un aperçu web
ne prouvent ni la reconnaissance hors réseau, ni l'accent, ni la latence audio.

## Parcours

1. L'utilisateur lance la dictée. L'app demande les autorisations microphone et
   reconnaissance vocale si nécessaire, puis vérifie la reconnaissance locale
   pour `fr-CA`.
2. La transcription remplit le brouillon. L'utilisateur peut arrêter la dictée,
   corriger le texte ou l'effacer. Aucun résultat partiel n'est envoyé au modèle.
3. **Envoyer** soumet explicitement le brouillon au même moteur Gemma que la
   saisie clavier. La dictée ne déclenche aucune action de l'agent à elle seule.
4. Si les réponses vocales sont activées par l'utilisateur, une réponse Gemma
   terminée peut être lue par `AVSpeechSynthesizer`, avec une voix `fr-CA`
   disponible sur l'appareil. Une réponse annulée, échouée ou remplacée ne doit
   pas être lue.
5. L'utilisateur peut arrêter la lecture. Recommencer une dictée interrompt la
   lecture avant d'ouvrir le microphone.

Le parcours est **half-duplex** : capture et lecture ne fonctionnent pas
simultanément. Il n'inclut ni interruption détectée par la voix, ni AEC externe,
ni détection automatique de fin de tour, ni TTS des jetons Gemma en cours de
génération. La lecture démarre après la réponse complète.

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

Contrôles exécutés le **16 octobre 2026** sur l'hôte Linux :

- `cd mobile && npm run check` : typecheck, ESLint, **283 tests JavaScript**
  et génération du bridge iOS réussis. Les 24 tests vocaux couvrent le brouillon,
  l'envoi explicite, la lecture facultative, les autorisations différées,
  les annulations et les événements périmés avec une doublure du module natif.
- `python3 scripts/test-local-voice-contract.py` : six contrôles statiques de
  permissions, enregistrement natif, contrat du bridge et exigences locales.
  Ils ne compilent ni n'exécutent Swift. La CI les inclut désormais.
- `python3 scripts/test-ios-launch.py` : deux contrôles de configuration de scène
  réussis; ils ne lancent pas l'app.
- Build de l'aperçu web et bundle JavaScript iOS Release réussis. Les outils
  signalent des avertissements amont sur les directives `use client` et un
  sous-chemin privé React Native; aucun de ces builds ne compile le code iOS.

Xcode et un compilateur Swift ne sont pas disponibles sur cet hôte. Le nouveau
code AVFoundation/Speech n'a donc pas encore été compilé contre un SDK Apple,
ni essayé sur un iPhone. Le fonctionnement audio, les autorisations réelles et
l'indépendance réseau restent à établir avec le protocole ci-dessous.

Consigner révision Git, build, iOS, modèle d'iPhone, locale du recognizer,
identifiant de la voix et état des permissions. Utiliser un build Release avec
JavaScript embarqué et un modèle Gemma déjà transféré; Metro ne doit pas être
nécessaire. Ne pas effacer de données utilisateur pour préparer les essais.

| Série | Vérification et preuve attendue |
| --- | --- |
| Autorisations | Premier accord, refus, accès révoqué dans Réglages puis retour dans l'app; aucun microphone actif après échec, brouillon conservé |
| Capacités | Reconnaissance locale ou voix `fr-CA` indisponible : message explicite, saisie/réponse texte utilisable, aucune bascule distante |
| Parcours | Dicter, arrêter, corriger, attendre : aucune génération avant **Envoyer**; réponse terminée lue uniquement si l'option est activée |
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

Mesurer séparément parole → texte partiel, arrêt → texte stable, réponse Gemma
terminée → premier son, et commande d'arrêt → silence. Conserver p50/p95 et les
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
