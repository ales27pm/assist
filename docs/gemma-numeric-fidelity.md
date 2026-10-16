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

## Contre-vérification iPhone : rapports 9 à 19

Le nouveau dossier `gemma4-e2b-32k-group8` est ensuite chargé avec le build
**1.0.0 (3)** sous iOS **27.2**. Les huit cas courts donnent **7/8 réponses
exactes** : les carrés et les sommes sont corrects, mais le rapport 12 répond
`1, 4, 9, 16` à la consigne confirmée : « Réponds uniquement avec les quatre
cubes des nombres de 1 à 4, séparés par des virgules. » Le corrigé reste
`1,8,27,64` ; cet échec est conservé. Les autres cas sont rapprochés du jeu guidé
par leur ordre, leur réponse et leur nombre de jetons ; les rapports ne
contiennent pas les consignes.

L’utilisateur confirme ensuite la même réponse incorrecte quand cette consigne
est envoyée en premier après déchargement et rechargement du même dossier,
nouvelle conversation et budget 64. Cette confirmation textuelle ne fournit
pas un nouveau relevé de mesures, mais la simple réutilisation de la
conversation précédente ne suffit pas à expliquer l’erreur.

Le tokenizer Swift épinglé produit également les mêmes **32 identifiants** que
Python pour cette consigne des cubes et décode correctement les deux suites
numériques. Ce contrôle hors iPhone ne prouve pas les identifiants réellement
envoyés par le build installé. L’écart entre la référence CPU et le graphe
compilé reste à isoler ; la correction de compression ne résout pas toute la
fidélité numérique native.

| Rapports du nouveau modèle | Entrée formatée | Sortie | Observation |
| --- | ---: | ---: | --- |
| 9 à 16, huit cas courts | 32 à 56 jetons | 9 à 23 jetons | 7/8 exacts, fin EOS ; cubes incorrects |
| 17, texte 8K inchangé | 8 188 jetons | 64 jetons | Quatre premières lignes exactes sur six, fin `length` |
| 18, texte 16K inchangé | 16 372 jetons | 64 jetons | Quatre premières lignes exactes sur six, fin `length` |
| 19, texte près de 32K inchangé | 32 256 jetons | 64 jetons | Quatre premières lignes exactes sur six, fin `length` |

Les onze essais demandent un budget de **64**. Les trois réponses longues
complètes attendues font chacune **89 jetons avant EOS** avec le tokenizer
exporté : elles ne peuvent pas tenir dans ce budget. Refaire uniquement ces
textes inchangés avec **256 jetons de sortie**, une nouvelle conversation par
texte et le même modèle 32K. Même à 32 256 jetons d’entrée, il reste 512 jetons
dans la fenêtre de 32 768 ; ce réglage ne change pas la capacité du modèle.
Les deux lignes manquantes restent non évaluées, pas déclarées correctes.

Tous ces rapports reviennent à l’état `ready`. Ils recopient **un seul** relevé
de chargement de 135,14 s, avec une empreinte physique après chargement de
1 604 848 632 octets : ce ne sont pas onze chargements indépendants. Le maximum
échantillonné atteint 2 216 694 072 octets pendant le cas près de 32K ; il reste
une borne basse du pic réel. L’état du cache de spécialisation, le mode hors
réseau de cette série, la répétabilité et l’usage ANE ne sont pas établis.
Le nom du dossier ne remplace pas une empreinte du paquet installé.

## Rapports 20 à 23 : diagnostic natif et récupération longue

Le build **1.0.0 (4)** fournit maintenant les diagnostics attendus sur iPhone.
Le rapport 20 a l’empreinte exacte des **32 jetons** de la consigne des cubes,
avec les deux curseurs à zéro avant l’inférence. Les douze pas, EOS inclus,
ont des scores retournés finis et sélectionnent chaque fois le premier candidat.
Les identifiants décodent exactement `1, 4, 9, 16` : le choix glouton et le texte
affiché correspondent aux scores du moteur.

Le premier **choix de jeton** différent survient au pas 3, après le préfixe
commun `1, ` ; les scores diffèrent déjà aux pas précédents. La comparaison
des scores s’arrête ici, car les préfixes suivants ne sont plus identiques.

| Candidat au pas 3 | iPhone, scores retournés | Contrôle Apple eager CPU, normes HF32 |
| --- | ---: | ---: |
| `4` (236812) | 15,34375 | 15,203125 |
| `8` (236828) | 15,328125 | 15,8515625 |

Sur iPhone, la marge de `4` est **0,015625**, soit deux ULP FP16 à cette
amplitude. Le classement est inversé par rapport au contrôle CPU. Cela situe
l’écart avant le choix glouton ; l’opérateur responsable, les scores natifs
avant softcap et la fidélité générale du graphe restent à établir.

Avec le budget corrigé de **256**, les trois textes longs inchangés sont
maintenant complets et exacts, chacun sur un essai :

| Rapport | Entrée formatée | Sortie | Lignes exactes | Premier jeton | Durée totale | Maximum échantillonné |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 21, texte 8K | 8 188 | 89 | 6/6 | 3,29 s | 7,10 s | 1 987 235 432 octets |
| 22, texte 16K | 16 372 | 89 | 6/6 | 7,79 s | 11,48 s | 2 101 694 128 octets |
| 23, texte près de 32K | 32 256 | 89 | 6/6 | 17,34 s | 21,04 s | 2 211 647 272 octets |

Ces générations finissent par EOS et reviennent à `ready`. Les six lignes
incluent la réponse `ABSENT` ; près de 32K, la première clé `NACRE-32` est aussi
correcte. Le total maximal observé est **32 345 jetons**, dans la capacité de
32 768. Ces réussites qualifient ces trois cas synthétiques, pas toutes les
tâches longues ni leur répétabilité.

Les quatre rapports recopient un seul relevé de chargement de **2,73 s**, avec
1 579 977 336 octets après chargement. L’état du cache de spécialisation n’est
pas mesuré ; ce ne sont pas quatre chargements indépendants. L’identité du
paquet installé par empreinte, le mode hors réseau de cette série et
l’exécution ANE restent non établis.

## Diagnostic de l’écart restant

Un contrôle CPU du parcours Apple iOS, avec les mêmes palettes et tables INT8,
répond `1, 8, 27, 64` quand toutes ses normalisations utilisent l’ordre de
calcul HF en FP32. Le contexte déclaré reste 32 768, le palier court 1 024 et
les requêtes de huit positions reproduisent les masques, RoPE et caches du
moteur statique. La projection finale est calculée par tranches de vocabulaire
pour borner la mémoire ; dix petits contrôles ont vérifié l’égalité bit à bit
avec la projection complète, et neuf comparaisons incrémentales synthétiques
HF passent. Ce contrôle termine en 126 s, sans OOM ni arrêt de garde. Ce temps
concerne le diagnostic sur l’hôte, pas l’iPhone.

L’ablation HF en normalisations FP16 pures produit des jetons PAD, pas la
réponse incorrecte de l’iPhone. Ces contrôles eager ne passent ni par les
réécritures du compilateur Core AI ni par la spécialisation sur appareil. Ils
ne démontrent donc pas qu’une modification de normalisation corrigerait le
graphe livré.

Un contrôle supplémentaire limite volontairement la sortie aux quatre premiers
jetons et déplace uniquement l’arrondi avant la multiplication par le poids de
RMSNorm. Il choisit encore `8` au pas 3 : score 15,875 contre 15,1875 pour `4`.
Cette seule différence d’ordre d’arrondi ne reproduit donc pas le classement
natif. Le contrôle court termine par `length` après `1, 8` ; il ne constitue pas
une nouvelle réussite du cas complet. Aucun correctif d’export n’est déduit de
cette ablation négative.

Une lecture seule du véritable asset group8 trouve **12 graphes internes**
(neuf fonctions publiques et trois auxiliaires), avec 28 862 opérations. Les
résultats flottants déclarés sont tous FP16, notamment les 1 074 réductions
`reduce_mean` et les 1 074 `rsqrt`. Les normalisations ne portent donc pas de
frontière FP32 explicite dans cet export. Ce relevé décrit l’IR sauvegardé ; il
ne mesure ni la précision interne des opérations fusionnées sur iPhone ni leur
responsabilité dans l’inversion observée.

Le build de diagnostic **1.0.0 (4)** ajoute un champ optionnel
`numericalDiagnostics` aux rapports des requêtes gloutonnes d’au plus 64 jetons
d’entrée et 64 jetons de sortie. Il conserve les deux meilleurs scores finis
et l’identifiant choisi pour les **16 premiers pas**, EOS inclus s’il survient
avant cette limite. Les NaN/Inf sont comptés sans être sérialisés comme scores.
L’entrée est représentée par le SHA-256 des identifiants UInt32 en little-endian,
sans ajouter le texte de la consigne au rapport. Les scores proviennent du
moteur ; sur le moteur statique épinglé ils sont après le softcap final. Ce
diagnostic ne change pas l’échantillonnage et n’est pas activé sur les textes
longs. Son coût fait partie des durées des petits essais instrumentés.

Pour la consigne confirmée des cubes, l’empreinte attendue est
`cb364516a49b4006b836b933fc11ca273cb5a659bc05ff0d20fdf5ec2e15fc99`.
Le rapport 20 fournit cette empreinte et les scores natifs décrits ci-dessus.
L’étape suivante consiste à isoler la différence de calcul, puis à vérifier un
correctif sur cette même consigne, sans changer le corrigé ni la fenêtre 32K.

## Essai séparé avec normalisations HF32

Un candidat **expérimental**, `gemma4-e2b-32k-group8-hf32norm`, reprend les
**275 mêmes fichiers de palettes**, le même tokenizer et le même sidecar PLE.
Il conserve le modèle E2B entier et ses graphes 1 024, 8 192 et 32 768. Les
normalisations ordinaires et V sans poids demandent explicitement le calcul HF
en FP32 : carré, moyenne, epsilon non arrondi en FP16, inverse RMS et produit
par le poids, puis retour au dtype FP16 de l’entrée. Les valeurs FP16 des poids
de normalisation sont conservées et promues exactement en FP32.

Le petit contrôle indépendant `[1000, -2000]` expose une divergence des
primitives eager : les versions FP16 renvoient zéro, tandis que la référence
FP64 arrondie en FP16 et la variante HF32 donnent
`[0.63232421875, -1.2646484375]`. Quatre fixtures CPU/meta, avec palettes 4 et
8 bits, vérifient les sorties exactes, les buffers INT8 inchangés et les types
du véritable petit asset sauvegardé. Ce défaut eager ne reproduit pas la réponse
native des cubes et n’identifie pas son opérateur responsable.

La réutilisation des palettes passe par un adaptateur privé des modules de
finalisation de `coreai-opt 0.3.0` et `coreai-torch 0.4.3`, sans relancer KMeans ;
ces versions n’exposent pas d’API publique de restauration du cache finalisé.
Les 263 tenseurs source restants et les sept tables/scalaires sont chargés avec
un mapping strict. La table INT8 principale est régénérée par la recette
déterministe vérifiée ; ses octets ne sont pas comparés indépendamment à la
constante interne de l’ancien asset. Les empreintes des palettes et des autres
entrées sont vérifiées avant et après l’export.

L’export complet et ses contrôles internes terminent en **242 s**, sous une
limite de 8 Gio, sans OOM ni arrêt de garde, avec un maximum de cgroup de
7 516 717 056 octets. La lecture indépendante de l’asset trouve **1 074 moyennes
FP32**, aucune moyenne FP16, et les mêmes neuf signatures publiques, états et
contraintes des arguments que la référence. Le vérificateur Node indépendant
valide les neuf fichiers, soit **3 764 076 770 octets**. Le contrôle HF CPU des
mêmes huit consignes figées réussit encore **8/8**, dont `1, 8, 27, 64`.

L’archive distincte `Assist-Gemma-4-E2B-32K-group8-hf32norm.zip` contient
**2 784 796 452 octets**, avec le SHA-256
`cb63e75bf260be1227fa51e069a8945cc51e7cdd68dfd0beef1b676f09d25eca`.
Les neuf fichiers archivés ont été relus et comparés à l’inventaire. Le corps
HTTP complet donne aussi cette empreinte ; ce contrôle ne mesure pas la
réception ni l’exécution sur l’iPhone.

Ces contrôles portent sur l’export source et la référence CPU. Le chargement
sur iPhone échoue ensuite, avant de pouvoir mesurer la réponse des cubes ou
le placement de l’ensemble du modèle. La préférence Neural Engine du parcours
statique de l’app est conservée ; les opérations FP32 peuvent modifier le
placement et les performances. Ce paquet ne constitue donc pas un correctif
natif confirmé. Il s’importe comme dossier distinct dans le build TestFlight 4.
La recommandation d’essai et le téléchargement sont ensuite suspendus après
réception des journaux ci-dessous. Aucun nouveau chargement de ce candidat
n’est demandé pendant l’investigation.

## Échecs natifs du chargement, journaux de 23 h 07 et 23 h 08

Les cinq fichiers reçus concernent Assist **1.0.0 (4)** sous iOS
**27.2 (24B5110a)**, sur `iPhone17,1`. L’utilisateur confirme avoir sélectionné
`gemma4-e2b-32k-group8-hf32norm` lors de ces fermetures. Les journaux ne
contiennent ni ce nom ni l’empreinte du paquet installé : l’identité du dossier
repose sur cette confirmation, et ses octets installés ne sont pas vérifiés.

Les fichiers `.ips` et `.crash` du premier événement décrivent **le même
incident**, pas deux crashs. Environ **53 s après le lancement**, le processus
subit `SIGABRT` dans `Metal MTLReportFailure`, appelé par
`GPU::MemrefBufferizer::createMemrefHeap`. La pile remonte par le chargement
d’une fonction Core AI, `StaticShapeEngine.warmup` et `AssistInferenceCoordinator.load`.
Le thread d’interface reçoit aussi un avertissement mémoire. L’échec précède
la génération ; le graphe exact et la taille de l’allocation ne sont pas fournis.
Cette pile prouve le passage par un runtime GPU, sans établir le placement de
tout le modèle ni la responsabilité d’une normalisation particulière.

Le JetsamEvent suivant concerne **un autre processus Assist**, avec le motif
`per-process-limit`. Ses 216 064 pages de 16 384 octets représentent
**3 539 992 576 octets**, et `lifetimeMax` correspond à **3 598 221 312 octets**.
Ce sont les valeurs de comptabilisation de ce lancement, pas une limite fixe
universelle ni les maxima échantillonnés des rapports de génération précédents.
La conversion pages/octets suit la [méthode Apple pour les rapports jetsam](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports).

Le relevé d’écritures indique **4 294,98 Mo** de mémoire adossée à des fichiers
salie sur environ **8 931 s**, avec `Action taken: none`. Cet intervalle commence
avant le dernier lancement ; tout ce volume ne peut pas être attribué aux
53 secondes du crash. Le téléphone n’a que **1 818,46 Mo libres** au moment du
relevé, ce qui ajoute une contrainte pour la compilation. Le relevé ne prouve
cependant pas que le stockage est la cause directe de l’abandon Metal. Le
champ matériel `Memory size: 7.47 GB` n’est pas la consommation d’Assist.
La capture AutoBugCapture restante vise `amsengagementd`, pas un autre crash
d’Assist.

Le préchauffage de la dépendance épinglée charge et retient les six fonctions
`extend`/`prompt_opt` des trois paliers. Cela peut amplifier les allocations
résidentes, mais la pile ne révèle pas combien avaient déjà été chargées.
Retirer simplement le préchauffage pourrait déplacer l’échec à la première
génération ; ce n’est pas un correctif démontré.

Le paquet HF32 reste archivé avec ses empreintes d’origine. Sa page affiche
l’état suspendu et les requêtes GET/HEAD du ZIP répondent **HTTP 410**. Les
réussites CPU et d’intégrité restent des observations historiques, sans valider
le chargement sur iPhone. La fenêtre **32K** et le group8 de référence sont
conservés ; aucun passage implicite à 8K ou autre backend n’est introduit.

## Intégrité du paquet transféré

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
pas nécessaire pour reproduire l’erreur initiale des carrés avec les seuls
poids compressés.

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
