# Gemma 4 : protocole réel et rejets du planificateur

Relevé du 20 octobre 2026, sur `assist-private-web-research`, base `b18f705658723db4bd6b01f60b4fc932891164bb` avec le correctif de diagnostic non livré. Recherche et reproductions isolées uniquement : aucun changement de code, de modèle, de pin, de service ou de livraison dans cette tranche.

Les deux essais iPhone prouvent un échec avant toute passe d’outil visible. Ils ne révèlent pas le contenu privé des racines rejetées. La recherche ne permet donc pas de choisir entre JSON non conforme, contrainte de branche ou de texte, terminaison réservée et préparation des feuilles. Le correctif de diagnostic permettra de distinguer ces frontières ; il ne constitue pas encore un correctif démontré de la sélection par Gemma.

## Méthode et sources

Le plugin [Exa Search](</home/ales27pm/.codex/plugins/cache/openai-curated-remote/app-69ea4ed2cf7c8191b742ef3622479ddd/4.0.1/skills/Search/SKILL.md>) a servi à trois recherches techniques publiques, cinq résultats chacune : protocole des outils, format/thinking, puis template E2B. `sources_reviewed = 15` désigne cette somme de résultats demandés, comprenant des doublons, pas quinze sources primaires indépendantes. Cinq URL primaires ont ensuite été lues : trois pages Google et les vues `blob` et `raw` du même template officiel E2B. Aucun texte de conversation, export utilisateur ou secret n’a été envoyé dans les requêtes.

Les pages Google consultées indiquent des mises à jour les 3 ou 4 juin 2026. Les métadonnées de la vue du template indiquent le 15 juillet ; son en-tête interne indique le 9 juillet. Ces indications précèdent le 20 octobre, mais l’en-tête n’est pas une preuve indépendante de publication. Les résultats tiers, l’exemple 31B et les notebooks non nécessaires n’ont pas servi à définir le contrat local. Les conclusions ci-dessous distinguent documentation, source locale et reproduction sans modèle.

## Versions effectivement utilisées

| Élément | Preuve relevée |
| --- | --- |
| Core AI | Révision Xcode et dépôt SDK local : `9db747612f972001279f02adb04d3ef982310d0e`. |
| Swift Tokenizers | Révision Xcode : `eed7264ac5e4ec5dfa6165c6e5c5577364344fe4`. Le cache de validation antérieur épingle Jinja `4588064a20f3fc093c95f2f7d3359999bf30cae5`. Aucun changement de dépendance. |
| Template canonique | 18 569 octets ; SHA-256 `0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5`, identique dans l’asset local, le bundle dérivé et la constante d’acceptation de l’adaptateur. |
| Comparaison publique réelle | Le GET du fichier officiel E2B renvoie exactement ces octets et ce SHA, au commit HF `3e22461f65e89153144f8adb70e3b8c2cc9845a7`. Aucune dérive de template n’est démontrée. |
| Arrêts du tokenizer local | `<eos>` : 1 ; `<turn\|>` : 106 ; ouverture de réponse d’outil : 50. Les marqueurs d’appel sont 48 et 49 ; la fermeture de réponse est 51. |
| Modèle exécuté sur iPhone | Export dérivé complet `gemma4-e2b-32k-group8-abliterated-rmscomposite`, capacité 32 768. L’identité du tokenizer Google ne transforme pas ces poids dérivés en poids Google officiels inchangés. |

Le fichier public peut être consulté à une [révision immuable du dépôt Google](https://huggingface.co/google/gemma-4-E2B-it/raw/3e22461f65e89153144f8adb70e3b8c2cc9845a7/chat_template.jinja). Le pin du SDK ne suffit pas à identifier un asset téléchargé : la liaison repose aussi sur son SHA. Le texte indexé par un moteur de recherche peut être normalisé ; le contrôle ci-dessus porte sur les vrais octets HTTP. L’adaptation locale des huit accolades pour Swift Jinja reste distincte du fichier canonique accepté ; aucun changement de cette adaptation n’a été effectué.

## Trois contrats à séparer

**Appels d’outils Gemma.** Google décrit des déclarations de fonctions dans `tools`, leurs paramètres et des marqueurs réservés pour les appels et les réponses. Les sorties structurées doivent être validées avant exécution. Ce format n’est pas du JSON ordinaire : les chaînes du bloc natif utilisent notamment un délimiteur réservé. La continuation locale conserve les vrais appels et reçus dans l’historique assistant, sans faux message utilisateur ; le template relevé accepte cette représentation et sait aussi associer des messages de rôle `tool`. Il n’est pas nécessaire de remplacer le parseur strict local par le `regex/globals()` illustratif du notebook. [Guide officiel des appels de fonctions](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4), [template E2B exact](https://huggingface.co/google/gemma-4-E2B-it/raw/3e22461f65e89153144f8adb70e3b8c2cc9845a7/chat_template.jinja).

**JSON privé de l’arbre.** Le contrôleur local ajoute un contrat propre à Assist : deux racines puis quatre feuilles liées, clés exactes, modes fermés, champs courts, alternatives distinctes et scores entiers. Ses appels passent `tools: []` ; le catalogue abrégé est du texte SYSTEM. Le moteur utilise une température nulle, mais aucun décodeur JSON contraint dans ce chemin. Un EOS n’atteste donc pas la conformité à ce schéma privé. Les documents consultés ne fournissent aucune garantie sur ce contrat particulier.

**Thinking natif et recherche externe de branches.** Le template local reçoit explicitement `enable_thinking: false`. Le mode natif Google utilise des marqueurs spécifiques ; le guide distingue le préfixe E2B/E4B des préfixes vides ajoutés aux modèles plus grands pour leurs canaux fantômes. Il n’y a pas de justification à copier ce préfixe 12B/26B/31B dans E2B sur cette seule base. Désactiver ce canal ne supprime pas les deux générations successives de l’arbre externe d’Assist. Les activer ensemble ajouterait un coût et une exigence de parsing à qualifier, sans bénéfice local mesuré. [Format des prompts Gemma 4](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4), [guide thinking et variantes](https://ai.google.dev/gemma/docs/capabilities/thinking).

Le budget maximal est actuellement 192 jetons pour les racines, puis 384 pour les feuilles ; le contrôle du vrai contexte de 32K et le moteur unique restent en place. Réduire le nombre de passes d’un arbre naïf ne prouve pas une amélioration de latence par rapport à un appel direct. Les scores `fit/grounding` proviennent du même modèle que les propositions : ils permettent un tri déterministe, pas une confiance calibrée ni une preuve de vérité.

## Ce que voient le planificateur et l’exécuteur

Une projection isolée a utilisé les 31 définitions de production et le template canonique réel, via Python Jinja, sans poids ni inférence. Le catalogue du planificateur conserve exactement `name` et `purpose` : première phrase, bornée à 160 octets UTF-8. L’exécuteur reçoit les définitions complètes. Le macro Jinja rend notamment types, descriptions, enums et champs requis ; il ne restitue pas comme champs les clés structurelles `minimum`, `maximum`, `minLength`, `maxLength` et `additionalProperties` relevées dans ces schémas.

Cela ne signifie pas que toutes les bornes disparaissent : la tranche précédente les a aussi exprimées dans plusieurs descriptions, qui survivent au rendu d’exécution.

| Outil | Catalogue de planification | Informations supplémentaires effectivement rendues pour l’exécution |
| --- | --- | --- |
| `weather_forecast` | Coordonnées explicites et confirmation avant envoi à Apple. | Latitude −90…90, longitude −180…180 ; heures 0…12 et jours 0…5 ; zéro conserve les conditions courantes sans ajouter de prévision. Enums d’unité et arguments requis conservés. |
| `text_translate` | Traduire localement un texte. | Langue cible explicite, question si elle manque, détection de la source, téléchargement soumis à demande et confirmation ; texte limité à 4 000 octets. |
| `document_scan` | Scanner un document. | Création d’un document neuf, aucun ID préexistant requis ; choix humain de capturer/enregistrer/annuler ; 1…8 pages. |
| `document_index` | Indexer un document Assist. | ID d’inbox réellement disponible, confirmation, indexation temporaire locale ; expiration 1…7 jours. |
| `message_compose` | Préparer un message dans le composeur Apple. | Email/SMS, destinataire et pièce jointe selon le canal, validation/envoi humain ; aucun envoi automatique ni reçu de livraison. |

La perte de prérequis dans le catalogue abrégé est donc indépendante de l’atténuation apportée aux descriptions d’exécution. Elle peut affecter la qualité d’un choix, mais **ne prouve pas pourquoi les deux racines réelles ont été rejetées** : ces passes n’utilisent pas le macro des déclarations d’outils.

### Reproduction d’un plan valide mais incomplet

Un petit harnais Swift a compilé les sources courantes, en Swift 6 et concurrence stricte, dans l’image locale `swift:6.2-noble`, sans réseau et avec sources montées en lecture seule. Une sortie synthétique choisit `weather_forecast` avec la condition « Coordonnées encore nécessaires ». Elle respecte le schéma, ses quatre feuilles sont valides et ses scores font sélectionner cette branche. Après sélection :

- la garde accepte le nom `weather_forecast` ;
- elle refuse `location_current` comme premier accès ;
- elle refuse aussi une clarification à sa place.

Cette reproduction montre que le schéma et le tri ne vérifient pas la satisfaisabilité des prérequis du premier accès. Elle ne démontre ni que Gemma produit cet arbre, ni qu’une requête météo invalide atteindrait Apple : les validations d’arguments et le consentement restent en aval. La restriction intervient après sélection et ne peut expliquer un rejet antérieur des racines. Une évolution éventuelle devra rendre le **premier accès réellement nécessaire** explicite, ou définir une adaptation contrôlée avant tout effet, puis l’évaluer ; elle ne doit pas supprimer la garde au hasard.

Un autre point architectural est distinct : les racines puis le plan sélectionné, bien qu’étiquetés données non fiables, sont concaténés au SYSTEM. Les champs textuels validés restent produits par le modèle ; la validation syntaxique ne transforme pas une intention impérative en instruction d’hôte fiable. Cela mérite un essai d’injection et une séparation d’autorité. Aucun contournement des permissions n’est établi ici, et la promotion du plan sélectionné se produit trop tard pour être la cause des deux rejets roots. Le présent travail ne déplace aucun message ni contrat.

## Hypothèses falsifiables pour les deux rejets

Les observations complètes restent dans [le relevé iPhone](native30-tree-rejection-2026-10-20.md). Les sorties de 116 et 121 jetons sont sous le plafond 192 ; cela ne renseigne ni leur JSON ni leur conformité. Le moteur revient à `ready`, sans crash consigné. L’absence de `leaves.begin` laisse également ouverte une erreur de construction/tokenisation/budget des feuilles avant la génération.

| Frontière possible | Test déterministe ou preuve discriminante nécessaire | Conclusion actuelle |
| --- | --- | --- |
| JSON entouré de Markdown, prose, troncature ou clés ambiguës | Fixtures EOS avec fences, JSON invalide et clés dupliquées ; motif fermé `json`/`shape`. | Le parseur rejette ces cas. Aucun raw réel disponible pour les attribuer aux essais. |
| Deux branches non distinctes, mauvais ID/mode/nom | Fixtures identiques, IDs invalides et nom hors catalogue ; motifs `distinctness`, `branch`, `unsupported`. | La conformité JSON seule ne suffit pas. Aucune occurrence réelle identifiée. |
| Texte trop long ou interdit | Champ de 73 octets, accents multi-octets, caractères de contrôle ou marqueur réservé ; motif `text`. | La limite porte sur les octets, pas sur les caractères. Fréquence réelle inconnue. |
| Arrêt réservé 50 présenté comme `eos` par l’ancien agrégat | Distinguer localement 1/106, 50, autre stop et longueur, sans journaliser de texte. | Ancien `eos` insuffisant pour trancher. Aucun appel d’outil réel prouvé. |
| Préparation des feuilles avant leur début mesuré | Phase `leaves` et motif `prompt`/`budget`, gardes sur le vrai comptage. | Compatible avec l’absence de début leaves ; non démontré. |
| Plafond de sortie, délai, panne SDK | Motif fermé `length`/`deadline`/`engine`, cause SDK conservée au nettoyage. | Les durées seules n’établissent aucune de ces causes. |

Le correctif source actuel ajoute ces catégories fermées et le code de préparation avant effet, sans contenu privé, sans récupération permissive et sans nouvel essai automatique. Ses 119 contrôles Swift et ses gardes de câblage sont des preuves de contrat sur sorties scriptées, pas une qualification de Gemma. Les prompts de fixture demeurent identiques avant/après ce correctif.

## Prochaines décisions fondées sur des preuves

1. Recueillir le prochain motif fermé sur appareil avant de choisir une correction de format. Un rejet `text` n’appelle pas la même intervention qu’un arrêt 50 ou qu’un échec de préparation des feuilles.
2. Mesurer avec le modèle réel les deux étapes séparément : conformité, premier accès sémantiquement approprié, clarification sans lieu/langue/cible, absence d’ID inventé, réponse conversationnelle sans outil et changement de sujet. Accepter plusieurs stratégies légitimes ; un outil attendu dans un oracle n’est pas une raison d’appeler cet outil.
3. Comparer ensuite une version du catalogue qui conserve les prérequis essentiels, à budget mesuré. Les descriptions d’exécution existantes doivent être conservées. Ne pas présenter une amélioration de schéma ou de prompt comme une amélioration mesurée de raisonnement.
4. Si un décodage contraint est envisagé, qualifier le vocabulaire, les stops 1/106/50 et le passage Swift/C++ du SDK épinglé. L’argument `stopTokenIds` non transmis par sa session actuelle et ses valeurs de vocabulaire par défaut sont documentés séparément dans [les options Core AI](coreai-optimization-options-2026-10-20.md). Ce chemin n’est pas utilisé par les rejets étudiés ; son problème ne les explique pas.

Les deux passes obligatoires, les poids complets, le contexte 32K, le moteur unique et la séparation proposition/validation/consentement/exécution restent des contraintes. Aucun relâchement, fallback d’action ou routeur par mots-clés n’a été introduit. Aucun nouveau succès iPhone, gain de latence, archive iOS ou livraison n’est revendiqué par cette note.

## Preuves locales et limites

Le dossier privé `/tmp/assist-gemma-planning-public-research-20261020/` contient le manifeste des 15 résultats demandés, le reçu du GET public avec SHA, la projection Jinja, le harnais de dépendance du premier accès et son résultat. Il ne contient ni poids ni sortie privée du modèle. Les empreintes des sources utilisées sont conservées avec ces preuves ; la compilation du petit harnais ne type pas le SDK Core AI iOS et ne qualifie aucun service Apple.

Le corpus conversationnel et les observations physiques restent des compléments distincts : [évaluation de dialogues](agent-dialogue-evaluation-research-2026-10-20.md), [étude du décodage contraint](constrained-decoding-research-2026-10-20.md). Cette tranche n’a modifié que la présente note dans le dépôt.
