# Assist 1.0.0 (30) — candidat TestFlight

La demande « Commit, push / Build and submit with EAS » du 20 octobre 2026 autorise cette livraison. Ce document décrit la préparation puis la première tentative ci-dessous ; les reçus EAS et Apple sont conservés séparément. Aucun succès de compilation complète, de soumission ou de qualification iPhone n’est déclaré à ce stade.

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

## Première tentative et correctif prêt

Le commit `05071c4d63ef17ee474aafd7a2923e8733842651` a été poussé et sa copie EAS vérifiée : 789 fichiers, archive de 3 374 471 octets. La [build EAS 31c6cd49](https://expo.dev/accounts/ales27/projects/assist/builds/31c6cd49-f7c2-43bb-94e7-700b5ca18b50) a réellement utilisé Apple Silicon, Xcode 27.1 et iPhoneOS SDK 27.1. Pré/post-install et contrôles natifs sont passés. L’archive de l’app a ensuite échoué : trois appels `applyChatTemplate` omettaient `tools` ; les diagnostics répétés donnent six messages. Aucun IPA ni paquet de symboles exporté n’est disponible, et aucune soumission n’a eu lieu.

La classe concrète du tokenizer possède un défaut pour ce paramètre ; le protocole `any Tokenizers.Tokenizer` du pin `eed7264ac5e4ec5dfa6165c6e5c5577364344fe4` ne le possède pas. Les trois appels ordinaires/privés passent désormais explicitement `tools: []`, sans nouveau schéma exécutable. Les parcours d’outils conservent leurs vrais schémas.

Un harnais extrait les expressions réelles avant/après et compile contre les vrais modules épinglés. L’ancien code reproduit les trois erreurs ; le code corrigé compile en Swift 6 strict. Sur cinq fixtures, les IDs complets sont identiques entre défaut concret, protocole avec `nil`, protocole avec `[]` et les trois expressions réelles corrigées. Cette preuve concerne l’API/tokenizer, pas la compilation de l’application ou un résultat de Gemma.

Vingt contrôles Python de câblage et 39 tests Jest des hooks passent, ainsi que le lint ciblé. Le garde de présence de l’argument est maintenant exécuté au début du pré-install EAS, avant le contrôle du SDK et la compilation native. La copie du correctif sera vérifiée depuis un nouveau commit propre. Aucune seconde tentative distante automatique n’est déclenchée ; le numéro 30 n’a pas été envoyé à Apple.
