# Fidélité numérique de Gemma — 15 octobre 2026

L’erreur des rapports iPhone 2 et 8 est reproductible hors de l’app : la
palettisation des poids suffit à transformer la réponse correcte
`1,4,9,16,25` en `1,2,3,4,5`. La consigne, la source et le contexte 32K sont
conservés. Ce diagnostic ne démontre pas la fidélité de tous les calculs du
runtime iOS.

## Contrôles discriminants

La consigne confirmée est : « Réponds uniquement avec les cinq carrés des
nombres de 1 à 5, séparés par des virgules. » Chaque contrôle utilise une
conversation neuve, le template embarqué, une génération gloutonne et au plus
64 nouveaux jetons.

| Contrôle | Résultat |
| --- | --- |
| HF BF16 original | `1,4,9,16,25` |
| HF FP16 intermédiaire | `1,4,9,16,25` |
| HF FP16 + 275 poids palettisés de l’export initial, embeddings d’origine | `1,2,3,4,5` |
| HF FP16 + tables d’embeddings INT8 uniquement | `1,4,9,16,25` |
| Export initial exécuté sur iPhone, rapports 2 et 8 | `1,2,3,4,5` |

Les contrôles HF utilisent Transformers 5.12.1, PyTorch 2.9.0+cpu, attention
`eager`, EOS `[1,106,50]` et le checkpoint local dont le SHA-256 est revérifié.
Les poids palettisés sont reconstruits directement depuis les LUT/indices
finalisés du véritable export, sans relancer KMeans. Neuf petits contrôles ont
comparé cette reconstruction bit à bit à l’opérateur eager de Core AI.

Le tokenizer Swift épinglé `eed7264` a aussi été exécuté sous Swift 6.2.4 Linux :
les **33 identifiants** de la consigne sont identiques à Python. Deux autres
conversations, dont une avec accents/emoji et une avec historique, produisent
également les mêmes identifiants. Les identifiants des réponses numériques sont
décodés correctement. Le nettoyage Swift des espaces avant `!` et `?` ne change
pas les identifiants d’entrée et n’explique pas cette substitution de chiffres.
Les dépendances transitives résolues pour ce contrôle sont archivées ; leur
identité avec le verrou du build TestFlight 3 n’est pas établie.

## Recette corrigée à 32K

La [recette Assist](../config/4bit_palettized_group8.yaml) change uniquement les
groupes de palettisation de 32 à 8 canaux. Elle conserve les indices 4 bits,
les exceptions PLE à 8 bits, les tables INT8 et les graphes jusqu’à **32 768
jetons**. Le correctif porte sur la compression des poids et est testé avec la
consigne originale des carrés.

Un nouvel export réel a terminé en environ **11 min 17 s**, sans OOM ni arrêt par
la garde de réserve hôte. Avec ses poids palettisés et ses tables INT8, la
référence HF réussit les **8/8 contrôles figés**, dont les carrés
`1, 4, 9, 16, 25`. Le FP16 sans compression réussit 7/8 : il répond
`42,200,20` au cas des sommes, dont le corrigé reste `42,200,30`. Cet échec est
conservé ; un contrôle BF16 original séparé reproduit la même erreur sur cette
somme. Ces quelques cas ne permettent pas de classer généralement les deux
modèles ni d’annoncer une arithmétique fiable sur toutes les consignes.

| Référence CPU, mêmes huit consignes | Réponses exactes |
| --- | --- |
| Checkpoint FP16 sans compression | 7/8 |
| Export initial : palettes à groupes de 32 + embeddings INT8 | 5/8 |
| Nouvel export : palettes à groupes de 8 + embeddings INT8 | 8/8 |

L’export initial échoue aussi sur les cubes, en répondant `1,2,3,4` ; le
nouveau répond `1, 8, 27, 64`. Les trois contrôles utilisent le même script et
le même fichier de consignes. Les échecs restent dans leurs résultats bruts.

Les 8/8 du candidat concernent la référence CPU utilisant ses véritables LUT et
son sidecar PLE. Ils ne mesurent pas l’exécution du graphe Core AI compilé.
Le paquet doit encore être réimporté et testé sur iPhone, avec de nouvelles
conversations et les textes longs inchangés.

Le paquet final comporte neuf fichiers, soit **3 763 087 387 octets**. Ses neuf
fonctions et signatures de graphes sont vérifiées, ainsi que l’inventaire SHA-256
par le vérificateur Node indépendant. L’archive
`Assist-Gemma-4-E2B-32K-group8.zip` contient **2 784 586 364 octets**, avec le SHA-256
`09e2b12f665ab29b0395146033d6a732d8f2363eadcd085d6f92fa9897c50af4`.
Chaque entrée a été relue et comparée à l’inventaire, puis le corps HTTP complet
a produit cette même empreinte. Le dossier extrait distinct est
`gemma4-e2b-32k-group8` ; l’ancien paquet reste conservé pour comparaison.

Le bug GPU de gather au-delà de 2³¹ éléments décrit dans
[l’issue Apple 313](https://github.com/apple/coreai-models/issues/313) ne correspond
pas à ce parcours : le PLE est extrait sur CPU et arrive au graphe en petites
tranches. La différence de précision RMSNorm HF/iOS reste distincte ; elle n’est
pas nécessaire pour reproduire cet échec avec les seuls poids compressés.

## Contrôle de qualité avant transfert

Le [jeu de huit consignes](../scripts/fixtures/gemma-quality.json) est figé avant
les essais du candidat. Les réponses attendues proviennent d’opérations Python
ordinaires et de littéraux à recopier ; le champ `oracle` est descriptif, jamais
exécuté. Le score n’ignore que les espaces, sans corriger les chiffres, la
ponctuation ou le sens. Ce petit jeu est une régression ciblée, pas un benchmark
général de Gemma.

[Le vérificateur](../scripts/check-gemma-quality.py) exécute une référence HF
hors réseau sur le checkpoint local, éventuellement avec les LUT/indices de
l’export et ses embeddings INT8. Nos essais utilisent le staging FP16 et les
intermédiaires conservés du workflow Linux borné. Pour un nouvel export, le
[wrapper de capture](../scripts/export-gemma-with-palettes.py), utilisé dans les
[commandes de préparation](gemma-export.md#export-32k-sans-écraser-un-essai-précédent),
conserve ces palettes ; le bundle `.aimodel` seul ne les fournit pas au script.
Le vérificateur peut aussi charger le checkpoint BF16 local en FP16, avec
l’empreinte BF16 correspondante ; ce chargement nécessite davantage de mémoire
que notre staging mappé. Utiliser l’environnement Python épinglé de
l’export, suffisamment de RAM et des limites CPU/mémoire adaptées. Les poids
restent hors Git. Exemple depuis la racine d’Assist, avec des chemins locaux :

```sh
"$EXPORT_PYTHON" scripts/check-gemma-quality.py \
  --checkpoint "$CHECKPOINT_LOCAL" \
  --checkpoint-sha256 "$CHECKPOINT_SHA256" \
  --palettes "$FINALIZED_WEIGHTS" \
  --ple "$BUNDLE_PLE" \
  --output "$NEW_RESULT_JSON"
```

Omettre `--palettes` et `--ple` pour le contrôle FP16 sans compression. Fournir
le SHA-256 du fichier `model.safetensors` choisi. Pour les fichiers de notre essai :

- BF16 source : `2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550`.
- Staging FP16 : `733fcd1e451d875c684561211b42056c43f9e6809409035877a9a039a15151c5`.

Utiliser un nouveau résultat pour chaque essai : le script refuse d’écraser un fichier.
Un échec numérique produit un code de sortie non nul et conserve les réponses.
Le contrôle ne lance ni le graphe Core AI compilé ni l’app iPhone ; la validation
du paquet, puis les essais physiques courts et longs, restent nécessaires.

La recette Apple rapporte elle-même une baisse de MMLU entre BF16 et sa
compression mixte ; ce résultat général ne justifie pas d’ignorer une régression
reproductible. Voir la
[recette épinglée](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/README.md)
et l’étude
[Quantization Meets Reasoning](https://arxiv.org/abs/2501.03035), trouvée via
Consensus. Ces sources motivent les contrôles ; le diagnostic ci-dessus repose
sur les exécutions locales.
