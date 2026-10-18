# TestFlight 28 — outils confirmés et OCR Apple

## Autorisation et candidat

Le 18 octobre 2026, l’utilisateur demande « Deploy » après l’implémentation des
treize outils conversationnels et de l’OCR natif. Cette livraison prépare une
seule build EAS 28, profil/canal `testflight`, distribution App Store, version
`1.0.0`, runtime `1.0.0-native28`. Pas d’OTA vers native27, de diffusion externe,
de publication App Store, d’installation sur le téléphone ni de seconde build
automatique. L’ancien build reste disponible.

Le candidat est figé sur la branche isolée `feature/gemma-calendar-readonly`,
basée sur `6a26dcf27042d73833d8ce5b51178bdeb5f17562`. Le checkout principal sale
et les travaux TTS indépendants sont conservés. Un commit local est nécessaire
au contrat EAS `requireCommit:true`; aucun push ou merge n’est nécessaire à
cette livraison par archive locale.

Gemma et les packs vocaux restent des imports locaux; aucun poids, clé privée
de pack, conversation ou fichier de l’iPhone n’est envoyé. Le modèle actuel,
le contexte et le STT/TTS ne sont pas remplacés.

## Préparation locale et normalisation

Le premier lancement CLI s’est arrêté avant création d’une build : après la
préparation des identifiants existants, la configuration native avait changé
et le contrat Git propre a refusé de continuer. La liste EAS28 et l’API Apple28
sont vides; aucun ID EAS28 n’a été créé par ce lancement.

Cause vérifiée : les dépendances mobiles n’étaient plus résolues localement,
donc EAS utilisait son ancien plugin de synchronisation au lieu de la CLI
`expo-updates` du projet. Les dépendances épinglées existantes sont reliées dans
un dossier ignoré, sans installation ni changement de lockfile. La CLI native
du projet est de nouveau détectée. Sa sérialisation est appliquée puis figée :
ordre XML et fin de fichier normalisés, runtime28 et support BSDiff conservés.
Un contrôle de non-régression protège ce dernier réglage. Cette préparation
ne constitue pas une seconde build distante.

## Contrôles de publication

Avant création : vérifier qu’aucune build28 n’existe déjà, figer les sources,
rejouer les tests et inspecter la véritable archive EAS. Le profil autorise
l’absence de modèle embarqué et conserve les ressources/ABI de la build27.

Avant soumission : attendre `FINISHED`, contrôler le journal `ARCHIVE SUCCEEDED`,
télécharger l’IPA et les symboles du même ID EAS, vérifier sur Mac la signature,
les métadonnées du bundle et les UUID ARM64 identiques exécutable/dSYM/manifeste.
Vérifier aussi SHA-256 du DWARF, hash Git source, runtime28, canal testflight,
permissions, manifeste de confidentialité et exemption de chiffrement.
Ne soumettre que cet ID exact, sans `--latest`, auto-build ou configuration
automatique de groupe TestFlight.

Après soumission : distinguer le reçu EAS de la présence chez Apple, de l’état
de traitement et de la disponibilité TestFlight interne. Lire à nouveau les
notes de test `fr-CA` et `en-US` après leur enregistrement.

La réception iPhone reste distincte : choix d’outil réel par Gemma, permissions,
sélecteur/caméra, OCR, annulation, interruption vocale et mémoire ne sont pas
prouvés par l’archive signée ou les tests synthétiques.

## Livraison vérifiée — 18 octobre 2026

- Source binaire : `145b5f51c11b88bef7fd58263cee8f9c4bcba16b`.
- Build EAS unique : `5442da69-aae4-4ec2-8fdf-526d60dea57b`, `FINISHED`
  le 18 octobre à 08:16:48 UTC; journal Xcode `ARCHIVE SUCCEEDED`.
- [Archive EAS](https://expo.dev/accounts/ales27/projects/assist/builds/5442da69-aae4-4ec2-8fdf-526d60dea57b).
- Vérification Mac de l’IPA et du dSYM : 44 contrôles positifs, aucune erreur;
  signature stricte, identité, runtime/canal, neuf usages iOS, attributions,
  ressources/confiance des packs vocaux et exemption de chiffrement vérifiés.
- Le manifeste de confidentialité compilé est l’union exacte du candidat et
  des dépendances embarquées, pas une copie brute du XML source. Les ajouts
  proviennent d’ExpoFileSystem; tracking reste faux et collecte déclarée vide.
  Une seconde lecture indépendante confirme cette agrégation.
- Soumission exacte : `caa43bd7-44ad-488f-ab39-d7375d103b86`, `FINISHED`
  à 08:24:53 UTC, sans nouvelle build ou groupe automatique.
- Apple build : `c919f607-c014-461e-910d-e782167b80d9`; état `VALID`,
  non expirée, TestFlight interne `IN_BETA_TESTING`, vérifié à 08:25:27 UTC.
  L’état externe reste `READY_FOR_BETA_SUBMISSION` : aucune diffusion externe
  ou publication App Store effectuée.
- Notes `fr-CA` et `en-US` enregistrées puis relues à l’identique.
- Contrôles locaux frais : 1 253 tests / 39 suites, TypeScript, ESLint et
  Codegen réussis. Le runner iOS a également exécuté les contrôles des
  13 schémas fermés, 38 cas de boucle d’outils et 43 cas de journal/permis.

Identité des artefacts acceptés :

```text
IPA SHA-256      bb4397a3b7ea0fcdefec2082083a29592c1ce724825c7984583e36f5c7d87083
Symboles SHA-256 4c742c50b2e0881bbbd3ab637b74f1d3cf30e4c0c8d549329d09eb569fcf88fa
DWARF SHA-256    a8ef8e974ac39a66bb821d0bff4716b040c705c9bfee4828f3ffa652ab0a78b9
UUID arm64      961E8544-FA9A-34EF-BEFF-E6C5EDD42094
```

IPA, symboles et preuves privées sont conservés hors Git dans
`/home/ales27pm/.local/share/assist/releases/1.0.0-28-5442da69/`.
Le checkout principal et ses modifications indépendantes restent inchangés.
Aucun push/merge ni installation/qualification iPhone effectué.

## Notes TestFlight fr-CA

Ajout des outils iOS dans la conversation, désactivés par défaut. Chaque accès et modification exige un aperçu et une confirmation tactile; les autorisations iOS restent séparées. Photo et caméra peuvent extraire du texte avec l’OCR Apple local; Gemma reçoit le texte reconnu, pas l’image. Tester calendrier, rappels avec échéance, refus de permission, double toucher, annulation et arrière-plan. Tester une photo tournée, une image sans texte et un document long. Vérifier les valeurs reconnues : l’OCR peut se tromper. Une action au résultat incertain ne doit pas être recréée automatiquement. Modèles et packs actuels inchangés. Fonctionnement et performances à qualifier sur iPhone.

## Notes TestFlight en-US

Adds iOS tools in conversation, disabled by default. Each access or change requires a native preview and tactile confirmation; iOS permissions remain separate. Photo selection and camera capture can extract text with local Apple OCR; Gemma receives recognized text, not the image. Test calendar, reminders with due dates, permission denial, double taps, cancellation and backgrounding. Test rotated images, images without text and long documents. Check recognized values because OCR can make mistakes. Never automatically repeat an action whose outcome is uncertain. Current models and voice packs are unchanged. Device behavior and performance still require iPhone qualification.
