# Qualification physique : 8K, puis 32K

Ce document est un **protocole à exécuter**, pas un rapport de réussite. Un build
JavaScript, des tests avec mocks ou un simulateur ne qualifient ni Core AI, ni la
mémoire d’un iPhone, ni son ANE. Conserver les résultats privés jusqu’à retrait
des conversations, chemins personnels, noms d’appareil et identifiants.

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
   place de la sortie ; tester une demande au-delà de la limite et son rejet.
3. **32K** : uniquement avec l’export 32K, répéter les cas courts puis tester des
   longueurs réelles autour de 8K, 16K et près de 32K. Le total entrée formatée +
   sortie doit rester dans la capacité effective. Ne jamais annoncer « testé à
   32K » sur la seule base du réglage sélectionné.
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

Tester l’annulation pendant chargement, préremplissage et décodage ; le retour
à l’écran d’accueil pendant chaque phase ; le retour actif ; puis un nouvel
essai. Vérifier absence de résultat périmé, opérations concurrentes refusées,
état UI cohérent et déchargement effectif. Une pression mémoire ne se déduit pas
d’un bouton grisé ; contrôler les mesures et les rapports système.

Tester hors réseau **après** transfert complet des ressources, en build Release
avec JavaScript embarqué : Metro en mode Debug est une dépendance de
développement, pas une preuve de dépendance serveur de l’inférence.

## Décision

Publier séparément : tests de contrat, compilation native, export obtenu,
chargement physique, génération physique, qualité à la longueur réelle testée,
stabilité répétée et attribution ANE. Un seul point non établi reste explicite.
Une qualification 8K n’autorise pas une promesse 32K ; une fenêtre 32K n’est ni une
mémoire durable ni une garantie de précision parfaite.
