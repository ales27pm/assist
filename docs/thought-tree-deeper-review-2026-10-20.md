# Assist — approfondissement ToT, moteur et évaluation

État source du 20 octobre 2026, worktree `assist-private-web-research`, branche `feature/private-web-research`, HEAD `60d54a28f743ddd5ae1df47cf97b7bab49cf5b53`. Cette tranche poursuit les changements non commités existants. Aucune build, OTA, soumission, installation ou modification de service n’a été effectuée.

## Corrections établies et appliquées

L’arbre reste obligatoire pour chaque demande à Gemma, avec deux préparations privées, le modèle complet, le contexte 32K et un seul propriétaire du moteur. Aucun effet natif n’est permis pendant l’exploration. Les scores du modèle ne sont pas des probabilités calibrées.

| Frontière | Défaut reproduit | Correction et preuve |
| --- | --- | --- |
| Plan privé → réponse publique | L’écho exact du plan sélectionné pouvait passer avec un champ supplémentaire. | Comparaison récursive des quatre champs privés, sans exiger l’égalité de l’objet entier ; JSON utilisateur sans ce plan conservé. Reproduction avant/après indépendante et harnais ToT. |
| Streaming ordinaire | Un préfixe commençant par `~` ou un accent grave était retenu comme s’il s’agissait forcément d’un bloc structuré. | Seuls les préfixes encore compatibles avec une vraie clôture de trois caractères restent retenus. `~5 minutes` et le texte Markdown ordinaire reprennent leur streaming ; annulation partielle couverte. |
| Bornes privées | Le retrait des blancs précédait les bornes UTF-8 et le rejet des contrôles. | Validation de la donnée brute avant normalisation : les 72 octets et les caractères interdits ne sont plus contournables par blancs ou retours à la ligne. |
| Délai → moteur | Le dernier passage attendait un output pour constater le dépassement ; un préremplissage sans sortie pouvait dépasser le délai sans arrêt actif. | `AssistInferenceDeadline` met en concurrence le travail détenu et l’échéance absolue, appelle l’arrêt SDK puis attend le retour effectif. Le moteur reste réservé pendant le drain. Les cinq chemins de décodage, privés compris, utilisent le même wrapper. |
| Arrêt → erreur réelle | Une panne du worker pendant le drain suivant une expiration pouvait être remplacée par un rejet de délai récupérable. | L’expiration interne est distincte ; toute erreur réelle restante est collectée. Une panne reste une panne et n’est pas convertie en état moteur prêt. Le test indépendant reproduit l’échec avant correction et passe après. |

Seule une annulation utilisateur peut conserver une réponse publique explicitement marquée `cancelled`. Ni un EOS tardif, ni une valeur privée, ni une expiration ne deviennent une réponse réussie. Les tâches de délai sont drainées ; aucun callback d’arrêt différé n’est laissé au prochain propriétaire. Une opération SDK non préemptible peut encore retarder son retour : ce mécanisme n’est pas une garantie de plafond matériel sur le temps d’arrêt.

## Évaluation corrigée

Le corpus technique conserve 59 cas et le corpus naturel initial 12 dialogues / 37 tours. Une [extension séparée](evals/device-tools-natural-dialogues-extension-v1.json) ajoute 4 dialogues / 14 tours pour les outils absents : biométrie, capacités, position ponctuelle, caméra, contact/composeur et cycle documentaire. Le total préparé est de 16 dialogues / 51 tours, avec les 31 outils représentés dans les branches admissibles des oracles. Une réponse sans accès reste recevable pour une clarification ou une limite système ; un outil facultatif non appelé demeure non exercé. Leur état reste `prepared_not_run_model`. Les nouvelles régressions vérifient le juge et le corpus ; elles ne sont pas des résultats de Gemma.

* Un mauvais outil, une mauvaise cible déjà observée ou un préfixe de séquence impossible échoue même si le tour est interrompu. L’absence d’une étape future reste inconnue.
* Une annulation attendue exige le statut natif correspondant ; un OCR réussi ne peut plus faire passer le scénario d’annulation. Une erreur propriétaire attendue doit correspondre à son domaine et code fermés.
* Le JSON du résultat et son hash sont vérifiés ensemble ; un hash opaque ne prouve pas le contenu attendu. Les identifiants de liste/recherche sont reliés aux appels suivants, en choisissant la cible unique par ses données plutôt que par une position arbitraire.
* Les tours naturels exigent la demande réellement admise, la capsule de contexte et son epoch, dès le premier tour. Les prompts nominaux et réponses d’oracle ne remplacent plus un historique absent. Une annulation ou un échec retire l’ancien objectif même avant tout appel proposé.
* La revue sémantique est liée au cas, à ses critères et à l’observation complète : texte, arguments, résultats et contexte. Modifier ces éléments invalide l’ancienne revue.

Les artefacts de validation restent déclaratifs : un rapport local cohérent ne constitue pas une attestation authentifiée d’exécution native. Le [guide du soir](device-tools-evening-acceptance.md) décrit le format exact et sépare les phrases utilisateur des oracles.

## Optimisations confrontées au code Apple épinglé

Le pin inspecté est `apple/coreai-models@9db747612f972001279f02adb04d3ef982310d0e`, sans changement du SDK. Les [options détaillées](coreai-optimization-options-2026-10-20.md) conservent les liens aux lignes de cette version.

| Option | Conclusion vérifiée | Décision |
| --- | --- | --- |
| Préfixe commun / KV | `lastPrefixHitCount` peut rester positif alors que le curseur repart à zéro. Dans la géométrie locale inspectée profondeur 576 / fenêtre 512, le recul est limité à 65 positions. La fixture de sortie de 68 jetons dépasse déjà cette marge ; ce n’est pas une sortie mesurée de Gemma. | Ne pas activer un recul générique ni annoncer des jetons économisés à partir du LCP. 41 contrôles sur extraits exacts du pin distinguent positions, alignement et padding ; ils ne prouvent pas la parité numérique. |
| JSON contraint | Les API existent, mais leurs séquences ne conservent pas notre contrat complet d’arrêt et de comptage. Le paramètre `stopTokenIds` est perdu avant le pont C++ dans le pin. Les valeurs par défaut du vocabulaire diffèrent entre API. | 10 assertions sur les vrais fichiers Swift et 3 appels C++ avec frontières simulées établissent la perte du paramètre ; 8 assertions d’itérateur illustrent l’ambiguïté terminale. Aucun échec automatique d’EOS Gemma n’est déduit : xgrammar réel n’a pas été exécuté. Corriger le pont puis qualifier les vrais masques avant un remplacement de `consumeGeneration`. |
| Budget adaptatif | Les travaux récents justifient d’éviter branches redondantes et calcul inutile, sans fournir un réglage déjà qualifié pour notre export et l’iPhone. | Garder les plafonds actuels 192 / 384 et l’arbre pour chaque demande. Aucun second modèle, entraînement ou fournisseur ajouté. Ajuster à partir des erreurs et durées réellement observées. |

## Recherche récente et portée

Exa a fourni 18 résultats de découverte sur trois axes : coût des grammaires, fiabilité des outils en dialogue, et sorties bornées / motifs d’arrêt, avec fenêtre de recherche du 20 octobre 2025 au 20 octobre 2026. Des travaux fondateurs antérieurs restent distingués. Seules les sources primaires effectivement ouvertes étayent les conclusions ; ni 18 réplications ni une revue exhaustive de toutes les publications ne sont revendiquées.

* [Constrained Decoding… Semantic Gap, 20 septembre 2026](https://arxiv.org/abs/2609.23742) distingue conformité de structure et exactitude du contenu sur cinq petits modèles. Les échecs d’instruction et d’enchaînement peuvent persister malgré un schéma valide. Cela motive deux axes de notation séparés, sans transposer son taux à notre Gemma.
* [Beyond Fluent Generation, 7 septembre 2026](https://arxiv.org/abs/2609.07370) étudie les sorties d’outils de petits modèles sur CPU. La récupération permissive peut masquer les échecs de format strict ; notre juge n’ajoute ni réparation JSON ni appel inventé.
* [TruncProof, version du 24 juin 2026](https://arxiv.org/abs/2605.13076v3) tient compte du budget nécessaire pour terminer une structure pendant le décodage. Ce n’est pas une justification pour fermer artificiellement un JSON tronqué ; son intégration exige le contrôle du masque grammatical et des jetons restants.
* [CFGzip, version du 1er octobre 2026](https://arxiv.org/html/2605.29986v2) réduit le travail de recherche dans l’espace des jetons contraints par prétraitement. Ses grammaires et conditions expérimentales ne démontrent pas un gain sur notre téléphone. Mesurer prétraitement, allocations et durée complète avant d’adopter une nouvelle couche.

Ces résultats complètent la [recherche ToT précédente](thought-tree-research-2026-10-20.md). Ils soutiennent les vérifications préparées, pas une promesse de version optimale ou de raisonnement infaillible.

## Résultats de vérification de cette tranche

| Contrôle | Résultat réel |
| --- | --- |
| `npm run check` | Exit 0 avant le complément de corpus : TypeScript, ESLint sans erreur, 1 847 tests / 61 suites Jest, Codegen, 54 contrôles workspace, 25 capacités et 56 contrôles d’évaluation. Un avertissement `React` shadow préexistant reste dans le test météo. |
| Évaluation après complément | 63 contrôles Node réussis : 56 précédents et 7 nouveaux sur le corpus / les liaisons. L’app, le grader et les sept sources Swift n’ont pas changé pendant cette extension ; aucun test applicatif supplémentaire rejoué. |
| Swift Mac strict | 31 schémas fermés, 156 contrôles boucle, 139 Host, 100 arbre, 25 admission/préparation/délai ; aucune exécution d’outil réel. |
| Politique d’inférence | 101 contrôles Linux / 98 Mac Intel ; trois cas conditionnels spécifiques à l’architecture expliquent l’écart. |
| Revue indépendante du délai | Trois scénarios : panne pendant drain après deadline, panne après Stop, partielle interdite après deadline. Sources et résultats avant/après conservés. |
| Cache | 41 contrôles sans modèle sur cinq extraits exacts du pin, mocks explicitement identifiés. Aucun gain de latence mesuré. |
| Contrat SDK JSON | 21 assertions / observations isolées, code Swift et corps C++ exacts, dépendances de frontière simulées. Aucun modèle ni moteur de grammaire réel. |
| Câblage CoreAI | 18 gardes source et analyse syntaxique Swift réussies. Ce n’est pas une vérification des types contre le SDK CoreAI. |
| Contrat de l’évaluateur | Vrai binaire Swift recompilé puis réexporté : définitions inchangées ; les sept hashes correspondent exactement aux entrées du compilateur. Aucun garde de provenance relâché. |

Le Mac accessible a Xcode 26.3 et le SDK réel iPhoneOS 26.2, sans `CoreAI.framework`. L’API Mac du connecteur a échoué à son probe ; le chemin SSH existant a permis les contrôles purs. Ni un alias de SDK, ni une analyse syntaxique ne remplace la compilation native complète. Le précédent contrôle du tokenizer et du moniteur reste historique, avec sources correspondantes ; il n’est pas présenté comme une nouvelle exécution.

Il reste une compilation avec un SDK compatible, puis les demandes naturelles sur le vrai Gemma/iPhone : choix spontané, paramètres, confirmations, fidélité au résultat, corrections de sujet, annulation, mémoire et délai complet. Aucun appel modèle ou essai iPhone nouveau pendant cette tranche. Les changements Swift exigent un nouveau binaire ; une OTA seule ne les apporte pas à la build déjà installée.

Preuves privées : `/home/ales27pm/.local/share/assist/deeper-tot-20261020/`. Les dossiers précédents restent intacts. Le manifeste de cette tranche relie sources, journaux et patch incrémental ; il ne constitue pas une livraison.
