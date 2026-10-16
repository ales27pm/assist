# Reconstruction ciblée de la préparation Core AI

Le build 11 ajoute deux actions manuelles séparées du chargement normal. Elles
répondent aux échecs de chargement précompilé F16 observés dans le build 10 ;
la corruption d'un cache et la cause interne de ces erreurs ne sont pas établies.

Chaque action vérifie les sources avant d'appeler une seule fois l'API publique
[`AIModelCache.default.deleteEntry(for:options:)`](https://developer.apple.com/documentation/coreai/aimodelcache/deleteentry(for:options:))
avec la même préférence Neural Engine que le contrôle d'origine. Core AI peut
ensuite reconstruire cette spécialisation lors du diagnostic. Une erreur de
suppression arrête l'opération. Aucun modèle préparé n'est créé par la
vérification préalable ; le verrou natif exclut un modèle résident et les autres
opérations. Pour un dossier sélectionné, l'accès de sécurité reste retenu jusqu'au
retour natif.

Les fichiers source, le contexte 32K, group8, les exports, les tolérances et les
64 ressources numériques intégrées restent identiques. Les entrées CPU et F32
ne sont pas visées. Il n'y a ni purge générale, ni nouvelle option privée,
ni réparation automatique au démarrage ou après un échec.

## Essai physique dans l'ordre

1. Décharger tout modèle résident, puis garder Assist au premier plan.
2. Toucher **« Réparer le calcul natif »** une seule fois, puis partager son
   rapport. Cette action vise uniquement la petite fixture F16 intégrée,
   vérifiée par ses empreintes de modèle et de manifest, puis exécute le même
   contrôle de 48 cas.
3. Examiner séparément les erreurs natives, les sorties produites et les écarts
   numériques. Retrouver 48 sorties avec 12 écarts F16 serait différent des
   36 sorties et 12 erreurs natives du build 10 ; cela ne serait pas une
   qualification numérique complète.
4. Après examen du résultat des petites fixtures, sélectionner l'ancien dossier
   `gemma4-e2b-32k-group8-rmscomposite` et toucher **« Réparer le chargement Gemma »**
   une seule fois. Les quatre fichiers d'identité sont relus et comparés aux
   références du build 10 avant toute suppression. Seul `extend_1024_8` est
   ensuite chargé, sans moteur de génération, embeddings préchargés ni tokenizer.
5. Partager le rapport après retour. En cas d'interruption, rouvrir Assist et
   partager la dernière trace avant tout nouvel essai. Aucune reprise n'est
   déclenchée par cette relecture.

Le succès de ce chargement isolé ne prouve ni la génération normale, ni la
fidélité numérique de Gemma, ni son placement matériel. Ces étapes restent
séparées.

## Résultat physique retrouvé — build 11

La conversation `01a145cf-8562-71a3-8628-63d4914353c0` contient ensuite le
rapport physique de cette réparation sur le modèle Google `rmscomposite`
épinglé, sous iOS 27.2 (24B5110a). La suppression ciblée revient, puis le
diagnostic `extend_1024_8` termine avec l’état `completed` : préparation en
108,677 s, chargement de fonction en 94,16 ms. Une seconde sonde, dans le même
processus, termine aussi : préparation 5,96 ms et chargement 64,32 ms.

Ces deux essais sont compatibles avec une préparation coûteuse suivie d’une
réutilisation. Ils ne démontrent pas qu’une ancienne entrée était corrompue,
ni que le cache persiste après relancement. L’utilisateur confirme ensuite les
réponses attendues des tests courts proposés ; cette confirmation ne comporte
pas de nouveaux rapports natifs de génération. Les cubes, le contexte long et
l’ANE ne sont donc pas qualifiés par ces seules pièces.

Le [dérivé abliterated RMScomposite](gemma-abliterated-rmscomposite.md) conserve ses propres poids et
empreintes : la réussite de la réparation du modèle Google ne lui est pas
attribuée. Le code source admet désormais l'identité indépendante de ce bundle
validé, sous la cible `selected_abliterated_f16_neural_engine`. Le choix repose
sur les octets des métadonnées épinglées, puis les quatre fichiers sont relus
avant l'appel unique de suppression. Le chemin de l'asset provient de cette
même identité. Une erreur de sélection laisse une nouvelle trace d'échec de
vérification et n'autorise aucune suppression.

Cette extension exige un nouveau build de l'application ; le build 11 déjà
installé conserve son ancienne liste. Aucun rapport physique du dérivé n'est
encore disponible.

## Trace et limites

Le rapport `assistSpecializationRepair`, schéma 1, est sauvegardé atomiquement
dans un fichier privé distinct, borné à 32 Kio. Il contient la cible fixe,
l'empreinte source attendue, un UUID, l'heure UTC, le PID et les étapes
`verifying_source`, `invalidating_entry`, `entry_invalidated`, `qualifying`, puis
`completed` ou `failed`. Une erreur de persistance arrête la progression avant
l'appel suivant. Aucun chemin, prompt ou message libre natif n'est exporté.

Le retour réussi est un wrapper `assistSpecializationRepairResult` conservant
le diagnostic d'origine complet. `completed` signifie que ce diagnostic a rendu
un objet JSON ; son propre résultat peut être un échec. La petite trace
persistée ne conserve pas les sorties numériques et ne doit pas remplacer le
wrapper lors du partage immédiatement après le contrôle. Les rapports habituels
de chargement et d'identité conservent leurs fichiers séparés.

Une trace restée sur une étape indique la dernière frontière enregistrée,
sans prouver à elle seule un crash. Le retour de `deleteEntry` ne démontre pas
qu'une entrée existait. Les contrôles Foundation injectent les appels risqués
et vérifient l'ordre, les appels uniques, les arrêts sur erreur et les bornes ;
ils ne démontrent pas une réparation Core AI physique. Les tests React Native
vérifient les gardes, la restauration, le partage et la distinction entre erreurs
natives et écarts numériques.
