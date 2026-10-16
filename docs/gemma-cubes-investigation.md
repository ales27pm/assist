# Enquête sur les cubes — 16 octobre 2026

Les **205 palettes de 4 bits suffisent à inverser le premier choix numérique
de Huihui abliterated**, de `8` vers `4`, au préfixe commun `1, `, dans le
contrôle HF CPU. Les embeddings INT8 seuls et les 70 palettes PLE de 8 bits
seules conservent `8` à ce pas. La régression complète `1, 4, 9, 16` avait
déjà été reproduite avec le modèle comprimé hors iPhone. Le cache et le moteur
compilé ne sont donc pas nécessaires à cet échec précis. Une couche responsable
unique et une recette corrigée ne sont pas établies.

## Ce qui était déjà établi

La consigne figée est : « Réponds uniquement avec les quatre cubes des nombres
de 1 à 4, séparés par des virgules. » Le corrigé reste `1,8,27,64`.
L’empreinte des 32 identifiants UInt32 little-endian est
`cb364516a49b4006b836b933fc11ca273cb5a659bc05ff0d20fdf5ec2e15fc99`.

| Contrôle complet antérieur | Réponse aux cubes | Portée |
| --- | --- | --- |
| Google FP16 source | `1, 8, 27, 64` | HF eager CPU |
| Google group8 avec embeddings INT8 | `1, 8, 27, 64` | HF eager CPU |
| Ancien Google group8 sur iPhone | `1, 4, 9, 16` | Classement natif différent du CPU |
| Huihui FP16 source | `1, 8, 27, 64` | HF eager CPU |
| Huihui group8 avec embeddings INT8 | `1, 4, 9, 16` | HF eager CPU |
| Même Huihui comprimé, calcul RMSNormImpl | `1, 4, 9, 16` | HF eager CPU, composite non compilé |

Les résultats complets sont dans les deux dossiers d’export :
`assist-gemma-abliterated-20261016/quality-comparison.json`,
`quality-suite-source-fp16/result.json`, `quality-suite-group8-int8/result.json`
et `assist-gemma-abliterated-rmscomposite-20261016/quality-composite-result.json`,
tous sous `/mnt/corsair-mp400/`. Le score global 7/8 masque deux profils :
le FP16 échoue sur les sommes ; le comprimé échoue sur les cubes.

La réparation du cache restaure le chargement et ne change pas les poids.
Elle ne démontre pas une correction des cubes. L’ancien problème Google
CPU/iPhone reste distinct : au pas 3, les marges natives en faveur de `4`
étaient 0,015625 puis 0,03125 selon le candidat, tandis que le CPU préférait
`8`. Les probes synthétiques RMSNorm n’établissaient pas la responsabilité
de cette primitive dans Gemma entier. Voir
[la fidélité numérique](gemma-numeric-fidelity.md).

## Neuf expériences causales à préfixe identique

Chaque passage utilise le checkpoint FP16 Huihui de SHA-256
`82da932809d703c2a390f2cdf2c49ee65a6b52a2d7632bd83b099a88db5c67b1`,
PyTorch 2.9.0+cpu, Transformers 5.12.1 et l’attention eager. Après les 32 jetons
de la consigne, le diagnostic force les trois jetons `[236770,236764,236743]`
de `1, ` avec le cache incrémental HF. Ces trois choix sont aussi gloutons
dans les neuf variantes et correspondent au préfixe des anciennes générations.
Aucun score après divergence de préfixe n’est comparé.

La marge est `score(8) − score(4)`. Les scores retournés sont FP16 après le
softcap final HF ; les probabilités sont recalculées en FP32 sur tout le
vocabulaire. Les top10 et les scores de `4` et `8` sont conservés dans les JSON.

| Variante | Palettes appliquées | Marge `8−4` | Probabilité de `8` | Choix |
| --- | ---: | ---: | ---: | --- |
| FP16 source | 0 | **+10,6953125** | 99,98698 % | `8` |
| Palettes seules, embeddings FP16 | 275 | **−3,640625** | 2,49818 % | `4` |
| Embeddings INT8 seuls | 0 | **+10,4375** | 99,98227 % | `8` |
| Palettes et embeddings INT8 | 275 | **−3,84375** | 2,04521 % | `4` |
| Même combinaison, RMSNormImpl | 275 | **−3,84375** | 2,04521 % | `4` |
| LUT16 de 4 bits seules, embeddings FP16 | 205 | **−1,6328125** | 15,79525 % | `4` |
| LUT256 PLE de 8 bits seules, embeddings FP16 | 70 | **+10,1796875** | 99,98276 % | `8` |
| Couches 0–17 restaurées en FP16, palettes 18–34 | 119 | **+7,5859375** | 99,83438 % | `8` |
| Couches 18–34 restaurées en FP16, palettes 0–17 | 156 | **+3,8203125** | 97,56966 % | `8` |

Les « 275 palettes » comprennent 205 LUT16 et 70 LUT256. Leur ensemble est
d’abord isolé, puis les 205 LUT16 suffisent seules à provoquer le mauvais
choix. INT8 et LUT256 seuls ne reproduisent pas ce basculement. RMSNormImpl
ne modifie pas les deux scores de la combinaison comprimée dans cette mesure
CPU : `4=16,34375`, `8=12,5`.

**Les deux restaurations de moitié rétablissent ce pas.** Cela ne désigne pas
une couche unique et ne présume pas des effets monotones : accumulation et
interactions restent possibles. La marge Huihui comprimée est de plusieurs
unités, à distinguer de l’ancien petit écart natif Google. L’explication
interne — compréhension du mot « cubes », calcul arithmétique ou interaction —
reste inconnue. Les variantes sélectives n’ont pas été évaluées sur une réponse
complète ; aucun nouveau résultat 8/8 ni correctif iPhone n’est revendiqué.

## Vérifications de provenance et de reproductibilité

La matrice `matrix-1/` conserve sa version inchangée
`score_cube_frontier.py`, SHA-256
`e16b65d40d7b392e8499c9a64f59cef4705b5e1059029b451a9f5fa617585ac4`.
La série `selective-1/` utilise une copie distincte
`score_cube_frontier_selective.py`, dont chaque résultat conserve l’empreinte.
Les contrôles relisent le SHA du checkpoint et des palettes, utilisent les
ressources locales hors réseau et refusent l’écrasement d’un résultat.

La lecture de `coreai-opt 0.3.0` trouve un chemin scalaire `cluster_dim=1` :
`np.unique`, puis le solveur pondéré `_kmeans1d.cluster` et le C++ SMAWK.
Aucun RNG n’a été repéré dans ce chemin ; l’initialisation aléatoire observée
dans `_EfficientKMeans` appartient au chemin vectoriel. En revanche, les défauts
`enable_fast_kmeans_mode=True` et `rounding_precision=4` ajoutent l’arrondi
`np.round(weights_float32 * 10000) / 10000` avant clustering. Sa responsabilité
dans les cubes n’a pas été testée ; aucun KMeans n’a été relancé.

Une lecture ciblée des paramètres FP16 `o_proj.weight` et de leurs palettes
finalisées trouve une identité exacte Google/Huihui dans les couches 0 et 9,
puis une différence à la source et dans la palette en couche 10. Cela ne
compare pas toutes les couches, mais ne soutient pas une différence aléatoire
pour ces deux paramètres identiques. Les octets, formes, chemins et empreintes
sont documentés dans `selected-parameter-byte-comparison.json`.

## Recherche Exa

**30 résultats demandés, deux axes** : compression et précision des
normalisations/composites. Les sources retenues sont primaires ; le détail des
six recherches figure dans `research-evidence.json`.

- [Apple, Palettization Algorithms](https://apple.github.io/coremltools/docs-guides/source/opt-palettization-algos.html) : les faibles précisions KMeans peuvent altérer l’exactitude ; Sensitive KMeans tient compte de la sensibilité des poids. Documentation Core ML Tools, pas une mesure directe de notre export coreai-opt.
- [Apple, Palettization Overview](https://apple.github.io/coremltools/docs-guides/source/opt-palettization-overview.html) : grouper les canaux réduit la portée d’une LUT commune ; une taille de groupe ne garantit pas la même fidélité pour deux checkpoints.
- [Apple, RMSNormImpl](https://apple.github.io/coreai-torch/main/api/composite-ops/rms-norm.html) et [Composite Ops Guide](https://apple.github.io/coreai-torch/main/guides/composite-ops.html) : frontière explicite, types FP16/FP32 admis et implémentations optimisées par le compilateur. Aucune identité numérique générale CPU/native n’y est garantie.
- [Li et al., Quantization Meets Reasoning](https://arxiv.org/html/2505.11574v4) : des erreurs précoces de calcul après quantification se propagent dans les familles étudiées. Cela justifie de mesurer le premier choix fautif, mais ces expériences Qwen/LLaMA et AWQ/GPTQ/SmoothQuant ne prouvent rien directement sur Gemma4.
- [Créateur Huihui, fiche du modèle](https://huggingface.co/huihui-ai/Huihui-gemma-4-E2B-it-abliterated) : provenance abliterated et dix premières couches annoncées non abliterated ; aucune garantie arithmétique group8.

## État final et preuves

Les neuf passages ont terminé avec un code zéro, sans OOM ni arrêt de garde.
Ils ont attendu la fin réussie de l’export indépendant et au moins 11 Gio de
mémoire disponible. Les deux services imposaient 8 Gio maximum, un seuil haut
de 7 Gio, zéro swap et CPU 200 %. Le maximum de cgroup est de
**7 516 905 472 octets**. Les deux services d’enquête sont maintenant
**inactive/dead**, `MainPID=0`, `Result=success` :

- `assist-gemma-cubes-frontier-20261016.service` ;
- `assist-gemma-cubes-selective-20261016.service`.

Tous les fichiers ci-dessous se trouvent sous
`/mnt/corsair-mp400/assist-gemma-abliterated-rmscomposite-20261016/cube-investigation/` :

- `matrix-1/source-hf.json`
- `matrix-1/palettes-hf.json`
- `matrix-1/embeddings-hf.json`
- `matrix-1/both-hf.json`
- `matrix-1/both-composite.json`
- `selective-1/lut4-only.json`
- `selective-1/lut8-only.json`
- `selective-1/restore-lower-half.json`
- `selective-1/restore-upper-half.json`

Les deux `summary.json`, les journaux, commandes et relevés mémoire restent
conservés. `matrix-1/independent-result-check.json` confirme les identités et le
préfixe face aux résultats complets antérieurs ; une première comparaison
d’objets avait rejeté le champ supplémentaire `applied`, puis la comparaison
explicite fichier/empreinte a confirmé les 275 identités.

L’enquête n’a modifié ni recette, ni poids, ni app et n’a pas lancé d’autre
conversion. Une éventuelle recette corrigée devra encore réussir les cubes
complets, les huit cas figés et les vérifications sur iPhone.
