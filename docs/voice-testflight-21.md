# Assist 1.0.0 (21) — moteurs vocaux locaux optionnels

Cette tranche ajoute PocketTTS français24 couches, Parakeet Redux/Ultra et Silero,
avec le graphe AEC VPIO existant et une session Pocket par réponse. Les imports
restent explicites. Le choix initial est Apple. La voix québécoise et son
consentement seront fournis ultérieurement par l’utilisateur; aucun clone
n’est activé ou distribué dans cette archive.

## Parcours de validation sur iPhone

1. Avec Apple sélectionné, vérifier trois échanges automatiques, une interruption
   vocale pendant la réponse, pause/reprise, fermeture et retour depuis Réglages.
2. Ouvrir **Réglages → Voix locale avancée** : modèles et référence absents,
   options FluidAudio indisponibles, aucun microphone ni téléchargement déclenché.
3. Préparer et vérifier le [pack local](advanced-local-voice.md) sur ordinateur,
   le transférer entièrement dans Sur mon iPhone puis l’importer. Une annulation,
   variante partielle ou erreur d’intégrité doit conserver le pack précédent.
4. Fournir le WAV 3–30 secondes et le document de consentement dans le parcours
   prévu, puis choisir Redux ou Ultra. Sans référence, garder Apple.
5. Avec toutes les ressources, relancer en mode Avion et vérifier : chargement,
   phrase courte « oui », hésitation « euh… attends… », texte final unique,
   lecture segmentée continue et premier mot préservé après interruption.
6. Faire parler l’agent plus de trente secondes; la file doit rester bornée,
   sans coupure provoquée par une génération plus rapide que la lecture.
7. Fermer/reprendre pendant préchargement, conditionnement, décodage, préfill
   et lecture. Une ancienne réponse ne doit jamais se remettre à jouer.
8. Vérifier suppression/remplacement de la référence, choix Apple, persistance
   après relance, routes haut-parleur/casque, taille du texte et VoiceOver.

Mesurer séparément premier partiel STT, fin de tour, premier son, interruption
audible, mémoire de pointe avec Gemma et thermique sur30 minutes. Silero traite
ici256 ms et exige deux fenêtres positives pour barge-in : ne pas annoncer200 ms
sur la seule base de cette implémentation. Aucun résultat de ces essais ne doit
être déduit de la compilation ou des tests sans modèles.

## Preuves avant archive

Le candidat isolé passe TypeScript, ESLint, codegen iOS et **672 tests/27 suites**.
Le provisionneur passe7 tests locaux; les contrats historiques voix 8 et lancement 2
restent verts. Le module FluidAudio arm64 iOS27.1 et les neuf sources vocales
passent le compilateur Swift6 strict sur SDK26.2. Les bancs sans modèles passent :
SDK11tests, capture/rééchantillonnage10 et fichiers/SHA-256 5. La preuve compare
les empreintes exactes des sources testées au candidat. L’archive EAS/SDK27.1
et l’acceptation TestFlight restent des étapes séparées; les logs privés ne
contiennent ni enregistrement ni clé App Store Connect.

L’IPA doit contenir le produit Swift FluidAudio, les neuf sources vocales,
le manifeste des poids et les attributions. Aucun gros poids, consentement,
audio de référence ou secret n’appartient à l’archive de l’application.

## Notes TestFlight fr-CA

Pile vocale locale optionnelle : PocketTTS français24 couches, Parakeet Redux/Ultra et Silero avec annulation d’écho iOS. Apple reste activé par défaut.

Vérifie d’abord trois échanges automatiques et une interruption vocale avec Apple. Réglages → Voix locale avancée permet d’importer le pack local vérifié, puis un WAV et son document de consentement. Sans ces fichiers, les options avancées restent désactivées.

Après import complet : tester « oui », les hésitations, une réponse de plus de30 secondes, interruption puis reprise, fermeture pendant chargement et fonctionnement en mode Avion. Signaler latence, coupure, perte du premier mot, reprise d’un ancien son, mémoire ou chauffe. La voix québécoise et son consentement restent à fournir; leur qualité n’est pas encore qualifiée.

## Notes TestFlight en-US

Optional local speech stack: PocketTTS French24 layers, Parakeet Redux/Ultra and Silero with iOS echo cancellation. Apple remains the default.

First test three automatic exchanges and a spoken interruption using Apple. Settings → Advanced local voice imports the verified local model pack, then a WAV reference and its consent document. Advanced options stay disabled until these files are present.

After full import: test a short “oui”, hesitations, an answer longer than30seconds, interruption and recovery, closing during loading and Airplane Mode. Report delay, audio gaps, missing first words, stale speech, memory or heat. The Quebec voice reference and consent are still to be supplied; voice quality is not yet qualified.
