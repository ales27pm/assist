# Assist 1.0.0 (30) — candidat TestFlight

La demande « Commit, push / Build and submit with EAS » du 20 octobre 2026 autorise cette livraison. Ce document décrit le candidat avant son lancement ; les reçus EAS et Apple seront conservés séparément. Il ne déclare pas encore de compilation distante, de soumission ou de qualification iPhone réussie.

## Périmètre

Le candidat regroupe les corrections natives et de contexte préparées après la build 29 : validation des résultats et des erreurs, annulation et drain, finalisation des reçus, callbacks Spotlight, contrôles météo, références conversationnelles, et préparation ToT bornée pour chaque demande à Gemma. Les 31 outils restent dans le registre fermé et les confirmations natives restent obligatoires.

Le même Gemma complet et son contexte 32K sont conservés. Le profil `testflight` garde l’import de modèles et de packs signés : aucun poids ni clé privée dans Git ou dans l’archive de sources. Le décodage JSON contraint et un nouveau recul de cache ne sont pas activés ; leurs obstacles et limites restent décrits dans l’[approfondissement](thought-tree-deeper-review-2026-10-20.md).

Les six configurations Debug/Release de l’app, Partage et Widget déclarent build 30. Les valeurs Expo embarquées et la configuration déclarent `1.0.0-native30`, afin de séparer les mises à jour des anciennes versions natives. Aucune OTA n’accompagne cette opération.

## Vérifications avant lancement

* `npm run check` après changement de version : TypeScript, lint sans erreur, 1 847 tests / 61 suites Jest, Codegen, 54 contrôles workspace, 26 contrôles de capacités signées et 63 contrôles d’évaluation réussis. Un avertissement de shadow React préexistant reste dans un test météo.
* Archive et symboles : 71 contrôles réussis ; prérequis de compilation : 17 scénarios réussis. Ils ne remplacent pas une compilation réelle sur le SDK cible.
* Les contrôles Swift purs et les preuves avant/après de la tranche précédente sont conservés. Le Mac local dispose d’un SDK réel 26.2 sans CoreAI ; la compilation complète appartient à la build EAS sur l’image configurée Xcode 27.1, avec son contrôle réel des prérequis.
* Corpus préparés : 59 cas techniques, puis 16 dialogues naturels / 51 tours. Les 31 outils apparaissent dans les branches admissibles ; aucun nouveau score de Gemma ou de latence iPhone n’en est déduit.

## Chaîne de livraison

Commiter les sources exactes, pousser la branche courante, puis vérifier hors ligne la copie réellement produite par le client EAS à partir du commit propre. Le profil reste `testflight`, les credentials distants sont conservés et leur modification est gelée pour la build.

Après compilation, vérifier l’IPA exporté, les trois produits signés, leurs profils/entitlements, runtime, ressources et dSYM liés aux mêmes exécutables avant soumission. Une éventuelle erreur est examinée à sa frontière réelle avant toute relance ; aucun second build payant n’est déclenché automatiquement.

La soumission vise TestFlight pour l’app existante. Aucun groupe externe, Beta App Review ou publication App Store de production supplémentaire n’est demandé. Attendre l’état Apple du bon numéro, sans réenvoyer sur sa seule absence initiale.

Les preuves de préparation et de livraison sont dans `/home/ales27pm/.local/share/assist/releases/1.0.0-30-preparation/`. Les preuves scellées des 72 sources précédentes restent dans `/home/ales27pm/.local/share/assist/deeper-tot-20261020/`.
