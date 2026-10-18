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

## Notes TestFlight fr-CA

Ajout des outils iOS dans la conversation, désactivés par défaut. Chaque accès et modification exige un aperçu et une confirmation tactile; les autorisations iOS restent séparées. Photo et caméra peuvent extraire du texte avec l’OCR Apple local; Gemma reçoit le texte reconnu, pas l’image. Tester calendrier, rappels avec échéance, refus de permission, double toucher, annulation et arrière-plan. Tester une photo tournée, une image sans texte et un document long. Vérifier les valeurs reconnues : l’OCR peut se tromper. Une action au résultat incertain ne doit pas être recréée automatiquement. Modèles et packs actuels inchangés. Fonctionnement et performances à qualifier sur iPhone.

## Notes TestFlight en-US

Adds iOS tools in conversation, disabled by default. Each access or change requires a native preview and tactile confirmation; iOS permissions remain separate. Photo selection and camera capture can extract text with local Apple OCR; Gemma receives recognized text, not the image. Test calendar, reminders with due dates, permission denial, double taps, cancellation and backgrounding. Test rotated images, images without text and long documents. Check recognized values because OCR can make mistakes. Never automatically repeat an action whose outcome is uncertain. Current models and voice packs are unchanged. Device behavior and performance still require iPhone qualification.
