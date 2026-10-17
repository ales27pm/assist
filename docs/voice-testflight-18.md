# Assist 1.0.0 (18) — reconfigurations audio

## Signalement et correction

Le build17 livré montrait « En pause » avec une alerte de session audio interrompue avant la première transcription. Cette capture ne précise ni la notification native ni sa raison. Le défaut vérifié dans le code17 était de traiter toutes les notifications de route sauf categoryChange comme fatales, même si les périphériques et le graphe restaient utilisables. Une seconde erreur d’interface remplaçait l’état error par paused lors d’un changement d’activité.

Le candidat18 compare les identités I/O en mémoire, les formats du tap/graphe, l’état du moteur, VPIO et la configuration de session. Les notifications internes compatibles sont acceptées; un changement réel, une entrée absente ou une interruption système arrêtent toujours l’audio. La transition de catégorie réellement observée pendant l’activation possède un ledger privé limité à la génération. Les validations de construction empêchent une annulation réentrante de laisser démarrer un moteur orphelin.

Chaque reconfiguration acceptée renouvelle un contrôle de progression des buffers à1,5s; une ancienne minuterie ne peut valider une nouvelle route. Un réarmement du STT conserve le contrôle avec les nouveaux compteurs. Le silence est autorisé : le contrôle porte sur les frames reçues.

L’interface conserve « Mode vocal interrompu » après une erreur, sans reprise automatique. Détails audio expose uniquement8lignes bornées de400caractères sur demande : raisons, phases, types de ports, formats, santé et décisions. Aucun UID, nom d’accessoire, texte ou audio. L’annulation n’attend pas la lecture facultative des diagnostics; les retours tardifs ne peuvent annuler ni modifier le tour suivant.

## Source et vérification

- Candidat isolé : `/home/ales27pm/.local/share/assist-release-candidates/voice18`.
- Branche : `codex/voice-route-recovery-build-18`.
- Révision finale publiée : `c1d866d5f189722b66e62f2c15d29c7704a258ff` (base17 + deux commits du correctif).
-14fichiers dans le correctif, numéro Xcode18. Le workspace original et ses changements indépendants sont préservés pendant la construction.
- `npm run check` :522tests/22suites, TypeScript, ESLint et codegen réussis. Journal : `/tmp/assist-voice18-check-final.log`.
- Contrat statique8, démarrage iOS2 et vérification d’absence de Gemma embarqué réussis.
- Six sources Swift6 strict arm64-iOS27.1, SDK26.2 : typecheck réussi. Projet Xcode `plutil` valide.
- Bancs natifs synthétiques : duplex19, mesure8, file9, callbacks9+128frames+2pièges d’isolation attendus. Un contrôle négatif Intel VM a terminé132 comme attendu mais avec une backtrace non symbolisée; une relance unique a passé le matcher strict.
- Preuve native avec SHA exacts : `/tmp/assist-voice18-native-verification.json`.
- Revue croisée sans blocage vérifié;161tests ciblés repassés indépendamment.
- Archive source EAS finale inspectée :224fichiers,4 252 393octets; fichiers modifiés comparés exactement; aucun secret, journal, dépendance node_modules ou poids Gemma inclus.
- La première commande locale d’inspection a refusé un drapeau CLI non supporté avant tout effet; relance corrigée réussie.

Ces contrôles synthétiques ne démarrent pas de micro, de moteur audio réel, de Speech ou de TTS. Ils ne qualifient pas l’acoustique iPhone.

## Première tentative arrêtée avant archive

La revue tardive a trouvé un chemin de réentrée dans cancelCurrent : le flag de session audio restait actif pendant les appels d’arrêt alors que la baseline était déjà effacée. Une notification synchrone pouvait donc rappeler fail puis cancelCurrent. Le flag doit être retiré avant toute frontière framework, y compris player.stop et engine.stop.

La tentative EAS `dc50fab1-2d36-486f-aef0-1a3cfae946b9`, source `bdb008b97b481175eb3345930a3a96dad6e2f293`, a été explicitement annulée avant archive pendant INSTALL_PODS. EAS confirme CANCELED à2026-10-17T02:20:55.362Z et aucun artifact. Ses précontrôles natifs avaient passé, y compris les deux pièges d’isolation133, sans reprise. Aucune IPA ni soumission Apple issue de cette tentative.

Le numéro18 peut être conservé pour la tentative corrigée, aucune18 n’ayant été soumise à Apple. Nouvelle source, archive, IPA, soumission et disponibilité restent à confirmer.

## Essai iPhone requis

Après installation18 : fermer/rouvrir Assist, charger le modèle déjà importé, ouvrir Mode vocal et vérifier « À ton écoute » avec réception audio. Faire trois échanges consécutifs puis dire « Non, attends » pendant une réponse. Vérifier début de transcription conservé, arrêt audible et absence de reprise de l’ancienne phrase. Tester pause/reprise et arrière-plan sans reprise implicite. En cas d’erreur inattendue, ouvrir Détails audio et conserver cet écran.

La raison exacte du signalement17, les vraies routes/périphériques, l’écho, les interruptions, la latence, la thermique et le fonctionnement hors réseau restent à qualifier sur l’iPhone. Aucun nouveau modèle vocal ni service distant ajouté.

## Tentative finale en cours

Build EAS final18 : `dadf65ba-ee1e-45a5-bf67-75623ec85b7c`, source exacte `c1d866d5f189722b66e62f2c15d29c7704a258ff`. Branche distante et candidate propre vérifiées. Le typecheck des six Swift et les19contrôles duplex ont été refaits après correction du teardown; les autres contrôles natifs inchangés conservent leur preuve précédente et repassent dans le pré-install EAS.

Le workspace reçoit parallèlement des changements indépendants de sélection du modèle et d’accessibilité. Ils ne sont pas inclus dans cette archive isolée et ne seront pas écrasés lors du report du correctif vocal.

## Archive finale et IPA vérifiées

EAS final FINISHED à2026-10-17T02:27:49.448Z; **ARCHIVE SUCCEEDED** présent dans le journal Xcode SDK27.1. Tous les précontrôles natifs ont repassé sur EAS, y compris les deux pièges d’isolation133 dès leur premier passage et les19contrôles duplex, dont les nouvelles notifications synchrones pendant teardown.

IPA :12 451 459octets; SHA256 `19ffadb9255f8979a62577943c3c1888f6f9a6e2459f5f58156b3866d36445c4`; UUIDarm64 `C5B91910-3DEF-3543-967F-BE5B6150279D`. Bundle/version1.0.0 (18), minimum27.1, permissions micro/Speech et chiffrement nonexemptfalse vérifiés. Pas de poids Gemma. Signature CMS du profil vérifiée sans chaîne de confiance; présence structurelle de signature Mach-O et concordance des entitlements inspectées. Chaîne Apple et hashes cryptographiques de la signature exécutable non validés ici. Preuve : `/tmp/assist-voice18-ipa-verification.json`.

Soumission de cette seule IPA finale à Apple en cours. Aucun artifact de la tentative annulée n’a été soumis.

## Soumission finale

EAS submission `33a880fa-bcb3-4629-9245-c2576a2af894` confirme FINISHED à2026-10-17T02:30:39.688Z. La relation pointe exactement vers la tentative finale `dadf65ba-ee1e-45a5-bf67-75623ec85b7c`, build18. Traitement et disponibilité Apple encore à vérifier.
