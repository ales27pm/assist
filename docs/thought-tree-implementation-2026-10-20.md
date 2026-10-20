# Assist : préparation ToT et conversations naturelles

État du candidat au 20 octobre 2026, worktree `assist-private-web-research`. Sources non livrées ; aucune nouvelle build, OTA, soumission, installation ou modification de service pendant cette tranche.

L’[approfondissement suivant](thought-tree-deeper-review-2026-10-20.md) corrige le délai moteur, les filtres et l’évaluateur. Ses contrôles finaux remplacent les nombres de la tranche initiale ci-dessous : 100 contrôles ToT, 63 d’évaluation et 18 gardes de câblage. Les preuves du tokenizer et du moniteur ci-dessous restent celles de la tranche initiale.

## Comportement préparé

Chaque demande à Gemma passe par deux générations privées : deux approches courtes, puis quatre suites liées à leurs parents et évaluées. L’hôte choisit une suite de façon déterministe. La première proposition de l’exécution doit correspondre à son mode et à son outil éventuel. Après un vrai reçu, la boucle peut adapter ses étapes dans le registre et les budgets existants. Il n’existe aucun exécuteur dans le contrôleur de préparation.

Le même propriétaire garde le moteur pendant préparation, confirmation, exécution et libération. Texte, voix, outils, calendrier et recherche utilisent les points d’entrée existants ; la préparation se produit une seule fois par demande, sans être répétée après chaque outil. La recherche conserve exclusivement son contexte public isolé. Les opérations manuelles des panneaux restent directes.

Les sorties privées exigent JSON fermé, clés uniques, deux racines et quatre feuilles liées, scores entiers bornés, noms d’outils permis et vrai arrêt EOS 1/106. Un arrêt 50, une troncature ou un arbre invalide ne déclenche rien. Le délai de la demande inclut la préparation. Son annulation appelle l’arrêt du même moteur et attend le retour du travail en cours.

Les deux passes n’émettent aucun texte vers l’UI/TTS. Les sorties finales gardent un filtre de marqueurs et d’écho littéral du plan sélectionné ; la prose conserve son streaming, les préfixes structurés attendent la validation finale. Le JSON demandé par l’utilisateur reste permis. Ce filtre syntaxique ne détecte pas une paraphrase narrative et ne prouve pas la véracité du texte généré. Un EOS vide après un reçu de métadonnées reste accepté par la boucle existante. Un rejet de texte postérieur à un effet ne nie pas les reçus déjà obtenus.

L’instruction de conversation distingue conseil, besoin de données natives et précision manquante, avec seulement 90 octets ajoutés au SYSTEM de la fixture naturelle. Après un tour d’outil non éligible — refus, annulation, échec ou issue inconnue — l’App retire les anciennes références ; une réponse courte ne peut plus reprendre un objectif antérieur sans le contexte de son arrêt. Une nouvelle demande complète peut démarrer un nouveau parcours.

## Vérifications de la tranche initiale

| Contrôle | Résultat et portée |
| --- | --- |
| `npm run check` | Exit 0 : TypeScript, lint sans erreur, 1 847 tests Jest / 61 suites, Codegen, 54 tests de câblage workspace, 25 contrôles de capacités et 43 tests d’évaluation. Un avertissement ESLint préexistant dans WeatherForecastCard reste présent. |
| Contrôleur ToT | 88 contrôles Swift 6, concurrence stricte et avertissements traités en erreurs, réussis sur Mac et dans le harnais isolé. Modèle scripté seulement. |
| Contrats et boucles | 31 schémas fermés, 156 contrôles de boucle et 139 contrôles Host v2/v3 réussis sur Mac. Aucun outil réel appelé. |
| Moniteur | Compilation Swift stricte et harnais Mac réussis, y compris agrégation mesurée, inconnues, doublons, archives et récupération après SIGKILL d’un sous-processus de test. |
| Tokenizer réel | Quatre rendus Swift comparés aux IDs du Jinja canonique : racines, feuilles, sélection et continuation. Le préfixe final de 5 043 jetons est intégralement conservé dans sa continuation synthétique ; cela ne prouve aucun calcul KV économisé. |
| Format des sorties | Fixtures synthétiques : 68 et 179 jetons, hors EOS, sous les plafonds 192 et 384. Ce ne sont pas des sorties obtenues de Gemma. |
| Câblage CoreAI | 17 gardes source et analyse syntaxique Swift réussies. Aucune vérification de types complète contre CoreAI, édition de liens ou archive iOS. |

Les prompts synthétiques privés mesurent 899 et 1 072 jetons. Leur SYSTEM de test est court et ne représente pas une longue conversation réelle. Le résultat final naturel, le délai, la mémoire et la répétabilité ne sont pas qualifiés par ces nombres.

Les premières tentatives de vérification sont conservées : ordre des prérequis EAS à actualiser après ajout du harnais, répertoire/fichier de voix absent du staging du test moniteur, et enveloppe de fixture trop grande pour le lecteur de données d’outil dans le test tokenizer. Les corrections concernent respectivement l’attente de test, le staging et la lecture de la fixture locale de confiance ; aucun garde d’entrée de production n’a été relâché. Les journaux finaux et initiaux restent distincts.

## Essais et optimisations suivants

Les [dialogues naturels préparés](device-tools-evening-acceptance.md) complètent le corpus technique de 59 cas : 12 dialogues / 37 tours initiaux, puis un complément séparé de 4 dialogues / 14 tours, soit 16 / 51 au total. Les 31 outils apparaissent dans leurs branches admissibles ; aucun outil facultatif non appelé n’est déclaré exercé. Les oracles restent séparés des phrases envoyées à Gemma. Les continuations machine ne réemploient que de vrais tours observés, terminés et éligibles. La préparation Host de ces corpus vérifie le contrat d’entrée et les déclarations, avant la préparation privée ; elle ne constitue pas une capture du prompt final dynamique de ToT ni un succès modèle.

Le [relevé des recherches primaires](thought-tree-research-2026-10-20.md) justifie l’arbre court et les budgets. Les [options CoreAI épinglées](coreai-optimization-options-2026-10-20.md) distinguent les capacités déjà présentes des intégrations suivantes : recul contrôlé du cache, adaptateur JSON contraint conservant les motifs d’arrêt, puis budget adaptatif selon les résultats. Aucun nouvel évaluateur ou second modèle n’est ajouté.

Les deux passes supplémentaires coûtent de vrais calculs. Le même Gemma génère et note les options ; les erreurs peuvent être corrélées. Aucun gain de qualité ni de vitesse n’est revendiqué. Le Mac disponible utilise Xcode 26.3 et un SDK réel 26.2 sans CoreAI : il reste une compilation complète sur SDK compatible puis les essais physiques. Les changements Swift exigent un nouveau binaire ; l’ancienne build 29 ne contient pas ce contrôleur et une OTA seule ne peut l’ajouter.

Preuves privées de cette tranche : `/home/ales27pm/.local/share/assist/natural-tot-20261020/`. Les deux dossiers de preuves antérieurs restent conservés. Le manifeste final identifie les sources du candidat et ses écarts ; il ne transforme pas un état non commité en version livrée.
