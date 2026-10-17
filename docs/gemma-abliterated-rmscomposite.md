# Gemma abliterated 32K — RMSNorm composite et réparation ciblée

Cette préparation reprend pour les poids Huihui la recette avancée du modèle
Google `gemma4-e2b-32k-group8-rmscomposite`, dont la réparation de chargement est
attestée dans la conversation `01a145cf-8562-71a3-8628-63d4914353c0`.
Le [premier export abliterated group8](gemma-abliterated.md) reste conservé.
Le nouveau candidat porte le nom distinct
`gemma4-e2b-32k-group8-abliterated-rmscomposite`.

## Recette et provenance

- Poids : `huihui-ai/Huihui-gemma-4-E2B-it-abliterated`, révision
  `3d1e3d50d7a04585ce4ded197b2fd7a90c04647c`.
- Staging FP16 : SHA-256
  `82da932809d703c2a390f2cdf2c49ee65a6b52a2d7632bd83b099a88db5c67b1`.
- Tokenizer et template canoniques : `google/gemma-4-E2B-it`, révision
  `3e22461f65e89153144f8adb70e3b8c2cc9845a7`.
- Exporteur Apple : `apple/coreai-models`, révision
  `9db747612f972001279f02adb04d3ef982310d0e`.
- Même contexte déclaré de **32 768 jetons**, mêmes **275 palettes** group8,
  mêmes tables INT8, PLE et ressources du tokenizer. Aucun nouveau KMeans.

La recette de référence provient de l’essai réussi
`precision-32k-attempt-10`, pas des essais interrompus 6 à 8. Elle remplace les
normalisations par le composite public reconnu `rms_norm` (`RMSNormImpl`). Les
paramètres F16 restent identiques ; leur échelle est promue exactement en F32.
Les données entrent et sortent en F16, la moyenne, l’inverse RMS et epsilon
restent F32 dans le corps du composite. Ce n’est pas la variante expérimentale
à frontière de données F32.

Les deux helpers originaux sont conservés sans modification :

| Helper | SHA-256 |
| --- | --- |
| `composite_export.py` | `65286bc26001df4ebbf6dd80cc327a20be2b39c88142671346d18052dac07812` |
| `release_packing.py` | `c701b5dcdbf23f30ee882e60737bdb70191bbd15ec01051d470198ff53cb16a9` |

Le nouvel entrypoint et le support de replay adaptent uniquement les entrées,
les contrôles de provenance et le nom de sortie. La provenance des poids
Huihui est inscrite dans le bundle et dans les métadonnées internes de l’asset.
Les anciennes empreintes Google ne sont pas réutilisées pour les nouveaux poids.

## Ce que la réparation précédente établit

Le rapport physique du build 11 confirme une suppression ciblée de l’entrée
Neural Engine du modèle Google, puis le chargement de `extend_1024_8`.
La préparation prend 108,677 s, puis une deuxième sonde dans le même processus
ne prend que 5,96 ms pour préparer le modèle. L’utilisateur confirme ensuite
les réponses attendues des tests courts proposés, sans nouveau rapport natif
de génération joint à cette confirmation.

La [réparation](specialization-repair.md) agit sur une entrée de préparation
Core AI ; elle ne modifie aucun poids et ne démontre pas à elle seule la
correction des cubes, le contexte long, le cache après relancement ou l’ANE.
La réussite du modèle Google n’est pas attribuée automatiquement au dérivé.

Le code de réparation reconnaît les quatre tailles et empreintes réelles du
nouveau bundle sous `selected_abliterated_f16_neural_engine`, en conservant
l'identité Google et ses anciens rapports. Il vérifie le dossier sélectionné
avant la suppression unique de son entrée Neural Engine, puis reprend la
sonde `extend_1024_8`. Le changement est dans les sources ; aucun nouveau build
n'a été distribué et aucun essai physique Huihui n'est attesté. Le build 11
déjà installé ne reconnaît pas cette nouvelle identité pour la réparation.

## Contrôle numérique du dérivé

Un nouveau contrôle HF CPU emploie le même `RMSNormImpl`, les échelles F32,
les vrais LUT/indices et le PLE du dérivé. Les poids, les huit corrigés, le
template, les identifiants d’entrée et la génération gloutonne restent fixés.
Les 242 modules de normalisation utilisés par ce parcours texte sont exercés.

Le résultat est **7/8** : les cubes donnent `1, 4, 9, 16` au lieu de
`1,8,27,64`. Cet échec est conservé, avec le code de sortie 1 du contrôle.
Les carrés, produits, sommes, tri, JSON, copie de code et progression passent.
Il s’agit d’un contrôle eager CPU ; le graphe Core AI compilé et l’iPhone ne
sont pas qualifiés par cette suite.

L’[enquête distincte sur les cubes](gemma-cubes-investigation.md) sépare
compression des palettes, embeddings INT8 et écart numérique du runtime Apple.
Aucune modification supplémentaire de quantification n’est appliquée à cet
export pendant cette investigation.

## Preuves locales

Les poids et les artefacts restent hors Git, dans
`/mnt/corsair-mp400/assist-gemma-abliterated-rmscomposite-20261016`.
L’environnement Python épinglé reste celui de
`/home/ales27pm/projects/assist/artifacts/gemma-export-probe/.venv`.

Le manifeste neuf lie les sources, le staging, le premier bundle abliterated,
ses palettes et ses résultats réels. Le fichier `run-config.json` est épinglé
avant l’export par le SHA-256
`6f14109e017473a07a791b2a6a8f961e97687bfd1331a0fdce67eec9558eb46e`.
Le worker a terminé en 650,26 s sous une limite de 6 Gio de RAM, sans swap,
avec deux CPU et une réserve hôte. Son code de sortie est 0 ; aucune mise à
mort OOM n'est relevée et les 317 entrées ainsi que la configuration épinglée
sont restées identiques. Les anciens exports et leurs caches restent intacts.

Le validateur indépendant est passé : neuf contrats publics et leurs alias de
cache, douze corps RMSNorm, 1 074 invocations dans les graphes transformer,
identités source, PLE, tokenizer et palettes. Le bundle contient neuf fichiers
pour **3 763 177 239 octets**. Le SHA-256 du nouveau `main.mlirb` est
`a46f84f3bf569ac06da3b86eb24400c31b367da5b831566da0786987f863c8f0`.
Ces vérifications de structure ne transforment pas le contrôle numérique 7/8
en qualification réussie.

Le ZIP final a été relu fichier par fichier contre cet inventaire, avec la
vérification Node des vrais octets du bundle :

- archive : `iphone-download/Assist-Gemma-4-E2B-32K-group8-abliterated-rmscomposite.zip` ;
- taille : **2 784 386 908 octets** ;
- SHA-256 : `74c0d0d038c5ead913f68ce8a20d01ecb09bcda9559a1c406b62becfb3511c97` ;
- contrôle : `iphone-download/download-integrity.json` ;
- validation et inventaire : `validated-bundle.json`, `reviewed-bundle.lock.json`.

L'export, la validation et l'empaquetage sont terminés. Le paquet reste un
candidat expérimental non testé sur appareil. La capacité déclarée de 32K,
l'exécution du graphe compilé et le placement ANE ne sont pas qualifiés par
ces contrôles locaux.

## Page de téléchargement privée

La page responsive est préparée depuis `scripts/gemma-download-page.html` par
`scripts/serve-gemma-download.py`. Le serveur relit le SHA-256 complet du ZIP
au démarrage et sert uniquement la page, le ZIP, son `.sha256` et le rapport
d'intégrité. Il prend en charge `HEAD`, les plages HTTP et `If-Range` pour la
reprise ; un changement ultérieur de l'identité du ZIP bloque sa distribution.

Le service indépendant écoute sur loopback et passe par un nouvel endpoint
HTTPS privé Tailscale. Les anciens services et les réglages Funnel sont
préservés. L'URL et l'état courant restent dans le fichier local
`download-page/page-state.json` du dossier d'export, avec les rapports HTTP et
HTTPS. Depuis l'iPhone, ouvrir cette URL dans Safari avec Tailscale connecté.
Les gros fichiers restent hors Git.

## Vérification du code de réparation

Le contrôle complet `cd mobile && npm run check` passe : TypeScript, ESLint,
**236 tests dans 11 suites** et codegen iOS. Les **74 tests du bundler** passent
également. Les deux helpers Foundation/CryptoKit et leurs scripts de contrôle
ont été compilés avec Apple Swift 6.2.4 puis exécutés sur macOS ; les fixtures
Google et Huihui sont incluses et les empreintes des sources sont restées
identiques au snapshot. Ces tests couvrent notamment les identités croisées,
les liens symboliques, les mutations de fichiers, la persistance d'une trace
fraîche et l'ordre des effets de réparation.

La preuve Swift est conservée dans
`/tmp/assist-native-swift-final-_cf1s00n/result.json`, avec le journal et le
snapshot. Le contrôle mobile est dans
`/tmp/assist-rmscomposite-mobile-check-20261016.log`.
Il ne s'agit pas d'une compilation complète de l'application Core AI ni d'un
test de l'API de cache réelle ou d'une exécution sur iPhone.
