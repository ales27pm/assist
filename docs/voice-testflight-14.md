# Assist 1.0.0 (14) — livraison et qualification vocale

Rapport opérationnel local; ne pas publier automatiquement dans le dépôt public.

## État

- Candidat : `15d27f502cc4f95834b229196e31b392ebfef850`, branche `codex/local-voice-build-14`.
- Base : build 13 payé, `232327c12ea623042ae0e018c7d1b3eab8de058d`.
- Copie isolée : `/home/ales27pm/.local/share/assist-release-candidates/voice14`.
- EAS : [build 14](https://expo.dev/accounts/ales27/projects/assist/builds/2b855f9e-cf64-4d99-aab9-b7309c46f196), profil `testflight`, compte `ales27` Starter vérifié.
- Demande créée une seule fois; EAS FINISHED, soumission FINISHED et Apple VALID / IN_BETA_TESTING vérifiés.
- Le checkout original reste volontairement sale, avec ses changements antérieurs préservés. Aucun modèle ni secret n'est commité.

## Changements

- Contrôle « Lire les réponses » sur sa propre ligne.
- Lecture progressive des instantanés Gemma par segments, file native identifiée par UUID de génération/énoncé et fermeture explicite après EOS.
- Annulation de tous les segments restants quand la lecture est arrêtée, remplacée ou désactivée.
- Politique de session audio commune lecture/dictée après permission micro; écoute toujours fermée pendant TTS. Les utilisateurs lecture seule n'ont pas de nouvelle demande micro.
- Niveau micro borné et diagnostics agrégés : buffers, frames, format, type de route, délai, niveaux et code/domaine d'erreur. Aucun PCM ni transcription conservé dans les diagnostics.
- Toujours dictée → brouillon → envoi manuel. Aucun EOT automatique, barge-in vocal, AEC ou nouveau moteur lourd.

## Preuves préalables à EAS

- `npm run check` : 17 suites, **347 tests PASS**, typecheck, lint et codegen. `/tmp/assist-voice14-check-final.log`.
- Contrat statique : 8 tests PASS; aucune compilation Swift déduite de ces contrôles Python.
- 4 sources voix : Swift 6 strict, arm64 iOS 27.1, SDK 26.2 typecheck PASS. État exact fraîchement contrôlé dans `/tmp/assist-voice-integrated-check.json`.
- Harness VM : 8 cas PCM et 9 cas file TTS PASS. Callbacks 9 positifs + 2 négatifs PASS au second lancement; premier échec de symbolisation de backtrace sur Intel, sans modification entre tentatives.
- Revue indépendante en lecture seule : aucun blocage concret; fichiers Xcode et bridge concordants.
- Archive source EAS inspectée : 211 fichiers, 4 012 541 octets, aucun node_modules, clé, profil, IPA, crash/log privé ou rapport opérationnel. Ce contrôle ne concerne pas encore l'IPA signé.

## Preuve physique disponible et limites

L'utilisateur a confirmé sur le build 13 une dictée après relance, avant toute lecture, le remplissage du brouillon, un envoi manuel et une réponse écrite. Une lecture avait aussi fonctionné séparément. L'échec après lecture n'est pas encore reproduit ni expliqué de manière certaine. La nouvelle politique audio est une correction candidate à tester, pas une réparation acoustique prouvée.

La build 14 doit confirmer : lecture avant EOS, ordre sans répétition, contrôle visible après plusieurs échanges, nouvelle dictée après lecture complète/interrompue, annulation sans reprise, arrière-plan, parcours hors réseau après installation des assets. Pas de mesure de latence, accent, thermique ou réseau disponible à ce stade.

## Fichiers de preuve

- Demande EAS : `/tmp/assist-paid-voice14-build-request.log` (privé).
- Suivi EAS : `/tmp/assist-paid-voice14-status.json`, `/tmp/assist-paid-voice14-watch.log` (privés).
- Notes proposées : `/tmp/assist-voice14-notes-fr.txt`, `/tmp/assist-voice14-notes-en.txt`.
- Rapport précédent : [build 13](voice-testflight-13.md).

## Contrôles natifs EAS effectivement exécutés

Sur le serveur Apple Silicon du build 14, le pré-install a réussi :
9 callbacks positifs, 128 frames ordonnées, 2 contrôles négatifs d'isolation
piégés comme prévu (exit 133), 8 cas de mesure PCM et 9 cas de file TTS.
Ces essais synthétiques n'ouvrent pas le microphone et ne synthétisent pas de son.

## Archive signée vérifiée

- EAS `FINISHED`, source exacte du candidat, `** ARCHIVE SUCCEEDED **` dans le log.
- IPA `/tmp/assist-voice-build14.ipa` : 12 332 757 octets.
- SHA-256 : `65f44d7261df51fd316bea72f1264e18fb678050c55774e7fc697090bc8e9bb9`.
- Mach-O arm64 UUID : `24FE789A-CF0E-3FC8-A7E8-D149DE74BDE9`.
- Bundle/version/build/minimum OS et descriptions micro/Speech conformes; déclaration de chiffrement non exempt false.
- CodeResources, signature CMS de profil, présence de signature Mach-O et concordance des entitlements de distribution vérifiées. `get-task-allow=false`, `beta-reports-active=true`.
- Pas de poids Gemma ni paquet ML dans l'IPA; le modèle déjà importé reste nécessaire.
- Limites de l'inspection : chaîne de confiance Apple et hashes complets de code non validés cryptographiquement. Aucune preuve d'installation, lancement ou audio par l'IPA seule.
- Résultat : `/tmp/assist-voice14-ipa-verification.json`.

La soumission EAS exacte a été demandée une seule fois avec `--no-auto-testflight-setup`; acceptation Apple confirmée ci-dessous.

## Livraison finale confirmée

- Soumission EAS `7b101bf4-90e8-4367-882c-6d8afd31e21a` : `FINISHED`, build reliée exacte 14, terminée le 17 octobre 2026 à 00:10:10 UTC (16 octobre au Québec).
- Apple : `1.0.0 (14)`, `VALID`, `IN_BETA_TESTING`, non expiré, chiffrement non exempt false. État externe `READY_FOR_BETA_SUBMISSION`; aucune revue externe ni invitation lancée.
- Notes fr-CA et en-US créées puis relues à l'identique. Résultat : `/tmp/assist-paid-build14-asc-final.json`.
- SDK dans l'IPA : `iphoneos27.1`, Xcode `2710`, build Xcode `27A9275`.
- Le numéro local Xcode a été synchronisé à 14 après confirmation de disponibilité.
- Aucune qualification acoustique de la build 14 sur iPhone n'est encore établie. La prochaine validation utilisateur porte sur les enchaînements lecture/dictée et la lecture avant fin de génération.
