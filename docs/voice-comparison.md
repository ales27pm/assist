# Comparer les voix françaises canadiennes

L’étape 5 commence avec une référence Apple écoutable dans l’app. Le comparatif
est accessible depuis **Réglages → Voix de l’assistant**. Il ne remplace pas
le mode vocal et n’ouvre pas le microphone. Le choix du meilleur accent reste
une évaluation humaine; aucun résultat auditif n’est déduit des tests logiciels.

## Parcours implémenté

- La liste provient des voix disponibles sur l’appareil. Seules les locales
  `fr-CA` sont proposées, avec une politique conservatrice d’identifiants
  `com.apple.`; voix personnelles, voix fantaisie et qualités inconnues exclues.
  Ce préfixe est une règle du produit, pas une attestation publique Apple de
  provenance ou d’exécution hors réseau. Chaque voix retenue doit passer l’essai
  hors ligne ci-dessous. Aucune voix `fr-FR` ne remplace une voix absente.
- Un ordre aléatoire est fixé pour la session. Les voix portent des numéros et
  leur nom/qualité restent masqués jusqu’à une révélation explicite après une
  écoute terminée. Actualiser le même inventaire conserve cet ordre; un nouvel
  inventaire remet le comparatif à zéro.
- Cinq phrases fixes couvrent conversation et heure, noms québécois, montants,
  français/anglais et hésitations/corrections. Une phrase entière et ses segments
  contiennent exactement le même texte. Les segments sont joués successivement
  avec les mêmes paramètres vocaux par défaut.
- Six critères facultatifs, notés Faible/Moyen/Bon : accent québécois,
  intelligibilité, rythme, prononciation des noms/nombres, continuité des segments
  et stabilité d’identité. La continuité ne se note qu’en lecture segmentée.
- Les noms révélés permettent d’enregistrer une voix pour les prochaines
  réponses du mode vocal, ou de revenir au choix automatique. Le choix est local
  et indépendant de l’activation de la lecture. Une réponse en cours garde la
  voix choisie à son démarrage. Si l’asset choisi disparaît, la conversation
  retrouve une autre voix admissible `fr-CA`; le comparatif signale ce repli.
  Un aperçu visant une voix disparue échoue sans lui substituer une autre voix.
- L’aperçu possède son synthétiseur de lecture seule, sa session audio et un
  identifiant d’annulation. Il refuse le chevauchement avec la conversation.
  Arrêter ou fermer attend la confirmation native; arrière-plan, interruption
  système, changement de périphérique et retour à la conversation arrêtent
  l’aperçu. Aucun appel de preview ne démarre Speech, VPIO ou une permission micro.
- Le rapport se partage uniquement après révélation, sur action de la personne.
  Il conserve les 100 derniers essais terminés, les notes effectivement saisies,
  les identifiants de voix, le corpus, le build et iOS lorsque disponibles.
  `listeningBlind` décrit l’écoute; `ratingsBlind` décrit chaque note au moment
  de sa dernière saisie. Une note modifiée après révélation n’est plus qualifiée
  d’aveugle. Les essais interrompus ne sont pas notés comme terminés.
  Aucun enregistrement audio, texte dicté ou conversation n’est inclus. Les avis
  non partagés disparaissent à la fermeture du comparatif.

## Essai sur iPhone

1. Consigner modèle d’iPhone, build d’Assist, version iOS et route utilisée.
   Ajouter les voix voulues dans les réglages de parole iOS, puis actualiser la
   liste. Une seule voix permet de comparer entière/segmentée, pas plusieurs
   identités; aucune voix disponible doit donner une explication et une reprise.
2. Écouter les cinq phrases avec chaque voix, entières puis segmentées, à volume
   constant. Donner les notes avant de révéler les noms. Ne pas confondre qualité
   de lecture d’un texte fixe et précision de transcription STT.
3. Répéter avec plusieurs personnes francophones québécoises et comparer leurs
   rapports séparément. Les scores 1–3 sont des appréciations ordinales, pas un
   MOS publié ni une preuve statistique de supériorité.
4. Révéler les noms, choisir la voix préférée, fermer et relancer Assist. Vérifier
   que les prochaines réponses vocales utilisent cette voix et que la préférence
   de lecture activée/désactivée est conservée séparément.
5. Enchaîner aperçu → arrêt → mode vocal → trois échanges avec une interruption
   par la voix → retour au comparatif. Essayer aussi arrêt rapide, changement de
   périphérique et mise en arrière-plan. Aucune ancienne lecture ne doit revenir.
6. Après préparation des assets, quitter l’app, activer le mode Avion avec Wi-Fi
   et cellulaire désactivés, relancer et rejouer chaque voix retenue. Une capture
   réseau lorsque le réseau est disponible reste nécessaire pour vérifier les
   tentatives de connexion; le mode Avion seul ne prouve pas leur absence.
7. Vérifier petits écrans, texte agrandi et VoiceOver : titre à l’ouverture,
   radios et valeurs annoncées, arrêt accessible et retour au contrôle d’origine.

L’aperçu utilise `AVSpeechSynthesizer.speak`; le mode vocal utilise sa propre
production PCM, son lecteur et VPIO. Une préférence auditive doit donc être
confirmée dans une vraie réponse segmentée du mode vocal. L’aperçu ne mesure
ni premier son audible, ni latence de tour, ni AEC ou débit de production PCM.
Le rapport les laisse explicitement non mesurés; aucun budget de performance
n’est déclaré atteint sur cette base.

## Comparaison ultérieure avec PocketTTS

Le prototype lourd doit rester isolé jusqu’à une amélioration auditive et une
coexistence mémoire constatées sur l’iPhone cible. Les révisions, tailles et
limites françaises déjà épinglées figurent dans
[PocketTTS et la pile avancée](local-voice.md#pockettts-et-la-pile-avancée).
Le protocole reprend exactement les cinq textes, leurs deux découpages et les
mêmes critères. Une voix fournie par le modèle ne constitue pas une preuve
d’accent québécois; toute référence québécoise personnelle exige un consentement
documenté. Aucun échantillon, clone, poids ou SDK lourd n’est ajouté par cette
tranche Apple.

Avant intégration : épingler SDK/poids/licences, mesurer téléchargement, stockage
compilé, démarrage, première frame produite et premier son audible séparément,
débit, mémoire avec Gemma, interruptions et 30 minutes de thermique sur appareil.
Une comparaison sur Mac ou un meilleur score d’écoute sans ces mesures ne
qualifie pas le remplacement du moteur iOS.

## Sources et vérification

Sources primaires Apple : [liste des voix disponibles](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/speechvoices()),
[identifiant de voix](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/identifier),
[qualité](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/quality),
[traits](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/voicetraits),
[lecture](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/speak(_:)),
[fin d’énoncé](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizerdelegate/speechsynthesizer(_:didfinish:)),
[changement des voix disponibles](https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice/availablevoicesdidchangenotification).

Les résultats logiciels et l’état de livraison de cette tranche sont consignés
séparément; les essais acoustiques ci-dessus restent à exécuter sur l’iPhone.
