# TestFlight 27 — hôte vocal et packs signés

## Candidat et autorisation

L’utilisateur autorise commit, fusion et push, puis **une seule build EAS27**.
Après l’échec initial documenté ci-dessous, il autorise explicitement une seule
nouvelle tentative et TestFlight uniquement si les contrôles passent.
La soumission attend dans les deux cas les contrôles de l’IPA signé et des dSYM.
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

## Résultat de la première tentative autorisée

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
Au terme de cette première tentative, ce correctif n’avait pas encore produit
une nouvelle archive SDK27. Aucune autre build n’a été lancée sans nouvel accord.

Après correction, `npm run check` passe : TypeScript, ESLint, 758 tests dans
31 suites et Codegen. La revue des symboles publics FluidAudio ne trouve pas
d’autre collision concrète dans AssistCoreAI. GitHub Actions n’a pas exécuté
ses jobs : compte bloqué par un problème de facturation ; ce n’est pas une CI
verte. L’API Apple confirme l’absence de build27 au terme de cette tentative.

## Nouvelle tentative autorisée et livraison vérifiée

La nouvelle autorisation est utilisée pour une seule build supplémentaire :
[`2a6f86ae-e99c-4e45-9bcf-9588127d673d`](https://expo.dev/accounts/ales27/projects/assist/builds/2a6f86ae-e99c-4e45-9bcf-9588127d673d),
source `c3da00d41cd210ce71a249fdc4bb2d85c697332e`.
EAS termine `FINISHED` le 18 octobre 2026 à 04:05:08.920 UTC ; le vrai journal
Xcode contient `ARCHIVE SUCCEEDED` et le hook a conservé l’artefact dSYM.

Les vérifications de l’IPA et du ZIP dSYM réels passent sur la VM Mac :
`codesign --verify --deep --strict`, UUID ARM64 identiques entre l’exécutable,
le DWARF et le manifeste, SHA-256 du DWARF et identité source/EAS concordants.
Le bundle est `org.27pm.assist`, version `1.0.0` (`27`), runtime
`1.0.0-native27`, canal `testflight`, avec neuf descriptions d’usage,
`ITSAppUsesNonExemptEncryption=false` et un manifeste de confidentialité
déclarant aucune collecte ni tracking. Les ressources manifestes/attributions embarquées
correspondent aux sources. Les hashes des fichiers transférés sur Mac sont
identiques aux téléchargements locaux ; une vérification Linux seule n’aurait
pas autorisé la soumission.

| Artefact | Identité vérifiée |
| --- | --- |
| IPA, 22 496 253 octets | SHA-256 `65b42bcec2b823b6fb3329ea32780f13584c646857f50367bcf69581f34cbfd5` |
| ZIP dSYM, 23 336 693 octets | SHA-256 `04e605b946add5558c0c93ba1b74dbddec98f49c23bdf92cda80fd6becfcb8a8` |
| DWARF Assist | SHA-256 `c2102ef39d87afabb2eaccb62ca6abe66cf760732132dcb43066672a01e3001f` |
| Exécutable et dSYM ARM64 | UUID `9AA01AAD-124E-3E61-A172-67D84154EEF8` |

La soumission de ce build précis, sans `--latest` ni nouveau build automatique,
est [`3a4244bd-afa3-4797-bbe3-4f8f8b9ad6d5`](https://expo.dev/accounts/ales27/projects/assist/submissions/3a4244bd-afa3-4797-bbe3-4f8f8b9ad6d5),
statut EAS `FINISHED`. L’API Apple confirme le build
`9b011f9c-c538-41da-bd99-d849e5e3d20a` : `VALID`, non expiré,
`internalBuildState=IN_BETA_TESTING`. Téléversement Apple enregistré le
18 octobre 2026 à 04:11:52 UTC. Les notes `fr-CA` et `en-US` ci-dessous sont
publiées puis relues à l’identique via l’API. Observation finale :
18 octobre 2026, 04:14 UTC. L’état externe est `READY_FOR_BETA_SUBMISSION` :
pas de Beta App Review ni de diffusion externe annoncée.

Une copie permanente privée de l’IPA, du ZIP dSYM et des reçus est conservée
hors Git dans `~/.local/share/assist/releases/1.0.0-27-2a6f86ae/`.
Aucune clé privée de signature de packs n’est transférée ni embarquée.
Le checkout initial et ses modifications non liées sont conservés.

Le succès de l’archive et de la livraison ne démontre pas encore la correction
du crash sur iPhone, la stabilité vocale ni l’exécution ANE. Il reste à installer
ce binaire via TestFlight, tester les vrais modèles et exporter la session
précédente en cas de fermeture. Aucune autre build, OTA, installation sur le
téléphone ou modification de groupe externe n’est lancée par cette livraison.

## Notes TestFlight fr-CA

Cette version ajoute des diagnostics vocaux natifs persistants, des contrôles de tenseurs et un nettoyage renforcé des sessions. Les futurs packs compatibles peuvent être signés puis importés sans reconstruire l’app, avec restauration du pack précédent. Les modèles actuels et le contexte32K restent inchangés. Tester trois échanges vocaux, une interruption pendant une réponse, pause/reprise et arrière-plan. En cas de fermeture, rouvrir puis exporter immédiatement la session précédente avant une autre relance. Les correctifs restent à qualifier sur iPhone ; la stabilité et l’exécution ANE ne sont pas encore démontrées.

## Notes TestFlight en-US

This version adds persistent native voice diagnostics, tensor checks and stronger session cleanup. Future compatible packs can be signed and imported without rebuilding the app, with rollback to the previous pack. Current models and the 32K context remain unchanged. Test three voice exchanges, interruption during a reply, pause/resume and backgrounding. If the app closes, reopen it and immediately export the previous session before another restart. These fixes still need iPhone qualification; voice stability and ANE execution are not yet established.
