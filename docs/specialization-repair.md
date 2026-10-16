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
