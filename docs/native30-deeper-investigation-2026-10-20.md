# Assist native30 — investigation approfondie du 20 octobre 2026

La priorité est de fiabiliser la préparation et son contrat de contexte, puis de mesurer le parcours complet sur le vrai modèle. Les exports établissent deux rejets avant génération des feuilles visible ; ils ne donnent toujours pas la règle exacte rejetée. Les découvertes ci-dessous expliquent pourquoi un ajout de prompt ou l'activation directe d'une API JSON ne suffit pas à qualifier le correctif.

Périmètre conservé : Gemma complet, contexte 32K, moteur unique, préparation ToT sur chaque demande, deux passes bornées et validations natives. Cette tranche réalise de la recherche, des inspections et des expériences isolées. Elle ne modifie aucun code de production, pin, modèle, service ou compte. Les changements de diagnostic du tour précédent restent non livrés.

## Recherche et portée des sources

Quatre axes, puis deux recherches complémentaires : **14 recherches Exa, 70 résultats demandés au total**. Ce compteur comprend doublons et résultats écartés ; ce n'est pas le nombre d'articles lus intégralement. Fenêtre récente : du 20 octobre 2025 au 20 octobre 2026, avec fondations plus anciennes séparées. Les recommandations reposent sur des sources primaires relues et le code effectif, pas sur un classement de modèles transféré à Assist.

- [Gemma et protocole de planification](gemma-planning-protocol-research-2026-10-20.md) : documentation Google, vrai template E2B et projection locale.
- [CoreAI et décodage contraint](constrained-decoding-research-2026-10-20.md) : pin/amont/version xgrammar, masque, arrêts, comptage et annulation.
- [Évaluation des dialogues naturels](agent-dialogue-evaluation-research-2026-10-20.md) : corpus réel préparé et acceptation par frontière.
- Cette synthèse : séparation des contextes, routage web, deux reproductions et ordre d'implémentation.

Les skills Exa Search, LLM & Agent Builder Copilot, Engineering Suite Research/Context Engineering et React Native Best Practices ont servi au cadrage. Leur recommandation de mesurer aux frontières concernées n'autorise ni un nouveau modèle ni une optimisation React sans profil de rendu. Le symptôme observé est un rejet de préparation natif, pas une preuve de problème de rendu JS.

## Constats qui changent la décision technique

| Constat | Preuve et limite | Conséquence proposée |
| --- | --- | --- |
| Le template n'a pas dérivé | Le vrai fichier HTTP E2B public et la copie locale sont identiques, 18 569 octets, SHA `0a2c8073…`. La copie brute prévaut sur le rendu normalisé d'un outil de recherche. | Ne pas remplacer le template ni ajouter les balises destinées à d'autres tailles de Gemma sans preuve. Les règles E2B de thinking sont spécifiques au variant. |
| Un résumé `eos` ne suffit pas | Le consommateur courant emploie ce libellé pour plusieurs stops, dont 50. Les nouveaux diagnostics distinguent ces issues ; l'ancien export ne le peut pas. | Observer le motif fermé avant de nommer la cause de l'incident ; conserver longueur, annulation, JSON complet et stop réel distincts. |
| La voie JSON SDK n'est pas un remplacement direct | Stops perdus avant le C++, compte terminal incomplet, deux interprétations de `false`, erreur C++ également convertie en `false`. Les contrats concernés sont inchangés dans l'amont CoreAI inspecté. | Petit adaptateur à contrat explicite ; ne pas utiliser `nil` ou `false` comme preuve de terminaison réussie. Voir la note technique et ses tests isolés. |
| Le catalogue de préparation abrège les prérequis | Il garde les noms et au plus 160 octets de la première phrase, sans descriptions d'arguments. Certains prérequis survivent dans cette phrase ; leurs détails et les relations entre arguments peuvent manquer. Le passage d'exécution conserve notamment les bornes grâce aux descriptions locales. | Exposer au planificateur des prérequis compacts, conditions de non-emploi et dépendances, issus du registre unique. Comparer coût et qualité avant d'ajouter tout le schéma aux deux passes. |
| Plan syntaxique et action réalisable sont distincts | Reproduction Swift : plan météo avec « coordonnées encore nécessaires », notes 2/2, puis refus de `location_current` et d'une clarification par la contrainte du premier accès. | Le plan doit choisir le premier accès réel admissible, y compris une lecture préalable ou une clarification. Ne pas contourner la garde en autorisant une action arbitraire. |
| Le plan libre acquiert une place privilégiée | Reproduction avec le vrai contrôleur : un intent synthétique demandant d'annoncer un succès est accepté puis ajouté au SYSTEM. Le contrat système original est conservé. Aucun modèle n'a suivi cette consigne lors du test. | Garder les instructions du SYSTEM sous contrôle de l'hôte. Consommer uniquement les décisions structurées nécessaires ; isoler ou omettre le texte libre du plan plutôt que lui donner une place privilégiée. |
| La recherche du fil et celle du workspace sont séparées | `App.tsx` appelle le profil iOS ; `generateResearch` est dans `NativeWorkspacePanel`. La copie serveur déployée ne contient pas les routes v2. | Raccordement de l'interface ET qualification/déploiement v2 distincts ; garder une demande publique explicite et ne pas copier l'historique iOS dans le profil web. |

Le format et les arrêts Gemma sont documentés par [Google](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4) ; le [mode thinking](https://ai.google.dev/gemma/docs/capabilities/thinking) distingue notamment E2B/E4B des modèles plus grands. Ces recommandations concernent les modèles officiels et ne qualifient pas automatiquement notre export dérivé.

Le [guide de contexte Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), daté du 29 septembre 2025, soutient un contexte compact contenant l'information utile au choix. Cela ne justifie pas de réduire la capacité 32K. Les descriptions de [bons outils](https://www.anthropic.com/engineering/writing-tools-for-agents) doivent rendre emploi, arguments et limites compréhensibles ; le registre et le validateur restent l'autorité. Pour les contextes non fiables, [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) rappelle que de simples étiquettes textuelles ne constituent pas une frontière d'autorisation. Notre preuve de placement dans SYSTEM ne démontre ni exploitation, ni contournement des confirmations, ni cause des rejets roots.

## Web : inspection actuelle et route à préparer

Lecture seule du 20 octobre, 22:01 UTC : `assist-private-gateway.service` est actif. Le lien déployé pointe sur le snapshot `18c1d5fe371191cf8774`, dont `server.py` porte le SHA `e421cffb0c6043b621444a4671b9d30a534901d486744de91f540447421963ce`. Ce fichier contient `/v1/capabilities`, pas `/v2/capabilities` ni `/v2/read`. Aucune clé n'a été lue, aucun appel authentifié ou essai iPhone n'a été effectué : ceci est une inspection du service et du code déployé, pas une preuve de réponse API v2.

Le principe de [routage spécialisé](https://www.anthropic.com/engineering/building-effective-agents) est applicable comme proposition d'architecture : distinguer conversation, accès iOS et recherche publique avant de charger leur contexte spécifique. Pour Assist, le routeur doit produire une décision fermée et validée par l'hôte. Une demande ambiguë appelle une clarification ; une demande publique reste explicitement identifiable. Le profil public reçoit seulement la question publique admise, pas contacts, calendrier, documents ou anciens reçus privés. Le serveur est ensuite négocié réellement ; un serveur v1 ne devient pas v2 par choix de route. Ce principe n'impose ni un autre modèle, ni un appel réseau durant l'exploration ToT.

## Évaluation : combler les trous avant de parler de fiabilité

Le corpus local contient 16 dialogues / 51 tours préparés, avec 31 noms dans les branches admissibles. Il ne contient pas 51 résultats Gemma réussis. La demande météo brève de l'incident n'est pas équivalente au scénario qui fournit déjà ville et unité. Les deux phrases réellement observées deviennent des régressions distinctes ; les oracles restent hors du prompt.

La note d'évaluation utilise BFCL V3 et τ-bench comme fondations. Deux compléments primaires plus récents étendent ce cadre : [BFCL V4](https://gorilla.cs.berkeley.edu/blogs/15_bfcl_v4_web_search.html), publié le 17 juillet 2025, sépare notamment recherche web avec/sans extraits, mémoire et sensibilité de format ; [τ²-bench](https://proceedings.mlr.press/v306/barres26a.html), publié à ICML en juillet 2026 après son [préprint du 9 juin 2025](https://arxiv.org/abs/2506.07982), étudie agent et utilisateur agissant sur un même environnement. **Déduction pour Assist** : mesurer aussi les erreurs de coordination autour des permissions, du déverrouillage, des sélecteurs et confirmations, séparément du raisonnement et de l'exécution. Aucun score publié n'est transposé au téléphone.

La campagne doit séparer : admission, roots, leaves, choix d'outil ou absence d'outil, arguments, confirmation, effet réel, reçu, restitution et TTS. Les métriques incluent réussite du dialogue, fidélité aux reçus, délais et annulation drainée. Le temps système, l'attente de l'utilisateur et le total visible doivent être publiés séparément, avec chaud/froid et profil réseau. Les 5,6–5,7 secondes des deux rejets ne mesurent que leur préparation, pas une réponse complète réussie ; une baseline qui échoue tôt ne permet pas de valider une optimisation de réponse complète.

La proposition est de répéter d'abord avec des exécuteurs de fixtures sans effets personnels, puis de qualifier les branches pertinentes sur iPhone. Aucun résultat dépendant n'est fabriqué après un échec amont. Une note auto-évaluée 2/2 n'est pas une confiance calibrée. Une syntaxe JSON conforme ne prouve ni le bon outil, ni la bonne cible, ni la vérité de la réponse.

## Ordre d'implémentation recommandé

1. Conserver le correctif de diagnostic préparé et établir le motif réel sur les deux régressions. Il ne constitue pas à lui seul une réparation du générateur de plans.
2. Construire et tester la frontière de grammaire : statut d'erreur explicite, vrai vocabulaire/tokenizer, stops 1/106, interdiction permanente de 50, Unicode et compte exact. Garder le même moteur, les deux étapes et les validations métier. Ne pas activer un chemin qui confond erreur et masque sans restriction.
3. Réviser le contrat de contexte : prérequis dans le catalogue de préparation ; premier accès cohérent avec les conditions ; SYSTEM maîtrisé par l'hôte et contenu libre du plan traité comme donnée. Mesurer les changements sur le vrai modèle avant de les déclarer bénéfiques.
4. Raccorder le profil web isolé au parcours conversationnel, puis traiter le serveur v2 comme livraison distincte avec ses vraies vérifications de frontière.
5. Exécuter les dialogues naturels sans noms d'outils dans les demandes, puis mesurer la latence complète et la répétabilité. Optimiser les budgets seulement sur une baseline fonctionnelle et comparable, sans désactiver ToT ni retirer les poids/contexte.

## Preuves nouvelles et limites

- Probe de promotion du plan : compilation Swift 6 stricte des vraies sources, conteneur existant `swift:6.2-noble`, réseau désactivé et montages en lecture seule ; résultat déterministe, aucun modèle ou effet. Artefacts privés : `/home/ales27pm/.local/share/assist/native30-deeper-research-20261020/plan-promotion-*`.
- Probe de dépendance du premier accès et projection réelle du template : voir la note Gemma et `/tmp/assist-gemma-planning-public-research-20261020/`.
- Wrapper de masque : vrais corps Swift épinglés, frontière C simulée explicitement, 6 cas / 13 contrôles. Cette preuve démontre le traitement du retour, pas un préfixe de grammaire réel déclenchant ces cas. Voir la note de décodage.
- Les tests 1 858 JavaScript et 119 contrôles ToT Swift concernent le correctif source du tour précédent. Cette recherche documentaire ne les présente pas comme de nouvelles générations Gemma ou une nouvelle qualification iPhone.

Les dossiers privés conservent les réponses documentaires et les observations, sans exporter de prompt privé. **La cause exacte des deux rejets iPhone reste inconnue.** Aucun nouveau binaire, OTA, déploiement, changement de dépendance ou changement des paramètres de production n'a été effectué pendant cette investigation.
