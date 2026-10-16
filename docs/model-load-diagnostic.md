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

## Contrôles supplémentaires et journal physique du 16 octobre

L'utilisateur a également testé `prompt_opt_1024_64`, puis `extend_8192_8`,
dans le même dossier F16. Les deux affichent le même message Foundation ; seul
le dernier essai dispose ici d'un JSON conservé et corrélé au journal système.
Son rapport du build 9, récupéré directement dans les données d'Assist, indique
un début à **15:57:05.113 UTC** et `E_FUNCTION_LOAD_FAILED`, après une préparation
retournée. Les observations avant/après chargement sont à 232,58 et 247,07 ms,
soit **14,48 ms**, mesures et persistance comprises. L'empreinte finale est
**99 895 208 octets**, le budget restant **3 440 097 368 octets** ; ces mesures
ne sont pas celles du premier essai et ne mesurent toujours pas un pic.

Console confirme l'appel à `extend_8192_8` et l'initialisation d'un délégué
MPSGraph depuis un chemin de cache contenant le SHA source F16. Ce chemin
n'est pas une empreinte recalculée des fichiers sélectionnés. Dans la fenêtre
11:57:03–11:57:09 −0400, le système rapporte aussi des refus de lecture de
métadonnées File Provider et d'une information d'espace disque pour le
processus Assist. Ils précèdent le chargement explicite de la fonction et
ne démontrent pas un refus de lecture des poids. Aucune cause précise Core AI,
erreur de compilation ANE ou assertion de tas MPSGraph n'apparaît dans cette
fenêtre conservée. Les erreurs LaunchServices plus tardives accompagnent le
partage du rapport. Aucun de ces messages ne suffit à conclure à une corruption
de cache ou à une panne mémoire. La capture est arrêtée et son assertion de
connexion temporaire a été libérée ; l'utilisateur peut quitter l'app.

## Vérification séparée de l'asset F16

L'action manuelle **« Vérifier l’asset F16 »** lit les deux `metadata.json`,
`main.hash` et `main.mlirb` de l'ancien export `rmscomposite`. Elle compare leurs
tailles et leurs SHA-256 à la référence conservée. `main.hash` contient 32 octets
bruts, comparés également au digest calculé de `main.mlirb`. La lecture se fait
par blocs avec contrôle de stabilité du fichier. Ce contrôle ne prépare aucun
modèle Core AI et ne charge aucune fonction. Il n'établit pas l'intégrité des
contenus PLE/tokenizer ni l'accès aux fichiers depuis un service Core AI.

Le rapport `assistModelAssetDiagnostic` est conservé séparément du dernier
`assistModelLoadDiagnostic`. Une trace interrompue indique uniquement le dernier
fichier commencé. Un résultat « conforme » signifie que les quatre fichiers
lus correspondent à cette référence précise, pas que Gemma peut générer.

Le schéma 3 du diagnostic de chargement ajoute la liste bornée des fonctions
reconnues par `AIModel` après préparation, sa comparaison avec le résumé source
et la présence du descripteur de la fonction sélectionnée. Ces métadonnées sont
enregistrées avant l'unique appel à `loadFunction`; les schémas 1 et 2 restent
lisibles. Aucun tenseur n'est exécuté pour cette inspection.

## Résultats physiques du build 10

Les deux contrôles ont été exécutés sur l'iPhone avec le build 10 le 16 octobre.
Le rapport d'identité commencé à **16:42:37.417 UTC** se termine à `completed` :
les quatre tailles et SHA-256 correspondent à la référence, et le contenu brut
de `main.hash` correspond au digest recalculé de `main.mlirb`. Assist a donc lu
les **1 381 786 497 octets** du bytecode sélectionné. Cette preuve porte sur les
quatre fichiers contrôlés ; elle ne démontre pas leur lecture par un service
système ni l'intégrité des fichiers PLE/tokenizer.

Le rapport de chargement commencé à **16:45:08.421 UTC** échoue ensuite sur
`extend_1024_8`, avec le même `E_FUNCTION_LOAD_FAILED` et l'unique erreur
`Foundation._GenericObjCError`, code `0`. Le schéma 3 confirme avant cet appel :

- les **neuf fonctions** attendues, sans troncature de la liste ;
- la correspondance de leur ensemble de noms avec le résumé source ;
- la présence du descripteur de `extend_1024_8` dans le modèle préparé.

Les observations encadrent le chargement à 249,797458 et 276,593875 ms, soit
**26,796417 ms**, mesures et persistance comprises. L'empreinte finale observée
est de **47 892 344 octets**, le budget restant de **3 492 100 232 octets** et le
total Metal de **81 920 octets**. Ces instantanés ne mesurent pas les allocations
transitoires et ne permettent toujours pas d'identifier une cause mémoire.
Les deux JSON physiques passent le parseur TypeScript livré sans perte de champ.

Ce résultat ferme les pistes d'une différence des quatre fichiers sélectionnés,
d'un nom de fonction absent et d'un descripteur absent pour cet essai. Il ne
prouve pas que les poids ou ressources de la fonction ont été chargés : Apple
décrit `AIModel` comme un objet léger, les poids et buffers appartenant aux
[fonctions chargées](https://developer.apple.com/documentation/coreai/aimodel).
Le PLE est une entrée tensorielle explicite du graphe ; la sonde n'ouvre pas son
fichier ni le tokenizer avant l'appel qui échoue. L'accès de sécurité au dossier
reste retenu jusqu'à la fin de l'opération native.

Le contrôle **« Diagnostic de calcul » → « Tester le calcul natif »** a ensuite
été exécuté dans ce même build, sans chargement normal de Gemma. Ses petits
modèles intégrés utilisent aussi `AIModel` et `loadFunction(named:)`.

| Variante / préférence | Sorties mesurées | Résultat du build 10 |
| --- | ---: | --- |
| `f16_boundary` / Neural Engine préféré | 0/12 | 12 erreurs natives Foundation génériques |
| `f16_boundary` / CPU seul | 12/12 | 12 réussites, maximum 1 ULP |
| `f32_boundary` / Neural Engine préféré | 12/12 | 12 réussites, maximum 1 ULP |
| `f32_boundary` / CPU seul | 12/12 | 12 réussites, maximum 1 ULP |

Le total de **12 échecs sur 48** masque un changement par rapport au build 7 :
les 12 cas F16 avec préférence Neural Engine produisaient alors des sorties
avec écarts numériques jusqu'à 12 ULP. Ils renvoient maintenant une erreur
`Foundation._GenericObjCError`, code `0`, sans `actualSHA256`, lignes comparées
ou mesure ULP. Les 36 autres sorties ont exactement les mêmes SHA-256 que dans
le rapport physique du build 7. Les identités d'assets et manifests sont aussi
identiques. Le JSON du build 10 passe le parseur TypeScript livré.

Les durées des erreurs F16 sont propres à chaque cas (3,3755 ms, puis
0,699958 ms, etc.). Dans le source livré, un échec global de préparation
produirait douze durées issues du même chronomètre, donc non décroissantes.
Ces erreurs passent par le traitement individuel après préparation et contrôle
des douze noms. Le rapport ne distingue cependant pas le chargement de la
fonction, l'accès aux buffers et son exécution ; il ne faut pas les présenter
comme douze échecs de chargement déjà localisés.

Cette observation montre que le défaut ne se limite pas au gros modèle Gemma
ni à son dossier externe. Elle ne prouve pas une cause commune aux deux erreurs,
un défaut matériel ANE ou le placement effectif de toutes les fonctions réussies.

La reprise a été exécutée avec un flux Console vérifié actif à **16:54:26 UTC**.
Les 48 résultats reproduisent les mêmes erreurs et empreintes de sortie que le
premier essai du build 10. Les journaux à **12:55:17 −0400** contiennent les
48 chargements de fonctions dans le même ordre que le JSON. Pour chacun des
douze premiers cas F16, ils montrent successivement le chargement demandé,
un échec de chargement précompilé dans `aned`, le retour `success=0` avec
`error=(null)` côté Assist, puis l'erreur de chargement de
`MPSGraphNDXRuntime.mm:603`. La première séquence s'étend de 12:55:17.379698 à
12:55:17.381145. L'échec de ce contrôle est donc maintenant localisé au
chargement précompilé, avant une sortie numérique.

Le service écrit aussi `existsInCache=0` et « Sandbox extension is nil/not
valid ». Le premier concerne son propre cache ANE, pas nécessairement le cache
de spécialisation Core AI. Le second message apparaît ailleurs dans la même
capture avant un chargement réussi pour un appelant masqué : ce texte seul ne
prouve pas un refus d'accès. Le chemin du modèle, son identité de signature et
la raison sous-jacente restent masqués ou nuls. Ces observations ne suffisent
pas à conclure à une corruption de cache ou à un défaut d'autorisation précis.

Le groupe F16 CPU commence à 12:55:17.399137 et réussit. Le groupe F32 avec
préférence Neural Engine commence à 12:55:17.414510 ; on observe ensuite une
création de programme par `aned`, un retour de chargement réussi et des requêtes
ANE côté Assist. Le groupe F32 CPU commence à 12:55:17.491183 et réussit aussi.
Ces messages précisent cet essai ; ils ne qualifient pas l'ensemble de Gemma
et ne remplacent pas la valeur `aneExecution: unverified` du rapport.

La capture est arrêtée et l'assertion temporaire de connexion libérée. Un
inventaire CoreDevice en lecture seule retrouve les entrées compilées F16,
F32 et Gemma ; leurs trois petits `manifest.plist` et les deux graphes compilés
des petites fixtures ont été copiés pour comparaison, sans charger de fonction
ni modifier ces fichiers. Aucun gros fichier de poids n'a été copié. La présence
d'une entrée ne démontre pas que toutes ses ressources peuvent être chargées.
Les attributs compilés donnent une différence supplémentaire : les douze entrées
numériques F16 et les six entrées Gemma portent `mps.fullyPlacedOnANE` et
`mps.noGPUActivity`, tandis que les douze entrées numériques F32 portent
`mps.disableNDX`. Cela rapproche les deux modèles F16 du même parcours compilé,
sans prouver une cause commune ni un placement effectif de Gemma. Ces attributs
internes sont des observations ; aucun réglage privé n'est ajouté à l'app.
Les manifests ne contiennent aucune URL absolue périmée ni référence concrète
à un fichier manquant. Leurs identifiants de ressources correspondent aux tables
d'offsets et les offsets observés restent dans les tailles des fichiers ; cela
ne donne pas l'emplacement ni l'accessibilité du binaire ANE précompilé.
Le contexte 32K, group8, la préférence Neural Engine et les exports restent
inchangés. Aucune purge ou modification manuelle des caches n'a été effectuée ;
Core AI peut toujours les utiliser pendant les contrôles. Aucune nouvelle
reprise identique n'est demandée.
