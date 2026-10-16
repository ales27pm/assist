# Diagnostic d’un chargement natif interrompu

Le candidat `gemma4-e2b-32k-group8-rms-fp32io` ferme le build 7 pendant
la création d’un tas Metal/MPSGraph. Le journal ne permet pas d’identifier
la fonction fautive, la taille demandée ou la mémoire disponible. Le
téléchargement est suspendu et les fichiers restent conservés pour l’analyse.

Le diagnostic ajouté au build 8 demande explicitement le chargement d’une
seule des six fonctions du **même asset 32K complet**, avec la préférence
Neural Engine utilisée par le moteur statique. Il utilise les API publiques
`AIModel(contentsOf:options:)` et `loadFunction(named:)`. Il ne crée pas de
moteur de génération et ne modifie pas le préchauffage normal de l’application.
La préparation Core AI peut encore spécialiser le modèle et utiliser son cache.

## Essai sur iPhone

1. Conserver les rapports précédents et décharger tout modèle résident.
2. Choisir le dossier déjà téléchargé `gemma4-e2b-32k-group8-rms-fp32io`.
   Ne pas appuyer sur « Charger le modèle » pour cet essai.
3. Dans « Diagnostic de chargement », garder `extend_1024_8` pour le premier
   contrôle, puis toucher « Tester ce graphe ». Garder Assist au premier plan.
4. Partager le diagnostic de chargement après le résultat. Si l’app se ferme,
   la rouvrir et partager la trace enregistrée **avant tout autre essai**, ainsi
   que le journal iOS. Ne pas relancer automatiquement la fonction.

« Fonction suivante » sélectionne une autre fonction sans la charger. Chaque
demande reste une action explicite. Un résultat `completed` signifie seulement
que cet appel a renvoyé une fonction ; il ne valide ni génération, ni exactitude,
ni chargement cumulé des six fonctions. Le moteur et ses embeddings/états ne
sont pas préchargés dans ce diagnostic : sa mémoire de départ diffère de celle
du parcours normal. Les caches existants restent intacts et leur état n’est
pas mesuré, donc un succès isolé ne démontre pas à lui seul une accumulation.

## Trace enregistrée

Un fichier fixe et borné à 32 Kio est remplacé atomiquement avant la préparation
du modèle, avant le chargement de la fonction, puis après son retour. Une erreur
d’écriture arrête le diagnostic avant l’appel risqué. Le rapport peut être relu
après réouverture de l’app, sans accès au dossier du modèle et sans nouvelle
tentative de chargement. Il ne contient ni chemin, ni prompt, ni texte généré.

Les instantanés contiennent l’empreinte physique du processus, son budget
d’allocation restant, l’état thermique et les observations Metal publiques
disponibles. Ces observations ne donnent ni la taille du tas interne demandé
par MPSGraph, ni le pic réel, ni le placement ANE. La limite d’un buffer Metal
ne doit pas être assimilée à celle d’un tas ou à la RAM libre de l’iPhone.

Une trace restée à `preparing_model` ou `loading_function` indique le dernier
appel enregistré. Elle ne prouve pas, seule, un crash : une fermeture manuelle
ou une interruption système peut laisser la même trace. `SIGABRT` n’est pas
une erreur Swift récupérable par `do/catch` ; la persistance précède l’appel
natif pour conserver l’étape même si aucun résultat ne revient.

## Vérifications

Les contrôles Foundation Swift 6 strict vérifient la persistance avant appel,
les échecs d’écriture, la relecture après réouverture, les données invalides,
les limites de taille, la confidentialité et la durée de vie du modèle et de
la fonction. Ils injectent des mesures synthétiques et ne chargent pas Core AI.
Un JSON émis par ce véritable encodeur Swift passe aussi le parseur TypeScript
sans perdre de champ déclaré. Les tests React Native vérifient la restauration,
le partage, les gardes d’opération et l’absence de tentative automatique.

La compilation iOS et la présence des méthodes dans l’IPA sont vérifiées
séparément à la livraison. Le comportement de cette nouvelle sonde sur iPhone
reste à observer ; les tests du pont simulé ne démontrent pas cette exécution.
