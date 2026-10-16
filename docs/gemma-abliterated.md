# Gemma 4 E2B abliterated — recette group8 de référence

Ce rapport décrit le premier export group8. La
[seconde préparation rmscomposite](gemma-abliterated-rmscomposite.md) reprend
la recette avancée et la réparation ciblée du build 11. Les anciens fichiers
sont conservés pour comparaison.

L’essai du 16 octobre 2026 reprend la recette du dernier dossier effectivement
chargé et utilisé sur iPhone, `gemma4-e2b-32k-group8`, avec les poids de
`huihui-ai/Huihui-gemma-4-E2B-it-abliterated`. L’export 32K et l’archive sont préparés, et les contrôles de structure passent.
La référence CPU comprimée réussit **7/8** consignes : les cubes restent
incorrects. Aucun résultat sur appareil n’est encore établi pour ce dérivé.

La référence group8 a généré des réponses sur iPhone et réussi les trois textes
longs avec un budget de sortie adapté. Elle conserve toutefois un écart de
fidélité : la consigne des cubes produit `1, 4, 9, 16` sur iPhone au lieu de
`1,8,27,64`, alors que la référence CPU répond correctement. Les variantes de
normalisation expérimentales ne constituent pas la base de ce nouvel export.
Voir les [résultats physiques et leurs limites](gemma-numeric-fidelity.md).
Réutiliser cette recette ne démontre donc ni la correction des cubes, ni la
qualité du dérivé, ni son exécution ANE.

## Sources épinglées

| Élément | Source et révision |
| --- | --- |
| Poids abliterated | [`huihui-ai/Huihui-gemma-4-E2B-it-abliterated`](https://huggingface.co/huihui-ai/Huihui-gemma-4-E2B-it-abliterated/tree/3d1e3d50d7a04585ce4ded197b2fd7a90c04647c), `3d1e3d50d7a04585ce4ded197b2fd7a90c04647c` |
| Ressources canoniques de la référence | [`google/gemma-4-E2B-it`](https://huggingface.co/google/gemma-4-E2B-it/tree/3e22461f65e89153144f8adb70e3b8c2cc9845a7), `3e22461f65e89153144f8adb70e3b8c2cc9845a7` |
| Exporteur et runtime Apple | [`apple/coreai-models`](https://github.com/apple/coreai-models/tree/9db747612f972001279f02adb04d3ef982310d0e), `9db747612f972001279f02adb04d3ef982310d0e` |
| Compression Assist | [`config/4bit_palettized_group8.yaml`](../config/4bit_palettized_group8.yaml) |

Le [modèle Huihui épinglé](https://huggingface.co/huihui-ai/Huihui-gemma-4-E2B-it-abliterated/blob/3d1e3d50d7a04585ce4ded197b2fd7a90c04647c/README.md)
déclare un dérivé de Gemma 4 E2B obtenu par abliteration, avec les dix premières
couches préservées. Cette description vient de son auteur ; elle ne remplace
pas les contrôles numériques. Au relevé du 16 octobre, l’API Hugging Face
déclare le dépôt public, sans accès conditionnel et sous licence Apache-2.0.

Le fichier BF16 source compte **10 246 621 886 octets**, avec le SHA-256
`90daa0b268e2a8ed42b1814183a25a659b5749beb2288e593bb1f207d4b61ee7`.
L’empreinte et la taille proviennent des
[métadonnées Hugging Face de la révision](https://huggingface.co/api/models/huihui-ai/Huihui-gemma-4-E2B-it-abliterated/revision/3d1e3d50d7a04585ce4ded197b2fd7a90c04647c?blobs=true).
Le téléchargement local a confirmé ces deux valeurs.

## Même contrat de modèle, provenance distincte

Les en-têtes des deux checkpoints BF16 ont été comparés : les **2 011 noms de
tenseurs**, dimensions et types sont identiques. Le `config.json`, le
`generation_config.json`, le `processor_config.json` et le `tokenizer.json` du
dérivé sont également identiques octet par octet aux fichiers de la référence
Google épinglée. Ces constats portent sur la structure et les ressources ;
les poids ont une empreinte différente.

Le `tokenizer.json` commun a pour SHA-256
`cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f`.
En revanche, le dérivé embarque un `tokenizer_config.json` et un
`chat_template.jinja` différents. Pour conserver la recette d’entrée déjà
utilisée dans Assist, l’export emploie intentionnellement les trois ressources
canoniques du tokenizer Google épinglé, dont le template de **18 569 octets**
au SHA-256
`0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5`.
Les fichiers originaux du dérivé restent conservés dans son dossier source,
sans remplacement. Les comparaisons et les deux provenances sont consignées
dans `source-verification.json`.

L’alias local `google/gemma-4-E2B-it` sert à sélectionner les entrées de
l’exporteur Apple épinglé et le tokenizer canonique. Il ne désigne pas la
provenance des nouveaux poids. Le `source.hf_model_id` des métadonnées finales
doit identifier **Huihui**, avec sa révision ; `source.export_alias` conserve
l’alias local et `language.tokenizer` reste celui de la référence Google.
Le verrou du bundle doit déclarer séparément ces provenances. Le nouveau
dossier cible est `gemma4-e2b-32k-group8-abliterated`.

## Recette reprise

Le contexte reste **32 768 jetons**, avec staging BF16 vers FP16, palettisation
KMeans mixte à indices 4 bits par groupes de 8 canaux, exceptions PLE 8 bits,
tables d’embeddings INT8 et sidecar PLE. La recette YAML est copiée sans
modification ; son SHA-256 est
`2feeea712a1ae6ac0d8bc8b0d565ee185f707e4f2128c330a03f0cb1b6b694c4`.
Les [principes de l’export group8](gemma-export.md) restent applicables.

L’environnement de la référence est conservé : Python 3.12.13,
PyTorch 2.9.0+cpu, Transformers 5.12.1, coreai-core 1.0.0b3,
coreai-torch 0.4.3 et coreai-opt 0.3.0. Les adaptations Linux de mémoire bornée
conservent la quantification par blocs, un seul worker de palettisation,
la finalisation des poids mappés sur disque et le partage des indices compactés
inchangés entre graphes. Le patch d’origine est épinglé par son SHA-256
`591408124373ec1a4eeb7fe686dbe370dc34bf8e5b3b1d992c677c5b1f7e297c`.
Le lanceur contrôle les révisions, les versions et ce patch avant l’export.

## Pipeline local et preuves

L’essai et ses poids restent hors Git dans
`/mnt/corsair-mp400/assist-gemma-abliterated-20261016`. L’environnement Python,
le staging borné et les deux checkouts Apple proviennent de
`/home/ales27pm/projects/assist/artifacts/gemma-export-probe`.
Les scripts locaux décrivent ce poste préparé ; ils ne constituent pas une
reproduction autonome à partir du seul dépôt Assist.

La préparation télécharge chaque fichier de la révision épinglée sans jeton,
vérifie ses empreintes, compare les ressources et contrats des tenseurs, puis
convertit les poids BF16 vers FP16 par blocs. Le staging réel a le SHA-256
`82da932809d703c2a390f2cdf2c49ee65a6b52a2d7632bd83b099a88db5c67b1`.
La conversion a traité les 2 011 tenseurs en 43,69 s, avec un maximum RSS de
342 640 Kio ; ces mesures concernent le staging hôte, pas l’iPhone.

Le pipeline local enchaîne le contrôle CPU du checkpoint FP16, l’export,
le contrôle des véritables palettes/embeddings INT8, la validation des neuf
fonctions publiques et la préparation d’un ZIP relu intégralement.
Il conserve les huit corrigés existants sans les modifier.

Les étapes lourdes tournent dans des unités utilisateur isolées :

| Étape | RAM maximale / seuil haut | CPU | Swap |
| --- | --- | --- | --- |
| Téléchargement et staging | 4 / 3 Gio | 2 cœurs | 0 |
| Chaque suite de qualité | 8 / 7 Gio | 2 cœurs | 0 |
| Export Core AI | 10 / 8 Gio | 2 cœurs | 0 |
| Validation du graphe | 4 / 3 Gio | 2 cœurs | 0 |
| Empaquetage | 1 Gio / 768 Mio | 2 cœurs | 0 |

Le lanceur impose aussi une réserve hôte et refuse d’écraser un essai existant.
Les sorties partielles et les échecs restent conservés avant toute reprise.
Les scripts de coordination et de contrôle sont `prepare.py`, `pipeline.py`,
`run_monitored.py`, `run_quality_suite.py`, `validate_bundle.py` et
`package_bundle.py` dans le dossier de l’essai. `run_entry.py` décrit la vraie
provenance Huihui dans l’asset, puis dans les métadonnées du bundle, en conservant
le tokenizer canonique ; aucune normalisation expérimentale n’est ajoutée.

Les preuves locales incluent :

- `source-verification.json` et `fp16-staging-verification.json` : identités et
  transformation des sources, provenance canonique des ressources ;
- `attempt.json`, `export.log` et `monitor.jsonl` : export et limites réelles ;
- `quality-suite-source-fp16/result.json`, `quality-result.json` et
  `quality-comparison.json` : réponses brutes, corrigés et écarts ;
- `validated-bundle.json` et `reviewed-bundle.lock.json` : inventaire, graphes,
  provenance des poids Huihui et du tokenizer Google ;
- `iphone-download/download-integrity.json` : archive et empreinte après
  relecture de chaque fichier du ZIP.

La validité de structure et le score CPU sont indépendants. Les échecs
numériques restent dans les résultats et la provenance du bundle.
Le verrou approuvé du dérivé comporte les champs `model` et `tokenizer`
séparés ; le [vérificateur de bundle](bundled-gemma.md) refuse les révisions
inconnues, les sources mal étiquetées et les écarts d’inventaire.

## Résultats du 16 octobre 2026

L’export a terminé en **688,17 s**, code de sortie 0. Les empreintes de la
source, du staging FP16 et des scripts d’exécution sont inchangées. Le maximum
de mémoire du cgroup est de **8 592 035 840 octets**, avec zéro swap, zéro OOM
et aucun arrêt par la garde hôte. Ce sont des mesures de conversion Linux.

Les mêmes huit corrigés figés donnent :

| Contrôle CPU | Réponses exactes | Échec conservé |
| --- | --- | --- |
| Google group8 de référence | 8/8 | Aucun sur cette suite |
| Huihui FP16 avant compression | 7/8 | Sommes : `42,200,20` au lieu de `42,200,30` |
| Huihui group8 + embeddings INT8 | 7/8 | Cubes : `1, 4, 9, 16` au lieu de `1,8,27,64` |

La compression corrige le cas des sommes sur ce dérivé mais introduit la
régression des cubes. Ce résultat ne démontre pas une amélioration générale.
La recette demandée est conservée et le contrôle numérique reste marqué
**échoué**, avec le code de sortie 1 du vérificateur et ses huit réponses brutes.
Il s’agit du contrôle HF CPU utilisant les véritables LUT/indices et le PLE,
pas d’une exécution du graphe Core AI compilé.

La validation structurelle a rouvert l’asset et contrôlé ses neuf fonctions
publiques, leurs entrées/sorties/états, les trois paliers de contexte, le PLE,
le tokenizer et les deux provenances. Les métadonnées internes de l’asset
identifient aussi Huihui. Le vérificateur Node a ensuite contrôlé les vrais
fichiers et le verrou dans un arbre de revue distinct. Ses tests de régression
passent **74/74** ; les ressources synthétiques de ces tests ne remplacent pas
le contrôle du vrai bundle décrit ici.

## Archive pour import manuel

- Fichier : `Assist-Gemma-4-E2B-32K-group8-abliterated.zip`.
- Taille : **2 784 589 386 octets** ; dossier extrait : **3 763 091 837 octets**.
- SHA-256 : `4759787fb7c631410cf78544f93a03516759db73d85fbda1162ea593f9a4c6b8`.
- Contenu : **9 fichiers**, chacun relu dans le ZIP et comparé à l’inventaire
  contrôlé ; contexte déclaré **32 768**.
- Emplacement : `iphone-download/` dans le dossier local de l’essai, accompagné
  de son `.sha256`, de `download-integrity.json`, du verrou, de l’inventaire et
  de la comparaison des résultats numériques.

Le dossier complet `gemma4-e2b-32k-group8-abliterated` est importable par le
sélecteur existant d’Assist après extraction dans **Sur mon iPhone**. Choisir
le dossier contenant `metadata.json`, puis **Charger le modèle**. La structure
préparée ne prouve pas encore que ce nouveau dérivé charge ou génère sur iPhone.
Pour le premier essai, utiliser une nouvelle conversation et un budget de sortie
64 ; conserver le résultat des cubes, y compris s’il échoue à nouveau.

Le chargement, les réponses, la mémoire et la spécialisation sur iPhone
restent à mesurer pour ce nouveau dérivé. La préférence Neural Engine ne
constitue pas une preuve d’exécution ANE.
