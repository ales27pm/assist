# TestFlight 27 — hôte vocal et packs signés

## Candidat et autorisation

L’utilisateur autorise commit, fusion et push, puis **une seule build EAS27**.
La soumission TestFlight attend les contrôles de l’IPA signé et des dSYM.
Le candidat utilise `org.27pm.assist`, version `1.0.0` (`27`), runtime
`1.0.0-native27`, profil et canal `testflight`, distribution App Store.
Ce document décrit initialement le candidat ; les résultats de livraison sont
ajoutés après observation, jamais déduits de cette autorisation.

Le [lot local et ses limites](stable-model-host-validation.md) couvre les
retraits de sessions Pocket, les contrats de tenseurs, les repères de prédiction
persistants et les [packs versionnés signés](versioned-voice-packs.md).
Les poids actuels, leur précision, les placements par défaut et le contexte32K
ne sont pas réduits. Gemma et les packs restent des imports locaux complets,
sans téléchargement de modèles déclenché par une commande vocale.

Le rapport de crash26 reste une exception Core ML sans motif détaillé. Les
régressions locales corrigées ne constituent pas encore une preuve de correction
sur iPhone. Ce binaire est un candidat de qualification, pas une annonce de
stabilité vocale acquise ou d’exécution ANE démontrée.

## Contrôles avant soumission

Contrôler séparément le statut final EAS, la révision source, la version, les
permissions et l’exemption de chiffrement dans Info.plist, le runtime et le
canal Expo, les signatures du bundle, l’UUID ARM64 de l’exécutable et sa
concordance avec le dSYM conservé. Vérifier aussi le SHA-256 du DWARF et
l’identité source dans `symbol-identity.json`. Refuser la soumission si un
artefact est absent, ambigu ou incohérent. Pas de soumission automatique à la
fin de la compilation, pas de seconde build sans nouvel accord.

## Notes TestFlight fr-CA

Cette version ajoute des diagnostics vocaux natifs persistants, des contrôles de tenseurs et un nettoyage renforcé des sessions. Les futurs packs compatibles peuvent être signés puis importés sans reconstruire l’app, avec restauration du pack précédent. Les modèles actuels et le contexte32K restent inchangés. Tester trois échanges vocaux, une interruption pendant une réponse, pause/reprise et arrière-plan. En cas de fermeture, rouvrir puis exporter immédiatement la session précédente avant une autre relance. Les correctifs restent à qualifier sur iPhone ; la stabilité et l’exécution ANE ne sont pas encore démontrées.

## Notes TestFlight en-US

This version adds persistent native voice diagnostics, tensor checks and stronger session cleanup. Future compatible packs can be signed and imported without rebuilding the app, with rollback to the previous pack. Current models and the 32K context remain unchanged. Test three voice exchanges, interruption during a reply, pause/resume and backgrounding. If the app closes, reopen it and immediately export the previous session before another restart. These fixes still need iPhone qualification; voice stability and ANE execution are not yet established.
