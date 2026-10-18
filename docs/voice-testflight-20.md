# Assist 1.0.0 (20) — comparatif local des voix fr-CA

## Périmètre et source

La référence fonctionnelle reste le build 19, confirmé par l’utilisateur avec
son rapport natif iOS 27.2. Cette tranche ajoute le comparatif décrit dans
[voice-comparison.md](voice-comparison.md) : voix fr-CA disponibles, écoute avec
noms masqués, cinq phrases entières ou segmentées, avis partageables et choix
persistant pour les prochaines réponses vocales. Aucun moteur lourd ajouté.

Le synthétiseur d’aperçu fonctionne en lecture seule, sans microphone ni STT,
avec arrêt ciblé et protection des sessions. Le graphe duplex du build 19 reste
inchangé. Le catalogue applique une politique conservatrice Apple/fr-CA et
exclut les voix personnelles et fantaisie; la qualification hors réseau par voix
reste nécessaire. Les rapports distinguent écoute aveugle et notation après
révélation. Les notes d’un essai interrompu ne deviennent pas un essai terminé.

Candidat isolé : `/home/ales27pm/.local/share/assist-release-candidates/voice20`,
branche `codex/voice-comparison-build-20`, révision
`d0c4f33b2ead76d66cb48db3d86890845e18442e` publiée. Vingt fichiers modifiés
depuis la source livrée du build 19. Les modifications indépendantes UI/modèle
du workspace original ne sont pas incluses; le pont garde son comportement
modèle du build 19 et Réglages reçoit uniquement l’entrée et le focus du
comparatif. La branche et l’index originaux restent inchangés.

## Vérifications avant compilation

- Copie de livraison : `npm run check` réussi, **633 tests / 25 suites**,
  TypeScript, ESLint et génération iOS. Preuve :
  `/tmp/assist-voice20-candidate-check.log`.
- Workspace original intégré : même commande réussie, **667 tests / 28 suites**,
  incluant les travaux UI indépendants préexistants. Preuve :
  `/tmp/assist-voice-comparison-final-check.log`.
- Les quatre méthodes et arités correspondent à l’en-tête codegen généré et aux
  sélecteurs Objective-C++. La compilation du pont complet reste celle de
  l’archive EAS, distincte de cette inspection.
- Six sources Swift : typecheck Swift 6 strict arm64-iOS27.1 sur SDK26.2 réussi.
  Six groupes de contrats Swift exécutables réussis : politique de voix,
  limites, sélection/repli, segments UTF-8, annulation/identités et résultat JSON.
  Le script durable `check-speech-voices.sh`, branché au préinstall EAS, compile
  les helpers de production extraits du même fichier, sans audio ni permission.
  Il refuse aussi les marqueurs absents, doublés ou inversés. Preuve :
  `/tmp/assist-speech-voices-evidence/verification.json`.
- Contrat local : **8 contrôles** réussis; démarrage : **2 contrôles** réussis;
  absence de Gemma embarqué confirmée. La garde statique de dialecte suit
  maintenant la politique partagée, avec refus `fr-FR` également exécuté en Swift.
- Les régressions couvrent sauvegarde confirmée, retours tardifs, arrêt ciblé,
  fermeture après refus de lecture et fin naturelle en course avec l’arrêt.
  Le refus natif terminal libère l’aperçu; un JSON terminal invalide impose
  encore un arrêt confirmé. Le test reveal → notation marque correctement les
  notes faites noms connus. Revue indépendante sans blocage concret restant.
- L’aperçu web compile. L’inspection visuelle via CUA a échoué sur la méthode
  navigateur `Target.getTargetInfo`; aucun résultat visuel n’en est déduit.
  Les fixtures explicitement simulées ont été retirées et l’onglet Expo rétabli.
- Archive source inspectée : **233 fichiers / 4 363 020 octets**; les 13 fichiers
  runtime/config/harness contrôlés correspondent exactement au candidat.
  Dépendances, secrets et poids Gemma sont exclus. Le lien temporaire de
  dépendances a été retiré avant gel. Preuve :
  `/tmp/assist-voice20-source-inspection.json`.

Le premier contrôle global a rencontré les régressions en cours d’écriture du
hook; le suivant a détecté l’attente de préinstall devenue incomplète après
ajout du nouveau harness. Les mécanismes et tests ont été corrigés, puis les
contrôles complets ci-dessus ont passé sur les sources finales. Le contrôle
statique de dialecte a également été adapté à la politique factorisée, sans
relâcher l’exigence fr-CA.

## Livraison en cours

Une seule compilation 20 demandée, avec les identifiants de signature existants
figés : [build EAS](https://expo.dev/accounts/ales27/projects/assist/builds/e3c0defd-96ee-4772-9da2-7a7e18827aeb),
source exacte `d0c4f33b2ead76d66cb48db3d86890845e18442e`, profil `testflight`.
Le contrôle initial ne trouvait aucune compilation 20 existante. Archive, IPA,
soumission, notes Apple et disponibilité TestFlight restent à confirmer.

Le préinstall a passé sur EAS : contrôles callbacks, mesure micro, file de
lecture, 24 contrats duplex et six groupes du nouveau comparatif. Les deux
moteurs du banc duplex utilisent le rendu manuel hors ligne; aucun microphone,
sortie matérielle ou aperçu TTS réel n’est testé par ces scripts. Le build est
entré dans `RUN_FASTLANE` sans erreur d’archive observée à cette étape.

## Archive et IPA

EAS confirme `FINISHED` à `2026-10-17T03:50:51.419Z`; le journal Xcode complet
contient `** ARCHIVE SUCCEEDED **`. Les suites du préinstall ont passé sur
l’image SDK27.1. Preuves : `/tmp/assist-voice20-build-live.json` et
`/tmp/assist-voice20-xcode.log`.

IPA : **12 509 051 octets**, SHA-256
`96e5b3d3178a974c7ec4008760310b2b0617615e5dd271c3fac7928f6035c1da`, UUID arm64
`7DD97EF6-38B5-3E2B-97E5-3E32B4DE46EC`. Bundle attendu, version 1.0.0 (20),
minimum iOS 27.1, descriptions micro/Speech, chiffrement non exempt déclaré
faux et absence de Gemma vérifiés. Le bundle JavaScript contient les nouveaux
champs et méthodes du comparatif; les quatre sélecteurs natifs sont présents.

La signature CMS du profil est vérifiée avec son certificat inclus, sans
validation de la chaîne Apple. La signature Mach-O et les entitlements de
distribution concordants sont inspectés structurellement; les hashes de la
signature exécutable ne sont pas vérifiés cryptographiquement ici. Preuve :
`/tmp/assist-voice20-ipa-verification.json`. Cela ne constitue pas un essai audio
ou une preuve d’installation.

L’appel initial de soumission avec `--json` a été refusé par le parseur local
du CLI avant toute soumission. La commande corrigée utilise la sortie standard
et vise le même build exact; aucune relance de compilation n’a été demandée.

## Livraison finale confirmée

La soumission [93a8f048-5500-4ad7-91d6-4a552b430ebc](https://expo.dev/accounts/ales27/projects/assist/submissions/93a8f048-5500-4ad7-91d6-4a552b430ebc)
est `FINISHED` et référence exactement le build
`e3c0defd-96ee-4772-9da2-7a7e18827aeb`. Apple confirme **1.0.0 (20), VALID /
IN_BETA_TESTING**, non expiré, chiffrement non exempt faux; date d’envoi Apple
`2026-10-16T21:03:04-07:00`. L’état externe est `READY_FOR_BETA_SUBMISSION`;
aucune invitation, association de groupe ou Beta App Review externe lancée.
L’écriture initiale des notes a reçu un refus Apple `409 ATTRIBUTE.UNKNOWN` :
le libellé « What to Test » avait été utilisé comme attribut `whatToTest` au
lieu de l’attribut API `whatsNew`. Après lecture fraîche des localisations,
le champ a été corrigé; les notes **fr-CA et en-US sont écrites et relues
exactement**. La disponibilité Apple demeure `VALID / IN_BETA_TESTING`.
Preuves : `/tmp/assist-voice20-submission-live.json` et
`/tmp/assist-voice20-asc-notes.json`.

Le workspace original conserve tous ses travaux indépendants, sa branche et
son index. Ses deux réglages de build Xcode passent de 19 à 20 après garde du
hash initial, sans altérer les références ModelDirectoryBookmark préexistantes.
Le candidat livré reste propre et publié à la révision gelée ci-dessus.
La disponibilité interne ne constitue pas une preuve d’installation ou de
qualité auditive; les essais ci-dessous restent requis sur l’iPhone.

## Essai requis après installation

Ouvrir Réglages → Voix de l’assistant, écouter les cinq phrases entières puis
segmentées et noter avant révélation. Choisir une voix, relancer et vérifier sa
lecture dans trois vrais tours du mode vocal. Tester arrêt/fermeture pendant
aperçu, interruption vocale et retour au comparatif. Refaire avec les voix
préparées en mode Avion; vérifier petit écran, texte agrandi et VoiceOver.

L’écoute réelle, l’accent québécois perçu, la persistance après relance sur
iPhone, l’arrêt audible et l’absence de trafic ne sont pas établis par les
vérifications logicielles. Aucun score auditif ou gain de latence n’est annoncé.
