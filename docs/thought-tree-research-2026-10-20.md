# Recherche en arbre pour Assist — 20 octobre 2026

Alexis a retenu une préparation en arbre pour chaque demande à Gemma, avec un délai aussi faible que possible. Ce document distingue les résultats publiés, les choix du candidat et la qualification encore nécessaire sur iPhone. Il ne constitue pas une autorisation de build ou d’OTA.

## Ce que montrent les sources primaires

Recherche effectuée avec Exa, puis vérification des pages originales et des méthodes. Les dates ci-dessous sont celles des versions consultées, au plus tard le 20 octobre 2026. Une prépublication récente n’est pas une preuve de supériorité générale.

| Travail | Résultat utile pour cette décision | Limite d’application à Assist |
| --- | --- | --- |
| [Tree of Thoughts, 2023](https://arxiv.org/abs/2305.10601) | Explore plusieurs états, les évalue et sélectionne une suite. | Ses tâches expérimentales ne qualifient pas les outils iOS. Une simple consigne de réflexion ne reproduit pas la recherche. |
| [Policy-Guided Search, janvier 2026](https://arxiv.org/abs/2601.03606) | Utilise la politique du modèle pour guider la recherche et réduire les requêtes d’évaluation. | L’interface actuelle ne fournit pas une politique de probabilités qualifiée pour appliquer fidèlement cette méthode. |
| [BG-MCTS, juin 2026, ICML](https://arxiv.org/abs/2602.09574) | Oriente l’exploration puis la finalisation selon le budget restant. | Une recherche MCTS longue reste trop coûteuse sans mesure préalable sur notre moteur. |
| [Chain-in-Tree, avril 2026, Findings ACL](https://arxiv.org/abs/2509.25835v4) | Décide quand ouvrir des branches plutôt que multiplier toutes les étapes. | Ses gains dépendent des tâches et de l’évaluateur. Notre arbre court et fixe ne constitue pas une réplication de CiT. |
| [Uncertainty-Aware Allocation, 16 octobre 2026, prépublication](https://arxiv.org/abs/2610.22858) | Évite les suites redondantes en séparant valeur et incertitude. Étudie des estimations par représentations, confiance ou récompense. | Nous ne disposons pas de ces signaux calibrés ni d’une réplication sur Gemma et les dialogues iOS. Aucun facteur d’accélération publié n’est transposé à Assist. |
| [Brief Is Better, avril 2026, prépublication](https://arxiv.org/abs/2604.02155) | Observe que de courts budgets peuvent aider la sélection de fonctions et que des budgets plus longs peuvent la dégrader. | Expériences sur d’autres modèles et principalement un appel par question. Aucun nombre de jetons optimal n’est établi pour Gemma. |
| [ToolPRM, ACL juillet 2026](https://aclanthology.org/2026.acl-long.855/) | Recherche au niveau du nom de fonction et de ses arguments, avec un évaluateur entraîné. | Introduire son modèle de récompense modifierait notre architecture. Notre validation fermée n’est pas un ToolPRM. |
| [ETS, juin 2025](https://arxiv.org/abs/2502.13575) | Réduit la redondance et favorise le partage du cache des branches. | Aucune API de duplication de cache KV ou de faisceaux n’est qualifiée dans le moteur Core AI actuel. Aucun partage de cache spéculatif n’est revendiqué. |

## Choix du candidat

Le candidat utilise le même Gemma complet et son contexte 32K. Deux générations privées séquentielles précèdent le parcours de réponse : deux interprétations courtes, puis deux suites par interprétation et leur évaluation. L’hôte choisit une feuille parmi ces quatre suites. Les branches contiennent uniquement des intentions et conditions courtes ; aucun champ de reçu ni appel exécutable n’est accepté à cette étape. Les intentions et conditions restent des textes non fiables, sans validation de leur vérité par le parseur.

Les alternatives d’une étape sont regroupées dans une seule sortie JSON, afin de limiter les appels au moteur. C’est un regroupement logique, sans calcul parallèle ni gain de cache présumé. Les plafonds de sortie sont 192 puis 384 jetons, pas des longueurs à atteindre. Le catalogue de préparation contient les noms et objectifs condensés des outils réellement permis. L’exécution conserve ensuite leurs schémas complets et leurs validations.

Le premier choix de l’exécution doit correspondre à la feuille retenue : réponse/clarification, ou outil déclaré. Après un vrai reçu, les étapes suivantes peuvent s’adapter aux données reçues. Le guide retenu reste identique pendant les continuations ; il ne devient jamais une preuve, une permission ou une confirmation. Toutes les branches restent sans effet. Les limites natives de chaque profil restent applicables.

La préparation s’effectue une fois par requête externe, pas après chaque appel d’outil. Texte et voix utilisent les mêmes points d’entrée. La recherche publique reçoit exclusivement sa question isolée et ses deux outils web. Les opérations manuelles des panneaux ne sont pas des requêtes à Gemma.

Un JSON tronqué, une branche invalide, une fin au marqueur d’outil, l’annulation ou le dépassement du délai empêchent l’exécution. Aucun retour silencieux à une réponse sans arbre n’est présenté comme un succès. L’arrêt attend la libération effective du calcul avant de rendre le moteur disponible.

## Ce qui reste à démontrer

Le même modèle propose et note les alternatives : ses erreurs peuvent être corrélées. Les notes ne sont ni des probabilités calibrées ni une preuve de justesse. Cette implémentation courte s’inspire des contraintes de coût de la littérature ; elle ne prétend reproduire l’ensemble de ces algorithmes ou leur performance.

Les deux préparations ajoutent de vrais préremplissages et décodages. Leurs instructions privées diffèrent entre étapes ; aucun gain de préfixe commun entre ces étapes n’est supposé. La conversation originale n’est pas tronquée pour les faire entrer. Les budgets réels sont vérifiés après le template.

Les essais de ce soir doivent noter séparément le choix spontané, les paramètres, les clarifications nécessaires, l’absence d’action inutile, la fidélité au reçu et la sûreté des effets. Mesurer le délai complet depuis l’envoi jusqu’au premier texte visible et jusqu’à la fin, en plus des résumés des deux passes natives et de leur agrégat `tree_*`. Le TTFT du dernier passage seul masque le coût de l’arbre, des confirmations et des outils.

Le [cahier de dialogues naturels](device-tools-evening-acceptance.md) complète les cas techniques. Les branches spéculatives ne doivent jamais être ajoutées aux appels effectivement proposés/exécutés dans le rapport d’évaluation. Sans résultats réels sur l’iPhone, ni bénéfice de fiabilité ni délai optimal n’est établi.
