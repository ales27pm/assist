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

## Résultat de la tentative autorisée

La seule build EAS créée dans cette autorisation est
[`18565fc4-de66-415e-8cd2-59887d3ef307`](https://expo.dev/accounts/ales27/projects/assist/builds/18565fc4-de66-415e-8cd2-59887d3ef307),
source `5091ee9e6555e9c57d4e4302cd10e45975509711`.
Elle termine `ERRORED / XCODE_BUILD_ERROR` le 18 octobre 2026 à 03:50:01 UTC.
Aucun IPA ni artefact dSYM téléchargeable n’est produit et aucune soumission
Apple n’est déclenchée. Une pré-vérification CLI antérieure s’était arrêtée
avant création à cause de la normalisation de la fin de ligne d’Expo.plist ;
le provider a été relu avant le lancement effectif pour exclure un doublon.

Xcode indique une collision entre la classe `FluidAudio.Tokenizer` et le
protocole `Tokenizers.Tokenizer` aux deux annotations de type d’AssistCoreAI.
L’import FluidAudio ajouté pour l’observateur rend le nom non qualifié ambigu.
Les contrôles locaux du bloc observateur isolé n’avaient pas compilé le moteur
Core AI complet et n’ont donc pas couvert cette collision de portée.
La correction qualifie explicitement les deux usages du protocole et ajoute
un test de non-régression, observé rouge avant modification des annotations.
Ce correctif n’annonce pas une nouvelle archive SDK27 réussie. Toute nouvelle
tentative payante attend un nouvel accord ; aucune seconde build n’est lancée.

Après correction, `npm run check` passe : TypeScript, ESLint, 758 tests dans
31 suites et Codegen. La revue des symboles publics FluidAudio ne trouve pas
d’autre collision concrète dans AssistCoreAI. GitHub Actions n’a pas exécuté
ses jobs : compte bloqué par un problème de facturation ; ce n’est pas une CI
verte. L’API Apple confirme l’absence de build27 au terme de cette tentative.

## Notes TestFlight fr-CA

Cette version ajoute des diagnostics vocaux natifs persistants, des contrôles de tenseurs et un nettoyage renforcé des sessions. Les futurs packs compatibles peuvent être signés puis importés sans reconstruire l’app, avec restauration du pack précédent. Les modèles actuels et le contexte32K restent inchangés. Tester trois échanges vocaux, une interruption pendant une réponse, pause/reprise et arrière-plan. En cas de fermeture, rouvrir puis exporter immédiatement la session précédente avant une autre relance. Les correctifs restent à qualifier sur iPhone ; la stabilité et l’exécution ANE ne sont pas encore démontrées.

## Notes TestFlight en-US

This version adds persistent native voice diagnostics, tensor checks and stronger session cleanup. Future compatible packs can be signed and imported without rebuilding the app, with rollback to the previous pack. Current models and the 32K context remain unchanged. Test three voice exchanges, interruption during a reply, pause/resume and backgrounding. If the app closes, reopen it and immediately export the previous session before another restart. These fixes still need iPhone qualification; voice stability and ANE execution are not yet established.
