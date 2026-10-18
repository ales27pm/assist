# Assist 1.0.0 (22) — Estelle sans référence personnelle

Le pack vérifié suffit à sélectionner PocketTTS français24L avec Parakeet
Redux/Ultra et Silero. La synthèse utilise la voix publique Estelle et conserve
une session Mimi par réponse. L’import WAV, le nom, le consentement, les deux
commandes de bridge associées et le chargement du conditionnement personnel
sont retirés. Le manifeste reste identique au build21 : le pack existant est
réutilisé sans téléchargement ni réimportation.

La migration ne retire que le répertoire UUID de référence géré par Assist.
Le pack, le choix du moteur et les originaux dans Fichiers sont conservés.
Un échec de suppression garde son pointeur pour un prochain lancement sans
jamais utiliser les anciens fichiers pour parler.

Les erreurs de chargement indiquent désormais PocketTTS, Parakeet, Silero ou
la session Estelle, avec jusqu’à trois domaines/codes natifs dans Détails audio.
Les descriptions, textes et chemins privés restent exclus. Un rejet de la
commande de démarrage transmet sa cause au coordinateur de conversation, même
si l’événement natif arrive plus tard. L’annulation ou un nouveau tour retire
aussi cet ancien échec pendant la lecture différée des diagnostics.

## Preuves et limites

- TypeScript, ESLint et codegen iOS : réussis.
- Suite React Native finale : 672 tests/27 suites, dont107 tests du parcours
  vocal et l’annulation pendant la lecture différée des diagnostics.
- Contrats historiques voix8, lancement2 et archive EAS1 : réussis.
- Banc natif duplex : 28 contrôles réussis. Fichiers/migration : 7 groupes réussis.
- FluidAudio arm64 iOS et neuf sources vocales de l’app : compilation/typecheck
  Swift6 strict sur Xcode26.3/SDK26.2 réussis; ce n’est pas une archive signée.
- Mac Intel virtuel/macOS15.7.9, Core ML CPU : chargement des dix composants du
  pack, initialisation de PocketTTS/Redux/Silero réussis. Une session Estelle
  produit trois frames de1920 échantillons finis puis accepte l’annulation.
  Pas d’écoute subjective, de micro, de preuve A18/ANE ou de mesure iPhone.

L’erreur initiale sur iPhone16Pro/iOS27.2 n’est pas encore attribuée à un
composant. Retirer l’ancien chemin de référence élimine un point d’échec
possible, mais ne prouve pas que tous les modèles chargent sur cet appareil.
Le test physique sur iPhone reste à faire après installation.

## Livraison vérifiée — 17 octobre 2026

Apple confirme **1.0.0 (22)** : `processingState=VALID`,
`internalBuildState=IN_BETA_TESTING`. Les notes fr-CA et en-US correspondent
exactement aux textes ci-dessous. Aucune revue bêta externe n’a été demandée.

- Source compilée : `d2541161a165b491c67343897d7d7f61dc546305`.
- [Build EAS](https://expo.dev/accounts/ales27/projects/assist/builds/f7756781-be83-4484-acb2-4244ec85d274) : FINISHED, ARCHIVE SUCCEEDED, export signé.
- [Soumission EAS](https://expo.dev/accounts/ales27/projects/assist/submissions/77dbc40f-8613-453e-bdc6-108bd1e8a630) : FINISHED.
- IPA : 18 075 394 octets, SHA-256 `8083e858a94161663ae30541493b666fc4b80605b24bac1463224aa5c43555b8`.
- Contrôles IPA : version, permissions, manifeste et attributions exacts;
  anciens sélecteurs d’import/suppression de référence absents; aucun poids
  vocal ou document personnel embarqué. Structure de signature présente et
  profil de distribution décodé; chaîne de confiance et pages du binaire non
  vérifiées cryptographiquement en local. Acceptation Apple vérifiée séparément.
- Les huit suites natives ont passé sur EAS. Le dossier de travail intégré
  passe également706 tests/30 suites, TypeScript, ESLint et codegen iOS.

## Notes TestFlight fr-CA

PocketTTS utilise maintenant Estelle, la voix française incluse dans le pack. Aucun WAV, nom ou document de consentement à fournir. Le pack déjà importé reste compatible; la voix Estelle ne garantit pas un accent québécois.

Sur iPhone16Pro/iOS27.2, choisir FluidAudio · Parakeet Redux puis ouvrir le mode vocal. Tester trois échanges, une interruption et une reprise, puis un démarrage en mode Avion. Vérifier aussi le moteur Apple. Si le chargement échoue, ouvrir Détails audio et transmettre la capture avec l’étape et les codes. Ne pas supprimer ou réimporter le pack pour ce test.

## Notes TestFlight en-US

PocketTTS now uses Estelle, the French voice included in the model pack. No personal WAV, speaker name or consent document is required. Existing imported packs remain compatible. A Quebec accent is not guaranteed.

On iPhone16Pro/iOS27.2, select FluidAudio · Parakeet Redux and open voice mode. Test three turns, an interruption and recovery, then launch in Airplane Mode. Also check the Apple voice backend. If loading fails, open Audio details and send the stage and error codes. Keep the existing model pack for this test.
