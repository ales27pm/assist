# Qualification physique : 8K, puis 32K

Ce document est un **protocole à exécuter**, pas un rapport de réussite. Un build
JavaScript, des tests avec mocks ou un simulateur ne qualifient ni Core AI, ni la
mémoire d’un iPhone, ni son ANE. Conserver les résultats privés jusqu’à retrait
des conversations, chemins personnels, noms d’appareil et identifiants.

Avant de transférer une nouvelle recette de compression, comparer le checkpoint
source et les poids compressés avec le
[jeu de régression numérique](gemma-numeric-fidelity.md#contrôle-de-qualité-avant-transfert).
Le premier export 32K passe les contrôles de structure mais échoue au calcul des
carrés ; un inventaire et un graphe valides ne suffisent pas à valider ses réponses.

## Conditions et identité

Pour chaque série, consigner la version de l’app, la révision Git, la version iOS,
le type d’iPhone sans identifiant unique, le contexte effectivement exporté, la
révision des poids, les empreintes du bundle et du tokenizer, les versions
d’export et la présence de caches de spécialisation. Ne pas effacer les modèles
ou données d’une autre application.

Séparer deux situations : démarrage après terminaison normale de l’app et
réutilisation dans le même processus. Cela ne suffit pas à certifier un cache
compilateur « froid » : noter séparément son état connu ou inconnu. Ne jamais
désinstaller une application contenant les données utilisateur pour fabriquer
un essai froid.

## Progression

1. **8K, séquence courte** : importer, charger, produire 64 puis 256 jetons si
   l’EOS ne survient pas avant, annuler, décharger, recharger. Vérifier la réponse
   réellement produite et le statut final ; une limite demandée n’est pas une
   longueur effectivement générée.
2. **8K, contexte long** : remplir progressivement le contexte avec des textes
   de test publics ou synthétiques. Compter les vrais jetons après application
   du template, avec instructions et historique. Réserver explicitement la
   place de la sortie ; vérifier qu’un budget demandé supérieur au contexte
   restant est ramené à ce reste. Un budget absent (`nil`) utilise aussi ce
   reste ; zéro et les valeurs négatives sont refusés. Vérifier séparément le
   rejet d’une entrée formatée qui remplit ou dépasse toute la capacité.
3. **32K** : uniquement avec l’export 32K, répéter les cas courts puis tester des
   longueurs réelles autour de 8K, 16K et près de 32K. Le total entrée formatée +
   sortie doit rester dans la capacité effective. Ne jamais annoncer « testé à
   32K » sur la seule base du réglage sélectionné. Pour le jeu guidé actuel,
   utiliser **64 jetons de sortie pour les huit cas courts**, puis **256 pour
   chacun des trois textes longs**, dans une nouvelle conversation à chaque
   fois. Leurs six lignes attendues nécessitent 89 jetons avant EOS ; les
   [rapports 17 à 19](gemma-numeric-fidelity.md#contre-vérification-iphone--rapports-9-à-19)
   s’arrêtent à 64 et ne qualifient donc pas la réponse complète. Les
   [rapports 21 à 23](gemma-numeric-fidelity.md#rapports-20-à-23--diagnostic-natif-et-récupération-longue)
   reprennent ensuite ces trois textes avec 256 : six lignes exactes sur six,
   89 jetons et EOS à chaque palier, sur un seul passage par cas. Ces résultats
   concernent le dossier `group8` ; l’[essai HF32 distinct](gemma-numeric-fidelity.md#essai-séparé-avec-normalisations-hf32)
   est suspendu pendant l’investigation des journaux d’échec du chargement.
4. **Répétabilité** : au moins trois répétitions par scénario pertinent,
   démarrage et réutilisation séparés. Conserver les échecs, pas seulement le
   meilleur passage. Réduire la charge si l’appareil chauffe ou devient instable.

## Mesures

| Donnée | Exigence de preuve |
| --- | --- |
| Chargement / spécialisation / tokenisation / préremplissage | Durées séparées quand instrumentées ; sinon total étiqueté comme tel |
| Premier jeton et débit | Horodatages natifs, jetons réellement émis, durée de décodage ; ne pas remplacer les jetons par des caractères |
| Mémoire | Empreinte physique, RSS et mémoire disponible, avec unité et instant |
| Maximum mémoire | Fréquence d’échantillonnage, maximum observé ; ce maximum est une borne basse du pic réel, pas le pic garanti |
| Température | État thermique iOS et évolution ; ce n’est pas une température en degrés |
| Disque | Différence sur l’intervalle de l’essai, spécialisation comprise ; ne pas attribuer un compteur cumulatif à une seule génération |
| Échec | Étape, domaine/code, annulation ou crash, rapport système si disponible |
| Matériel | Trace Instruments/outil Apple compatible attribuant l’activité aux unités ; disponibilité théorique ≠ exécution ANE |

Si le prototype ne fournit pas encore une mesure, noter **non instrumenté** et
la relever avec un outil approprié. Ne pas inventer la valeur ou déduire le pic
intermédiaire de deux photographies mémoire avant/après.

Pour limiter le coût du décodage pendant les sorties longues, le texte affiché
avance par instantanés espacés d’environ 1/64 de la longueur déjà produite.
Les compteurs restent actualisés entre ces instantanés ; la fin de génération
et l’annulation restituent le préfixe complet. Ce contrôle du coût ne constitue
pas une mesure de performance Core AI sur iPhone.

## Qualité du contexte, pas seulement capacité

Utiliser des faits synthétiques vérifiables placés à environ 5 %, 25 %, 50 %,
75 % et 95 % de l’entrée formatée. Demander une valeur exacte, puis plusieurs
valeurs et leur relation ; varier les faits et les positions entre répétitions.
Inclure des distracteurs semblables et une question dont la réponse est absente.
Mesurer exactitude, abstention, erreurs et latence. Un succès sur un seul
« needle » ne valide pas toute la fenêtre.

Comparer 8K et 32K sur un corpus français identique : conversation, résumé fidèle,
recherche de faits éloignés et petites tâches de code sans exécution. Les
capacités d’outils du modèle de base ne prouvent pas qu’un orchestrateur d’actions
fonctionne dans l’app.

## Annulation et récupération

Tester l’annulation d’une génération pendant le préremplissage et le décodage ;
le retour à l’écran d’accueil pendant ces deux phases (qui demande aussi
l’annulation), le retour actif, puis un nouvel essai. Vérifier absence de
résultat périmé, opérations concurrentes refusées, état UI cohérent et
déchargement effectif après la fin de l’opération.

L’annulation du chargement et sa gestion lors du passage en arrière-plan ne
sont pas prises en charge par ce prototype. Attendre la fin du chargement en
gardant l’app active ; ne pas présenter ces deux scénarios comme des cas de
récupération qualifiés. Une pression mémoire ne se déduit pas d’un bouton
grisé ; contrôler les mesures et les rapports système.

Tester hors réseau **après** transfert complet des ressources, en build Release
avec JavaScript embarqué : Metro en mode Debug est une dépendance de
développement, pas une preuve de dépendance serveur de l’inférence.

## Décision

Publier séparément : tests de contrat, compilation native, export obtenu,
chargement physique, génération physique, qualité à la longueur réelle testée,
stabilité répétée et attribution ANE. Un seul point non établi reste explicite.
Une qualification 8K n’autorise pas une promesse 32K ; une fenêtre 32K n’est ni une
mémoire durable ni une garantie de précision parfaite.
