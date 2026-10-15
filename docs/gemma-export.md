# Préparer Gemma 4 E2B pour iOS

Un export réel 32K a été préparé et contrôlé le 15 octobre 2026 ; son
[rapport de préparation](gemma-32k-export-2026-10-15.md) distingue les contrôles
réussis des tests iPhone restant à effectuer. Une
[régression numérique de la compression initiale](gemma-numeric-fidelity.md)
a ensuite été reproduite : utiliser la recette à groupes de 8 ci-dessous et
contrôler les réponses avant transfert. Les commandes ci-dessous décrivent
la préparation, sans constituer une qualification sur appareil.
Ne pas lancer de conversion lourde sur l’iPhone. Pour le parcours macOS ci-dessous,
utiliser un Mac Apple Silicon avec l’environnement Core AI compatible,
suffisamment de RAM et d’espace libre pour les poids, les tenseurs temporaires,
l’export et ses caches. L’essai CPU Linux et ses adaptations mémoire sont
décrits dans le rapport. Les fichiers ne doivent pas entrer dans le dépôt `assist`.

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
ASSIST_EXPORT_RECIPE="$PWD/config/4bit_palettized_group8.yaml"
ASSIST_EXPORT_WRAPPER="$PWD/scripts/export-gemma-with-palettes.py"
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

## Export 32K, sans écraser un essai précédent

Définir explicitement le contexte : le défaut amont est plus grand que notre
cible et ne doit pas être utilisé implicitement. L’export est FP16 avec la
recette de palettisation mixte 4 bits d’Assist, à groupes de 8 canaux au lieu de
32 ; les exceptions de précision et les embeddings/PLE sont conservés.
Le contexte reste **32 768 jetons**. Les options hors ligne empêchent une résolution
silencieuse de fichiers manquants depuis une autre révision.

```sh
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --offline python \
  "$ASSIST_EXPORT_WRAPPER" \
  --exporter "$PWD/export.py" \
  --palettes ../../exports/gemma32k-group8/finalized-weights -- \
  --model google/gemma-4-E2B-it \
  --max-context-length 32768 \
  --compression-config "$ASSIST_EXPORT_RECIPE" \
  --output-dir ../../exports/gemma32k-group8 \
  --output-name gemma4-e2b-32k-group8
shasum -a 256 -c ../../gemma-source.sha256
```

Ne pas ajouter `--overwrite` pour contourner un échec. Préserver le journal et
utiliser un nouveau nom d’export après diagnostic. L’exporteur peut laisser des
ressources partielles : la présence d’un dossier n’est pas une réussite.

Le wrapper conserve les LUT/indices via l’argument `mmap_dir` de l’API Core AI
et utilise un seul worker de clustering. Le répertoire `finalized-weights`
reste séparé du bundle à transférer. L’exporteur Apple seul ne conserve pas ces
fichiers, nécessaires au contrôle CPU. Ce wrapper ne reprend pas les adaptations
mémoire de l’essai Linux documenté ; prévoir les ressources de l’exporteur amont.

## Bundle à transférer

Transférer le **dossier complet** produit, par exemple
`exports/gemma32k-group8/gemma4-e2b-32k-group8/`, avec `metadata.json`, l’asset `.aimodel`, le
dossier `tokenizer/` et le sidecar PLE. Ne pas transférer seulement `.aimodel`.
Rendre tous les fichiers disponibles localement dans Fichiers avant l’import ;
un placeholder iCloud n’est pas une ressource hors ligne. Pour ce prototype,
extraire le ZIP dans **Sur mon iPhone** : le sélecteur refuse les emplacements
iCloud, même téléchargés. Dans Assist, sélectionner le dossier qui contient
`metadata.json`, puis toucher **Charger le modèle** et garder l’app au premier
plan pendant le premier chargement.

Le prototype attend actuellement :

- tokenizer déclaré `google/gemma-4-E2B-it`, embarqué avec `tokenizer.json`,
  `tokenizer_config.json` et `chat_template.jinja` ;
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
