# Assist 1.0.0 (15) — interface et états vocaux

Rapport opérationnel local; ne pas copier automatiquement dans le dépôt public.

## Candidat et portée

- Source : `0559d7b1e38815d0e938be4fad0dfbd8f44045ad`, branche `codex/voice-ui-build-15`.
- Base exacte : build 14 `15d27f502cc4f95834b229196e31b392ebfef850`.
- Copie isolée : `/home/ales27pm/.local/share/assist-release-candidates/voice15`.
- [EAS 15](https://expo.dev/accounts/ales27/projects/assist/builds/56e64da2-ce6a-47c7-9b9f-6b56241eb5b3), compte `ales27` Starter confirmé, profil testflight.
- Créé une seule fois; archive EAS FINISHED, soumission FINISHED, Apple VALID / IN_BETA_TESTING confirmés.
- Quatre fichiers livrés : VoiceControls, ses dix tests de composant, documentation publique et numéro Xcode15. Aucun changement du natif vocal, du hook, des modèles ou des commandes automatiques.

## Amélioration visible

Bandeau état/aide avant les commandes, action utile mise en évidence, arrêt propre sans bouton Annuler la dictée trompeur, réglage de lecture toujours rendu sur sa propre ligne et disabled accessible explicite. La jauge reste consultable séparément du bandeau; aucune annonce vocale de niveau n'a été ajoutée. Erreurs utiles conservées, diagnostic replié.

FreakUI est une bibliothèque SwiftUI et n'est pas une dépendance de cette app React Native. Les instructions de sélection sémantique ont été examinées; l'implémentation utilise les composants existants et les trois thèmes. Building React Native Apps et Testing React Native Apps ont guidé le contrôle de portée et les tests RNTL13.3. Aucune optimisation de performance n'est revendiquée sans profilage.

## Vérification

- Rouge préalable : 8 des 9 premiers nouveaux tests échouaient sur les états absents; le montage fonctionnait. Test supplémentaire busy+erreur ensuite ajouté après revue.
- `npm run check` : **18 suites, 357 tests PASS**, TypeScript, ESLint et codegen. `/tmp/assist-voice-ui-check-final.log`.
- Tests ciblés antérieurs : 3 suites, 29 tests PASS; ne remplacent pas le check intégré final.
- Deux revues indépendantes en lecture seule : aucun blocage concret. Une incohérence busy+erreur a été corrigée et couverte.
- Banc visuel simulé : **72 combinaisons** de huit états, trois thèmes, largeurs 320/375/430; aucun débordement horizontal ou contrôle hors largeur. Parcours de commandes simulé PASS, zéro erreur JS dans le contrôle final.
- Deux premières tentatives de navigation répétée du banc ont expiré lors du chargement d'un scénario. Le scénario isolé a passé quatre fois; le contrôle final change les scénarios dans une page React montée. La cause du délai initial n'est pas attribuée au produit.
- Texte web agrandi 1,5× : pas de débordement horizontal. Page de 568 px de haut devenue 822 px avec l'en-tête du banc; cela n'est ni une simulation native de Dynamic Type ni une preuve de visibilité sous clavier.
- Preuves : `/tmp/assist-voice-ui-layout-results.json`, `/tmp/assist-voice-ui-after.png`, `/tmp/assist-voice-ui-idle.png`, `/tmp/assist-voice-ui-speaking.png`, `/tmp/assist-voice-ui-enlarged.png`. Ces images sont marquées simulées; aucun micro ni moteur n'y tourne.
- Fixtures temporaires retirées; aperçu réel et données utilisateur préservés.
- Pas de `agent-device` local, pas de périphérique adb connecté; XcodeBuildMCP list_sims échoue car xcrun absent. Aucun résultat natif déduit de l'hôte Linux. Pas de modification de la VM ou du téléphone.
- Inspection source EAS : 212 fichiers,4 028 107 octets; ni secrets, profils, IPA, logs/crash, rapports privés, node_modules ou fixtures de revue.

## À valider sur iPhone

États successifs, lecture→dictée sans relance, arrêt→reprise, visibilité réelle du contrôle sous clavier, Dynamic Type et VoiceOver, puis scénario hors réseau après installation des assets. Aucune latence audio ou amélioration d'accent n'est mesurée par ce lot. La pile locale et le français québécois restent l'objectif du dossier; Parakeet/PocketTTS, EOT et barge-in attendent leurs propres intégrations et mesures.

## Pré-install EAS 15

Contrôles frais sur le serveur Apple Silicon : neuf callbacks positifs,
128 frames ordonnées, deux pièges d'isolation attendus exit 133, huit cas de mesure
PCM et neuf cas de file TTS, tous PASS. Aucun microphone ni synthèse réelle
n'est utilisé par ces harnesses. L'archive iOS complète reste l'étape suivante.

## Archive signée vérifiée

- EAS FINISHED, source exacte du candidat, marqueur ARCHIVE SUCCEEDED dans le log0.
- IPA `/tmp/assist-voice-build 15.ipa` : 12334262 octets.
- SHA-256 : `cbd94bc5389fea6e7738a046d56f6d1ddca85398192075baeaf04ae65e2d660e`.
- UUID arm64 : `D30AA2F3-04DE-3C45-9BD5-B3792F7D89E4`.
- Info.plist : org.27pm.assist, 1.0.0 (15), minimum 27.1, SDK iphoneos27.1 / Xcode 2710, descriptions micro/Speech présentes, chiffrement non exempt false.
- Profil CMS, CodeResources, signature Mach-O présente et entitlements de distribution concordants. get-task-allow=false; beta-reports-active=true. Aucun poids Gemma ni paquet ML embarqué.
- Limites : chaîne Apple et hashes complets de code non cryptographiquement vérifiés; aucune preuve d'installation/audio par cette inspection seule.
- Résultat : `/tmp/assist-voice15-ipa-verification.json`.

Soumission exacte demandée une seule fois; acceptation Apple en attente à cette étape.

## Livraison finale confirmée

- Soumission `a919c2b1-c80a-4d7c-a3de-03373c873439` FINISHED le 17 octobre 2026 à 00:27:49 UTC (16 octobre au Québec), reliée exactement à EAS 15.
- Apple 1.0.0 (15) VALID / IN_BETA_TESTING, non expirée, chiffrement non exempt false. État externe READY_FOR_BETA_SUBMISSION; aucune invitation, groupe ou revue externe lancée.
- Notes fr-CA/en-US écrites et relues exactement; `/tmp/assist-paid-build 15-asc-final.json`.
- Numéro Xcode local synchronisé à 15 seulement après disponibilité confirmée.
- Branche publiée conservée à la source exacte; checkout de livraison propre. Changements préexistants du workspace préservés.
- Limite restante : qualification physique de l'interface, du clavier, de Dynamic Type/VoiceOver et de l'enchaînement lecture/dictée. Les aperçus simulés ne sont pas des captures TestFlight.
