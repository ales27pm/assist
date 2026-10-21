# Build 30 : rejets de préparation observés sur iPhone

Les exports fournis par Alexis le 20 octobre proviennent de la build native 30, sur iOS 27.2, avec le modèle complet `gemma4-e2b-32k-group8-abliterated-rmscomposite` et un contexte de 32 768 jetons. Ils constituent une preuve d'exécution réelle et d'échec du parcours conversationnel. La compilation et la disponibilité TestFlight ne démontraient pas ce parcours.

| Demande naturelle visible | Entrée / sortie de la passe roots | Premier jeton | Durée de génération roots | Durée de préparation jusqu'au rejet |
| --- | --- | --- | --- | --- |
| Quel temps fait-il ? | 1 516 / 116 jetons | 1,347 s | 4,732 s | 5,638 s |
| Recherche pour « meta-cognition » sur internet | 1 525 / 121 jetons | 1,328 s | 4,798 s | 5,707 s |

Il s'agit de deux demandes de la même session, avec `CONVERSATION_RESET` avant la seconde. Chaque demande possède une seule génération mesurée `:tree-roots`, classée `eos`, puis un agrégat `tree_rejected`. Aucun début de génération `:tree-leaves` ni passe d'outil n'apparaît. Les deux événements `GENERATION_REJECTED` par demande proviennent des couches de gestion d'erreur ; ils ne constituent pas deux nouvelles générations.

## Ce que ces preuves ne permettent pas de conclure

La build 30 ne conserve ni la sortie privée, ni le jeton d'arrêt exact, ni la règle de validation rejetée. `eos` peut aussi désigner la frontière réservée 50 dans le consommateur courant, alors que la préparation exige 1 ou 106. L'absence de début de la passe leaves ne distingue pas une validation roots rejetée d'un échec de préparation/tokenisation des feuilles avant leur génération. Un JSON mal formé, une limite de champ ou un problème de terminaison restent donc des hypothèses, pas une cause établie.

Le moteur revient à `ready`, avec état thermique nominal. Aucun crash n'est consigné. La pression mémoire reste `unknown` et le pic échantillonné d'environ 1,73 Go n'est pas un pic exhaustif. Le budget d'allocation restant ne représente pas la RAM libre. Ces observations n'établissent ni une fuite mémoire, ni une saturation, ni une exécution ANE.

La capture du deuxième essai affiche le profil outils iOS. Le parcours `generateResearch` et son profil public isolé sont actuellement dans le workspace natif séparé, pas dans l'envoi du fil principal. Ce test ne démontre donc aucun appel de recherche ni aucune panne du serveur Ubuntu. Raccorder ce parcours au fil devra conserver l'isolation des données privées et vérifier le service réellement disponible ; il ne faut pas ajouter les outils web au contexte iOS à l'aveugle.

## Défauts établis à corriger

Le catch du parcours outils dans `App.tsx` remplace toute erreur sans carte d'échec par une alerte sur des actions potentiellement incertaines. Le motif natif de préparation est ainsi perdu. L'absence de carte ne prouve cependant pas à elle seule qu'aucun effet n'a eu lieu : seul un code natif fermé, émis avant toute exécution, peut établir cette phase. Les reçus et cartes du tour courant doivent garder priorité.

Le message « références précédentes écartées » apparaît aussi après un premier tour échoué : le compteur compte les échanges non réutilisables, même sans anciennes références. La notice doit décrire cette omission sans prétendre que le chat visible est supprimé. La barrière empêchant une courte réponse de réactiver un ancien objectif doit rester en place.

La correction ajoute une classification de préparation et des motifs diagnostiques fermés, sans sortie privée ni récupération permissive du JSON. Elle ne change pas les prompts sur une hypothèse, ne désactive pas l'arbre obligatoire et ne réessaie aucune action. Elle ne prouve pas encore que Gemma produira un arbre accepté sur ces deux demandes.

Preuves originales : deux pièces jointes `texte 34` et `texte 33`, SHA-256 respectifs `d176cf2c9345a3602fcd77d966aaa0e6d77ceeba398b67686a4b4b852a23ecc2` et `f6bef2f3e81cb7378889f6be3691b60adcad1f24d901c92c492f1fcfe3095d45`. Synthèse privée et contrôles de cette tranche : `/home/ales27pm/.local/share/assist/native30-tree-rejection-20261020/`.

## Correction source et validation

Le code fermé `E_THOUGHT_TREE_PREPARATION` est construit uniquement dans le helper de préparation, avant les boucles d'outils et la prise du profil de recherche. Les erreurs moteur conservent leur cause et leur nettoyage existants ; l'annulation reste distincte. Les rejets ultérieurs à un reçu ne reçoivent pas ce code. L'interface n'utilise le message de préparation que sans carte du tour courant ; elle n'affiche jamais la cause brute. Le contrôleur vocal reçoit lui aussi ce message fixe, sans lecture ni nouveau calcul automatique.

Les événements diagnostiques ne contiennent que des phases et motifs fermés : racines/feuilles/inconnu et contexte, prompt, budget, JSON, structure, branche, texte, alternatives identiques, option non admise, frontière 50, autre stop, longueur, délai, moteur ou inconnu. Ils restent bornés, refusent les identités périmées et doublons, puis survivent à l'archivage du moniteur. Aucun raisonnement, nom d'outil, argument, contenu ou jeton arbitraire n'est ajouté aux exports.

| Vérification fraîche | Résultat et limite |
| --- | --- |
| `npm run check` | Exit 0 : 1 858 tests / 61 suites Jest, TypeScript, ESLint sans erreur, Codegen et contrôles workspace/capacités/évaluation. Un avertissement React shadow préexistant demeure. |
| Régressions UI ciblées | 150 tests réussis sur trois suites ; nouveaux cas écrit/voix, absence de relance/TTS, ancien contexte et priorité des reçus. Module natif simulé. |
| Contrôleur Swift sur Mac | Swift 6, concurrence stricte et avertissements bloquants : 100 contrôles de la base, puis 119 du candidat. Modèle scripté, aucun outil exécuté. |
| Prompts de fixture | Octets identiques avant/après, SHA-256 `04219d7bd7b8f7e17c28765572d3fbdb2aeec03f1a585a56321e22645ed168b7`. Ne démontre pas la sortie réelle de Gemma. |
| Moniteur Swift sur Mac | Compilation stricte et exécution réussies : métriques, diagnostics fermés, rejets périmés/doublons, vie privée, archive/reprise, checkpoint après SIGKILL d'un sous-processus de test. |
| Câblage CoreAI | 21 gardes source Python et analyse syntaxique Swift réussis. Aucun typage CoreAI complet, aucune édition de liens ou archive iOS du correctif. |

Les preuves Swift et les empreintes des sources réellement compilées se trouvent également dans `/home/ales27pm/.local/share/assist/thought-tree-preparation-20261020/`. La première exécution du moniteur sur le staging Mac a rencontré des chemins source absents ; le staging et son répertoire courant ont été complétés, puis le même harnais a passé sans affaiblissement de ses gardes.

## Décodage JSON : preuve préparatoire séparée

Un environnement Python isolé a exercé **xgrammar 0.2.2 réel**, avec le vocabulaire Gemma de 262 144 entrées et le mode explicite `BYTE_FALLBACK`, sur un JSON synthétique Unicode de 62 jetons. Aucun modèle, poids ou serveur n'a été exécuté. Avec les stops explicites 1 et 106, les masques bloquent ces EOS avant la fermeture et les acceptent ensuite. Sans stops explicites, cette API détecte 1 et 212 : le jeton 106 peut entrer dans certaines chaînes et n'est pas accepté comme terminaison. Le jeton réservé 50 est aussi autorisé dans 23 préfixes de chaînes JSON ; une grammaire syntaxique seule ne satisfait donc pas notre contrat métier.

Une surcouche testée sur de vrais masques et tenseurs CPU interdit 50 en permanence et les EOS avant complétion. Le choix terminal utilise des logits synthétiques : il ne constitue pas un échantillonnage de Gemma. Il faut encore qualifier le passage Swift/C++, le mode de vocabulaire, les stops et l'exécution du moteur avant toute activation. Cette preuve ne démontre ni la cause des rejets actuels, ni un gain de qualité ou de latence. Les résultats positifs et le premier résultat négatif non corrigé sont conservés dans le sous-dossier privé `constrained-feasibility/`.

Les modifications Swift nécessitent un nouveau binaire. Cette tranche ne lance aucune build, OTA, soumission ni modification de service. La cause exacte du rejet des deux arbres réels reste inconnue, et aucun succès iPhone corrigé n'est revendiqué. Le correctif source traite les erreurs et l'observation ; il ne suffit pas à déclarer le parcours naturel ToT fonctionnel.
