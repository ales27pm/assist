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

Les nouveaux rapports de schéma 2 ajoutent un UUID d’essai, son début en UTC,
le PID du processus et le chemin d’entrée constant `single_function_load_probe`.
Ces champs servent à rapprocher une trace d’un journal iOS ; le temps mural
n’est pas utilisé pour calculer les durées. Une erreur Swift conserve jusqu’à
trois domaines `NSError`, codes signés représentables exactement en JSON et
noms de types. Les libellés non conformes sont masqués et les messages libres,
chemins et autres données `userInfo` ne sont pas exportés. L’ancien schéma 1
reste lisible avec ses informations d’origine, sans lui inventer une identité.

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

La compilation iOS et la présence des méthodes dans l’IPA ont été vérifiées
pour le build 8 livré. Les tests du pont simulé ne démontrent pas son exécution
sur l’iPhone ; les observations reçues sont décrites ci-dessous.

## Observation du build 8, le 16 octobre

Le rapport partagé pour `gemma4-e2b-32k-group8-rms-fp32io` reste à
`loading_function` pour `extend_1024_8`. La préparation a rendu la main :
le dernier instantané, pris à 226,73 ms, précède `loadFunction(named:)`.
Il indique une empreinte de **36 767 632 octets**, un budget d’allocation restant
de **3 503 224 944 octets**, un état thermique nominal et le mode économie
d’énergie désactivé. Ce sont des observations **avant** l’appel, pas le pic
pendant le chargement. Le marqueur ne fournit ni durée jusqu’au crash, ni
taille du tas Metal demandé, ni placement du modèle.

L’utilisateur confirme une fermeture brutale après « Tester ce graphe ».
Le journal iOS fourni pour le build 8 montre la même assertion Metal dans
`createMemrefHeap` que le build 7. Son UUID de binaire est identique à celui
de l’IPA livré. Cependant, ses cadres applicatifs nomment
`StaticShapeEngine.warmup` et `AssistInferenceCoordinator.load(path:)`, alors
que la sonde appelle directement `AIModel.loadFunction`. Le rapport ne contient
pas d’identifiant d’essai, d’horodatage UTC ou d’identité de processus permettant
de résoudre cette correspondance. Le bouton et le pont généré appellent bien
la méthode dédiée dans le source livré ; le test de l’écran complet vérifie
aussi cette séparation à la frontière native simulée. Ces contrôles ne
remplacent pas une preuve du chemin exécuté sur l’iPhone.

Une lecture seule des deux assets F16 et FP32 trouve les mêmes **275 résultats
`lut_to_dense`** dans `extend_1024_8`, représentant **3 726 114 816 octets
logiques** si tous ces poids sont développés. La table d’embeddings déquantifiée
déclarée dans le graphe représente **805 306 368 octets**. Le plus grand résultat
individuel observé est cette table, inférieur à la limite de buffer de 4 Gio
rapportée par Metal. Ni la somme de ces volumes, ni la limite de buffer ne
donne la taille du tas interne ou les durées de vie simultanées.

Le candidat FP32 conserve ces poids en F16 dans l’IR ; il ne double pas tous
les poids. Une matérialisation dense liée à un changement de placement est
une hypothèse à vérifier sur le modèle compilé, pas une allocation mesurée.
Les [règles d’Apple pour le Neural Engine](https://github.com/apple/coreai-models/blob/main/skills/skills/model-authoring/references/neural_engine_rules.md)
indiquent que les opérations FP32 peuvent être exécutées sur GPU ou CPU.
Cette possibilité ne démontre pas le placement effectif de cet export.
Le contrôle demandé utilise l’ancien export F16 avec le même bouton et la
même fonction dans le build 8. Il renvoie `failed` et `E_FUNCTION_LOAD_FAILED`,
sans fermeture signalée dans ce rapport. L’appel est encadré par les mesures
à 244,87 ms et 270,95 ms, soit 26,08 ms ; l’empreinte finale est de
39 470 968 octets et l’observation Metal reste à 81 920 octets. Le code générique
du build 8 ne conserve pas la raison native de cette erreur récupérable.

Le source Apple épinglé initialise le modèle avec les mêmes options de
spécialisation dans les deux parcours. Le chargement normal exécute ensuite
`load_embeddings`, crée les états et entrées, puis préchauffe les six fonctions ;
la sonde demande directement la fonction sélectionnée. Cette différence rend
le contrôle utile, mais ne permet pas d’attribuer son erreur à l’absence des
embeddings sans connaître l’erreur native. L’[exemple public de chargement Apple](https://developer.apple.com/documentation/coreai/integrating-on-device-ai-models-in-your-app-with-core-ai)
utilise lui aussi l’initialisation du modèle suivie de `loadFunction(named:)`.
Aucun nouvel export ni changement de contexte ne découle de ces seules traces.

## Contrôle F16 du build 9

Le rapport reçu le 16 octobre confirme l'exécution du build 9 sur l'iPhone.
La sonde conserve cette fois l'identité de l'essai et l'erreur native pour
`gemma4-e2b-32k-group8-rmscomposite`, toujours sur `extend_1024_8` avec le
contexte déclaré de 32K. La préparation retourne, puis le chargement de la
fonction échoue avec `E_FUNCTION_LOAD_FAILED`. Les observations encadrent cet
appel à 247,66 ms et 267,80 ms, soit **20,15 ms**, persistance et mesures
comprises. L'empreinte finale observée est de **41 043 808 octets**, le budget
d'allocation restant de **3 498 948 768 octets** et le total Metal reste à
**81 920 octets**. Ces instantanés ne mesurent pas le pic de l'appel.

L'unique erreur exportée porte le domaine et le type
`Foundation._GenericObjCError`, avec le code `0`. Dans le
[source public de Swift](https://github.com/swiftlang/swift/blob/swift-5.0-RELEASE/stdlib/public/SDK/Foundation/NSError.swift#L31-L52),
ce type représente un échec Objective-C sans objet `NSError` fourni. Le code
zéro de cet objet de remplacement ne signifie pas une réussite et ne décrit
pas une panne Core AI précise. Le rapport ne donne aucune erreur sous-jacente
supplémentaire ; exporter une description plus longue ne garantit donc pas
une cause supplémentaire. Ce résultat récupérable ne reproduit pas à lui seul
l'assertion Metal observée avec le candidat FP32.

L'utilisateur a ensuite essayé le chargement normal du **même dossier F16 dans
le même build 9**, sans génération. Il rapporte également un message
`Foundation._GenericObjCError`. Le défaut ne se limite donc pas à la sonde
directe. Le message du parcours normal ne permet toutefois pas de situer son
appel fautif : les deux erreurs affichées ne prouvent pas une cause interne
identique. Le dossier est annoncé dans « Sur mon iPhone » ; la lecture complète
de ses fichiers par Core AI n'est pas vérifiée par cette indication.

Une relecture des deux fichiers `main.mlirb` sources confirme les SHA-256
stockés dans leurs `main.hash`, avec des identités différentes :

| Export source | Octets `main.mlirb` | SHA-256 |
| --- | ---: | --- |
| F16 `rmscomposite` | 1 381 786 497 | `bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362` |
| FP32 `rms-fp32io` | 1 381 891 930 | `bc457ddb599c0bf21c5c65b6b9042f5bd1c9bbcba8d3833d96d3dde08200daf3` |

Ces empreintes concernent les sources conservées sur l'ordinateur. Le rapport
du build 9 n'inclut pas l'empreinte du modèle sélectionné sur le téléphone ;
le nom issu des métadonnées ne remplace pas une vérification de cette copie.
Le JSON physique reçu passe sans perte de champ le parseur TypeScript et le
décodage, la validation puis le réencodage Foundation Swift 6 strict.

La preuve suivante recherchée est le journal système autour d'un échec F16,
afin de chercher une cause que l'erreur Swift ne transmet pas. Avec un Mac,
[Console permet de consulter les messages d'un iPhone connecté](https://support.apple.com/guide/console/log-messages-cnsl1012/mac) :
sélectionner l'iPhone, démarrer le flux, effectuer un seul chargement F16,
puis arrêter le flux après l'erreur et conserver les messages de cette fenêtre
avec leur heure, processus, sous-système et texte complet. Examiner les
messages d'Assist et ceux liés à Core AI, ANE et MPSGraph ; limiter d'emblée
la collecte au seul processus Assist pourrait omettre un service système.
Cette collecte ne garantit pas que le framework journalise une cause.

Aucune dépendance aux embeddings, corruption de cache, insuffisance de mémoire
ou erreur de placement n'est établie à ce stade. La réussite antérieure d'un
autre build ne remplace pas le contrôle du build 9, et ce contrôle ne qualifie
pas le modèle FP32.
