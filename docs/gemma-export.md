# Préparer Gemma 4 E2B pour iOS

Les commandes ci-dessous sont une procédure de préparation, **pas un export déjà
exécuté et validé**. Ne pas lancer de conversion lourde sur l’iPhone. Utiliser un
Mac Apple Silicon avec l’environnement Core AI compatible, suffisamment de RAM
et d’espace libre pour les poids, les tenseurs temporaires, les deux exports et
leurs caches. Les fichiers ne doivent pas entrer dans le dépôt `assist`.

## Sources et accès

- Recette/runtime : `apple/coreai-models` à
  `9db747612f972001279f02adb04d3ef982310d0e`.
- Source proposée : `google/gemma-4-E2B-it` à
  `3e22461f65e89153144f8adb70e3b8c2cc9845a7` (révision relevée le 15 octobre 2026).
- Lire la licence du modèle et les conditions de distribution. Si l’accès exige
  une acceptation ou une authentification, les effectuer personnellement ; ne
  jamais inscrire un jeton dans ce dépôt ou dans une commande publiée.
- Préparer `uv` et la CLI `hf` selon leurs documentations officielles. Aucun
  script de ce dépôt ne les installe ni n’accepte une licence automatiquement.

Le téléchargement initial est distinct de l’inférence : le prototype ne doit
pas télécharger de tokenizer manquant ni appeler un modèle distant au chargement.

Sources : [recette Apple](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md),
[checkpoint épinglé](https://huggingface.co/google/gemma-4-E2B-it/tree/3e22461f65e89153144f8adb70e3b8c2cc9845a7).

## Espace de travail séparé

Depuis la racine d’`assist`, utiliser un nouveau dossier voisin. Si le nom existe
déjà, inspecter son contenu et choisir un autre dossier ; ne rien écraser.

```sh
bash scripts/preflight-ios.sh
git clone https://github.com/apple/coreai-models.git ../assist-coreai-export
cd ../assist-coreai-export
git checkout --detach 9db747612f972001279f02adb04d3ef982310d0e
uv sync --locked
cd models/gemma4
```

La recette épinglée n’expose pas d’option `--revision`. Télécharger d’abord un
instantané précis dans un **nouveau** répertoire relatif portant exactement le
nom du modèle. Les chargeurs Transformers de cette recette utilisent ce dossier
local lorsqu’il existe ; le même identifiant reste alors inscrit dans les
métadonnées du bundle. Ne pas changer de répertoire entre les étapes suivantes.

```sh
hf download google/gemma-4-E2B-it \
  --revision 3e22461f65e89153144f8adb70e3b8c2cc9845a7 \
  --local-dir google/gemma-4-E2B-it
find google/gemma-4-E2B-it -type f ! -path '*/.cache/*' \
  -exec shasum -a 256 {} + | LC_ALL=C sort > ../../gemma-source.sha256
```

L’inventaire local détecte une modification ultérieure ; à lui seul, il ne
prouve pas l’authenticité de la source. Conserver aussi la révision téléchargée
et les informations de provenance du téléchargement.

## Deux exports, sans écraser le premier

Définir explicitement le contexte : le défaut amont est plus grand que notre
cible et ne doit pas être utilisé implicitement. L’export est FP16 avec la
recette de palettisation mixte 4 bits fournie ; les embeddings/PLE sont des
ressources supplémentaires. Les options hors ligne empêchent une résolution
silencieuse de fichiers manquants depuis une autre révision.

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --offline export.py \
  --model google/gemma-4-E2B-it \
  --max-context-length 8192 \
  --output-dir ../../exports/gemma8k \
  --output-name gemma4-e2b-8k
shasum -a 256 -c ../../gemma-source.sha256
```

Puis, seulement après avoir inspecté le premier export :

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --offline export.py \
  --model google/gemma-4-E2B-it \
  --max-context-length 32768 \
  --output-dir ../../exports/gemma32k \
  --output-name gemma4-e2b-32k
shasum -a 256 -c ../../gemma-source.sha256
```

Ne pas ajouter `--overwrite` pour contourner un échec. Préserver le journal et
utiliser un nouveau nom d’export après diagnostic. L’exporteur peut laisser des
ressources partielles : la présence d’un dossier n’est pas une réussite.

## Bundle à transférer

Transférer le **dossier complet** produit, par exemple
`exports/gemma8k/gemma4-e2b-8k/`, avec `metadata.json`, l’asset `.aimodel`, le
dossier `tokenizer/` et le sidecar PLE. Ne pas transférer seulement `.aimodel`.
Rendre tous les fichiers disponibles localement dans Fichiers avant l’import ;
un placeholder iCloud n’est pas une ressource hors ligne.

Le prototype attend actuellement :

- tokenizer déclaré `google/gemma-4-E2B-it`, embarqué avec `tokenizer.json` et
  `tokenizer_config.json` ;
- contexte déclaré de 8 192 ou 32 768 ;
- asset principal `main`, sidecar `per_layer_embeddings`, sans variante vision ;
- graphe cohérent avec les fonctions Gemma : `load_embeddings`, décodage
  `extend_{contexte}_8` et préremplissage `prompt_opt_{contexte}_64`.

Ces contrôles de structure ne sont **pas une vérification cryptographique des
poids**. Relever les tailles et SHA-256 de l’export final avant transfert, puis
les contrôler sur les ressources reçues avec un outil adapté avant qualification.
Ne pas publier d’identifiant personnel ou de chemin privé dans ces rapports.

Apple documente une limitation de compilation anticipée Gemma dans Xcode 27.2
bêta. Utiliser la spécialisation sur l’appareil à partir de `.aimodel`, conserver
le temps et les écritures de cette première spécialisation dans les mesures ;
ne pas annoncer un paquet AOT prêt à l’emploi. La réussite de l’export ne prouve
pas la réussite sur iPhone. Voir le [protocole physique](qualification.md).
