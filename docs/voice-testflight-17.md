# Assist 1.0.0 (17) — interruption vocale locale

Rapport opérationnel local; ne pas copier automatiquement dans le dépôt public.

## Portée et point de départ

L’utilisateur confirme le 16 octobre 2026 que le build16 fonctionne correctement. Cela établit un essai positif de la boucle, sans valider toutes les routes, conditions de bruit ou performances.

Candidat isolé : `/home/ales27pm/.local/share/assist-release-candidates/voice17`, branche `codex/voice-barge-in-build-17`.
Base livrée : `a4e6449224d70ff5d668817c93763b47a97a5272` (build16).

Le TTS Apple est rendu par write en PCM puis joué via AVAudioPlayerNode dans le même AVAudioEngine à traitement vocal VPIO/voiceChat que le microphone. La reconnaissance Apple fr-CA locale est active pendant la réponse. Le premier texte reconnu déclenche l’arrêt/purge natif TTS et la promotion de la même tâche ASR, avant livraison des premiers mots à JavaScript. Aucun enregistrement PCM utilisateur ni serveur d’inférence ajouté.

Le hook adopte atomiquement la nouvelle identité, rejette les anciens ACK/événements et ne relance pas le micro. Le controller invalide l’ancienne réponse, annule uniquement le calcul/stream JS, conserve le nouveau final pendant ce règlement et ne lance la suite qu’après les deux confirmations. Le contexte de la demande utilisateur interrompue est conservé; ses corrections adjacentes sont regroupées pour le template Gemma. L’ancien partiel n’est pas sauvegardé comme réponse terminée ni laissé « en cours ». La lecture interrompue est étiquetée dans le mode vocal.

L’écran n’annonce un micro actif pendant la réponse que si monitoring natif est vrai. Le bouton Interrompre, pause et fermeture restent disponibles. Les descriptions de permissions expliquent désormais les interruptions pendant les réponses.

## Vérification JavaScript et source

- Régressions controller : 4 nouvelles erreurs attendues sur la baseline avant implémentation; après correction, 23 tests PASS. Couvrent les deux ordres de règlement, premiers mots, final conservé, ancien callback, erreur de cancel et pause gagnante.
- Régressions hook : transfert, anciens ACK résolus/rejetés, veille d’entrée de mode désactivé, monitoring/refresh obsolètes, arrière-plan et premier texte. Une course du refresh initial empêchant l’entrée de mode a été reproduite et corrigée.
- Tests App : deux ordres d’annulation, contexte de correction et brouillon, ACK enqueue tardif, sortie après interruption sans ancien partiel, reprise naturelle sans cancel destructeur.
- Contrôle intégré : `npm --prefix mobile run check`, **500 tests / 22 suites**, TypeScript, ESLint sans avertissement et codegen iOS PASS. Preuve : `/tmp/assist-barge17-check.log`.
- Contrat statique : 8 PASS, incluant les nouveaux fichiers compilés dans Xcode; launch et bundle guards vérifiés séparément.
- Pas de nouveau framework tiers, modèle, poids, SDK réseau ou télémétrie. La revue de code ne prouve pas l’absence de trafic réel.

## Audio natif et risques de qualification

La fin du TTS doit attendre les PCM réellement joués (`dataPlayedBack`), pas le seul délégué de synthèse. Identités invalidées avant stop et commandes tardives ignorées. PCM de synthèse transféré sous forme de valeurs possédées et bornées; aucune trame microphone ne passe dans une Task ou JavaScript. Files de texte/audio bornées, une production à la fois.

Après fin naturelle, la même ASR peut rester au plus5s pour adoption de la prochaine écoute, afin de préserver une attaque dont le partiel arrive après le dernier son. Pause, fermeture, arrière-plan ou interruption détruisent immédiatement cette rétention. Le watcher est réarmé de manière bornée en cas de fin vide; les erreurs doivent rester visibles.

Les tests natifs synthétiques, le typecheck Swift et l’archive EAS17 sont en attente à la création de ce rapport. Aucun benchmark acoustique, délai d’arrêt, AEC réel, absence de faux déclenchement, mémoire/thermique ou résultat VoiceOver/Dynamic Type n’est déduit des mocks. La reconnaissance pendant TTS peut augmenter la consommation. La détection attend du texte local et peut réagir à un résidu d’écho.

## Livraison

Compte ales27 Starter et projet payant confirmés; aucun build17 existant avant lancement. Le build16 est conservé. Source finale, EAS, IPA, soumission et acceptation Apple17 à renseigner après preuves.

## Essai iPhone requis

Faire une réponse longue; interrompre sans toucher au début, au milieu et à la fin, puis corriger la demande. Vérifier premier mot conservé, contexte correct, aucune vieille phrase rejouée. Laisser TTS seul aux différents volumes et dans le bruit; mesurer les fausses interruptions. Tester pauses/fermeture/Réglages/background/verrouillage/routes, autorisations et lecture OFF, puis session prolongée et hors réseau. Relever conditions et erreurs, sans annoncer de parité ChatGPT/Gemini. iOS27.2 reste requis pour charger le modèle Gemma local.

## Candidat final avant EAS

- Source `95f098219210e4a81bcbe0a65bce0d7d1731ad3a`, branche dédiée publiée, checkout propre.
- Contrôle final : **508 tests /22suites**, TypeScript, ESLint sans avertissement, codegen PASS; `/tmp/assist-barge17-check-final.log`. Capture finie naturellement avant ACK couverte, sans réactivation après erreur/cancel/autre session.
- Six sources Swift strict6 arm64-iOS27.1 sur SDK26.2 PASS. Scripts exacts : duplex10, mesure8, file9, callbacks9 avec128frames et2pièges d’isolation attendus. Premier négatif terminéexit132 mais symbole absent de la backtraceVM; une relance unique a passé les deux pièges. Preuve `/tmp/assist-voice17-native-verification.json`. Sources/harness identiques aux empreintes; projet ne diffère que par deux numéros16→17 après le plutil. Aucun microphone ni synthèse réelle dans ces harnesses.
- Paquet EAS inspecté :224fichiers,4213240octets; nouveaux helpers/harness présents; aucun secret/profil/IPA/log/crash/rapport privé/node_modules/fixture de revue.
- Demande EAS17 lancée une seule fois, reçu en attente à cette étape.

- Reçu EAS17 exact : [4c60a1f6-1f92-418f-a60f-691717f987d5](https://expo.dev/accounts/ales27/projects/assist/builds/4c60a1f6-1f92-418f-a60f-691717f987d5), source95f098219210e4a81bcbe0a65bce0d7d1731ad3a, profiltestflight. Aucune soumission17 demandée à cette étape.
- Les22fichiers de livraison ont été comparés au workspace original avant synchronisation : aucun conflit horsdocs avec la base16; les changements préexistants horsscope sont préservés.

## Pré-install EAS17

Tous les contrôles frais sur le serveur Apple Silicon SDK27.1 passent : callbacks9/128frames avec2pièges attendus exit133, mesure8, file9 et nouveau duplex10. Les scénarios comprennent64segments,1300petits callbacks, ordonnancement de fin PCM, libération .stop sans démarrer le matériel et formats/budgets. Aucun moteur audio, micro, reconnaissance ou TTS réel dans le nouveau harness. Archive complète en cours à cette étape.

## Archive17 vérifiée

- EAS FINISHED à2026-10-17T02:00:37.019Z; source95f098219210e4a81bcbe0a65bce0d7d1731ad3a, marqueurARCHIVE SUCCEEDED présent.
- IPA `/tmp/assist-voice-build17.ipa` : 12411548octets; SHA-256 `60b35014a0b30a05500c765f8af84ac169ef53dd8a9b084fd0f1c6a0a6ae4660`.
- UUIDarm64 `6F77FADA-A1AB-3580-9E0B-A1C2F2ECF3E7`. Bundleorg.27pm.assist,1.0.0(17), minimum27.1, SDKiphoneos27.1/Xcode2710, descriptionsmicro/Speech actualisées et chiffrement non exemptfalse.
- ProfilCMS, CodeResources, présence signatureMach-O/entitlements cohérents, get-task-allow=false et beta-reports-active=true; aucun poidsGemma/paquetML/safetensors. ChaîneApple et hashescomplets du code non cryptographiquement vérifiés par cette inspection; aucune preuve d’installation/audio par IPA seule. Résultat `/tmp/assist-voice17-ipa-verification.json`.
- Soumission exacte `c1ea99eb-f970-4521-9235-d6dc33a2148e` demandée une seule fois; acceptationApple en attente à cette étape.

## Livraison finale confirmée

- Soumission `c1ea99eb-f970-4521-9235-d6dc33a2148e` FINISHED à2026-10-17T02:03:56.895Z, exactement reliée au buildEAS17.
- Apple1.0.0(17) VALID / IN_BETA_TESTING, non expirée, chiffrement non exemptfalse; externeREADY_FOR_BETA_SUBMISSION. Aucun groupe, invitation ou revue externe ajouté.
- Notesfr-CA/en-US écrites et relues exactement; `/tmp/assist-barge17-asc-final.json`.
-22fichiers du workspace original synchronisés après tous les guards et disponibilité confirmée. Les sections historiques de livraison16/interface15 ont été préservées; numéroXcode original désormais17. Changements horsscope préservés. Candidat propre et branche publiée au SHA95f098219210e4a81bcbe0a65bce0d7d1731ad3a.
- Reste à qualifier sur iPhone : ASR superposé, premier mot, délai de coupure, écho et fausses interruptions, audio/VoiceOver/Dynamic Type/offline et stabilité. Aucun résultat acoustique ou équivalence ChatGPT/Gemini annoncé.
