# Assist1.0.0(19) — format client commun du graphe vocal

## Signalement et diagnostic

Après livraison18, une capture utilisateur affiche « Le microphone avec annulation d’écho n’a pas pu démarrer : Le graphe audio avec annulation d’écho est inutilisable ». Le message vient du contrôle health après engine.start, avant les notifications différées et la première transcription. Les Détails audio sont repliés dans la capture; leur copie a été demandée. Aucun prédicat fautif précis sur cet iPhone n’est encore confirmé.

Un défaut de construction est vérifié :18 configure lecteur→mixeur en48kHz mono mais laisse mixeur→sortie automatique, alors que le tap est fixé avant start. Le contrat Apple VPIO exige le même format client entre input.output et output.input. L’exemple Apple configure explicitement mixer→output et le tap avec le même format; le mixeur implicite peut suivre le format de sortie au start/restart.

Sources primaires : [exemple Apple](https://developer.apple.com/documentation/avfaudio/using-voice-processing), [mixeur principal](https://developer.apple.com/documentation/avfaudio/avaudioengine/mainmixernode), [sortie client/matérielle](https://developer.apple.com/documentation/avfaudio/avaudiooutputnode). ZIP officiel inspecté en mémoire : `UsingVoiceProcessing.zip`, SHA256 `f98d61140110f362a7cefbe782944ba9f5e5e2487e7c767e65f18065434034d9`, AVEchoTouch/AudioEngine.swift46,110,112. Preuve : `/tmp/assist-voice19-apple-example.json`.

## Correctif

Après activation VPIO à l’arrêt et création du mixeur/lecteur,19 capture le format client micro, relie explicitement mixeur→sortie avec ce format, puis installe le tap identique avant prepare/start. Le lecteur48kHz monoFloat32 garde son format canonique; le mixeur convertit. Le réarmement STT ne reconnecte pas le graphe en cours. Les gardes de génération et d’arrêt réentrant sont conservées.

Le contrôle reste strict et ajoute l’égalité I/O client VPIO. decision et diagnostics utilisent exactement les mêmes rejectionCauses. Deux lignes exposent d’abord les causes nommées, puis les formats complets in/tap/out/player (fréquence,canaux,PCM,entrelacement), avec indicateurs app/session/config/moteur/VPIO. Limite inchangée8×400caractères; aucun UID, nom d’accessoire, texte ou audio. Aucun changement JS/UI ni nouveau modèle ou service distant.

## Vérification avant EAS

- Candidat isolé : `/home/ales27pm/.local/share/assist-release-candidates/voice19`, branche `codex/voice-io-format-build-19`.
- Révision publiée : `a0b2b2ecb9462e4cac53607334cd70e7d1fa713f`,7fichiers modifiés depuis18.
- `npm run check` :522tests/22suites, TypeScript, ESLint, codegen réussis; `/tmp/assist-voice19-check.log`.
- Contrat local8, démarrage2, absence de poids Gemma embarqués : contrôles réussis.
- Six sources Swift6 strict arm64-iOS27.1, SDK26.2 : typecheck réussi; pbx19plutil valide. Preuve avec hashes exacts : `/tmp/assist-voice19-native-verification.json`.
- Banc natif24/24 au premier essai : cas réel de sortie implicite stéréo/client mono reproduit hors ligne, helper de câblage de production exercé, puis signal48kHz converti vers44,1/48kHz mono avec contrôle du signal rendu. Deux moteurs réels en rendu manuel hors ligne démarrés; aucun inputNode, microphone, sortie matérielle, VPIO réel, Speech ou TTS réel activé.
- Les causes distinctes de tap post-start, type PCM/entrelacement, I/O, lecteur canonique et configuration sont testées. Les données ne masquent plus plusieurs rejets sous une ligne identique.
- Revue croisée sans blocage concret, compatibilité parser/Disclosure existants confirmée.
- Source EAS inspectée :224fichiers,4 263 949octets, tous les fichiers modifiés identiques au candidat; secrets, journaux, dépendances node_modules et modèles exclus.

Le banc hors ligne et la documentation justifient le câblage corrigé; ils ne prouvent ni la garde réellement fautive sur l’iPhone18, ni le bon démarrage micro19, ni l’AEC ou l’arrêt audible. Ces résultats restent à confirmer sur appareil.

## Livraison en cours

Compilation EAS19 demandée une seule fois pour la révision exacte. Archive, IPA, soumission Apple, notes et disponibilité interne restent à confirmer.

Les changements indépendants du workspace original (UI, modèle, accessibilité et documentation de livraison18) sont préservés et ne sont pas inclus dans cette archive isolée. Le projet original conservera ModelDirectoryBookmark; seul son numéro de build sera modifié lors du report du correctif après livraison.

Build EAS demandé : `6058efa8-7261-4199-b2de-97277246fa3f`, source exacte `a0b2b2ecb9462e4cac53607334cd70e7d1fa713f`, profil testflight, version1.0.0(19). Aucun autre build19 n’existait au contrôle initial.

## Archive et IPA

EAS FINISHED à2026-10-17T03:13:18.710Z; **ARCHIVE SUCCEEDED** SDK27.1 présent. Les suites callbacks9+128frames+deux pièges133, mesure8, file9 et duplex24 ont repassé sur EAS au premier passage, dont les moteurs hors ligne partagés. Aucun microphone ni AEC réel testé par ces scripts.

IPA19 :12 455 497octets, SHA256 `3fb5a5a3240b434d31829637539c2e5cc34fa700d9ec9fb9d159498498833ce0`, UUIDarm64 `328F4522-A406-37C0-8384-0F9F2549D2BD`. Version1.0.0(19), bundle attendu, minimum27.1, permissions micro/Speech, nonexemptencryptionfalse et absence de Gemma vérifiés. Signature CMS du profil vérifiée sans chaîne de confiance; présence structurelle de signature Mach-O et entitlements inspectés. Chaîne Apple et hashes cryptographiques de signature exécutable non vérifiés ici. Preuve : `/tmp/assist-voice19-ipa-verification.json`.

Soumission de cette IPA exacte en cours, aucune autre tentative19.

## Livraison finale confirmée

EAS submission `8f3d8f5a-13c4-4594-be4c-aa25f70da03a` FINISHED à2026-10-17T03:16:15.662Z, relation exacte vers le build `6058efa8-7261-4199-b2de-97277246fa3f`. Apple1.0.0(19) VALID / IN_BETA_TESTING, non expiré, chiffrement nonexemptfalse; état externe READY_FOR_BETA_SUBMISSION. Aucune invitation, association externe ou Beta App Review lancée.

Notes fr-CA/en-US écrites et relues exactement. Preuves : `/tmp/assist-paid-submission19.json`, `/tmp/assist-voice19-asc-final.json`. Les7fichiers du correctif sont fusionnés dans le workspace original après guards des hashes; ses modifications UI/modèle/accessibilité, ses ajouts de docs18 et sa référence ModelDirectoryBookmark sont conservés. Numéro Xcode original19; branche/index inchangés. Sauvegarde avant fusion : `/tmp/assist-voice19-original-backup`.

Les4fichiers natifs/scripts modifiés sont exactement identiques au candidat livré, les8contrats statiques repassent après fusion. Aucun JS/UI modifié par ce correctif; pas de répétition inutile des tests JS inchangés. Candidat isolé propre au SHA `a0b2b2ecb9462e4cac53607334cd70e7d1fa713f`.

La livraison ne constitue pas une preuve d’installation, de réception du micro, de STT, d’écho ni d’arrêt audible sur l’iPhone. Le message18 provenait du guard post-start; son prédicat exact reste inconnu tant que les Détails audio ne sont pas fournis. Essai requis : installer19, relancer, charger le modèle et faire trois échanges puis « Non, attends » pendant une réponse. Si échec, relever les dernières lignes causes/formats.

## Retour utilisateur et mesures sur appareil

Après livraison, l’utilisateur confirme **« Works perfectly »** et fournit un
rapport `assistQualification` version 1 pour le **build 19**, sous **iOS 27.2
(24B5110a)**. Le moteur est prêt avec
`gemma4-e2b-32k-group8-abliterated-rmscomposite`, contexte de 32 768 jetons.
Le rapport ne nomme pas le modèle matériel de l’iPhone. Ce retour confirme un
fonctionnement rapporté sur appareil après le correctif; il ne décrit pas un
protocole acoustique détaillé. Seuls les agrégats sont consignés ici, sans texte
de conversation, audio ni identifiant de requête.

| Mesure | Résultat observé | Portée |
| --- | --- | --- |
| Chargement du modèle | 3 160,6 ms | Un chargement; instantanés mémoire avant/après, pic de chargement non mesuré |
| Mémoire physique après chargement | 1 582 746 304 octets, soit 1,474 Gio | Instantané du processus |
| Premier jeton LLM | 180,3–422,6 ms | Quatre générations, dont une annulée; pas un délai de premier son |
| Débit de décodage | 32,60–34,36 jetons/s | Moyennes natives par génération, après le premier jeton |
| Dernière génération | 72 jetons en 2 491,4 ms, premier jeton à 422,6 ms | Prompt de 490 jetons; fin `eos` |
| Pic mémoire de cette génération | 1 674 580 064 octets, soit 1,560 Gio | Pic échantillonné; pics transitoires possibles entre les mesures |
| Annulation LLM demandée → confirmée | 21,08 ms | Écart entre événements du moniteur; pas une mesure d’arrêt audible |
| État final observé | `ready`, thermique `nominal`, économie d’énergie désactivée | Instantané à 139,8 s de session; pas un essai prolongé |

Les quatre générations enregistrées se terminent par trois `eos` et une
annulation. Le débit suit la définition native
`(generatedTokens - 1) / ((elapsedMs - ttftMs) / 1000)`; ces quatre observations
ne constituent pas une distribution de référence ni une estimation de p95.

Le moniteur n’expose qu’un instantané d’historique dans ce rapport. Son empreinte
courante et son pic de fenêtre valent 585 453 664 octets (558,3 Mio), à un autre
moment et sur une autre fenêtre que le pic de génération ci-dessus. Ces valeurs
ne suffisent pas à démontrer une libération précise ni l’absence de fuite.
Les 2 954 538 912 octets de `availableMemoryBytes` représentent le budget
d’allocation restant de l’app, pas la RAM libre de l’appareil.
`memoryPressure: unknown` signifie qu’aucun événement n’a encore été observé;
le rapport ne permet pas d’en déduire une pression normale.

L’exécution ANE demeure **non vérifiée**. Les latences STT, de décision de fin
de tour, de premier son TTS et d’interruption acoustique ne sont pas présentes.
L’efficacité de l’AEC, la reconnaissance fr-CA, les routes audio et le
fonctionnement hors réseau n’ont pas de mesures dédiées dans cet export.
Le retour positif établit donc la nouvelle référence fonctionnelle build 19;
la prochaine mesure prioritaire reliera fin acoustique de parole, texte STT
stable, décision de fin de tour, premier jeton LLM et premier son audible.
