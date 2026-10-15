# Export Gemma 4 E2B 32K — 15 octobre 2026

Un véritable export texte **32 768 jetons** est préparé pour l’import manuel dans
Assist TestFlight. Le paquet a été rouvert et vérifié. Un premier rapport
physique confirme ensuite un chargement et une génération courte réussis. Les
rapports suivants exercent jusqu’à 32 256 jetons d’entrée, avec des résultats
partiels de qualité ; la stabilité répétée et l’usage ANE restent à qualifier.

## Provenance et conversion

- Source : `google/gemma-4-E2B-it`, révision
  `3e22461f65e89153144f8adb70e3b8c2cc9845a7`.
- Recette Apple : `apple/coreai-models`, révision
  `9db747612f972001279f02adb04d3ef982310d0e`.
- Environnement CPU Linux : Python 3.12.13, PyTorch 2.9.0+cpu,
  Transformers 5.12.1, coreai-core 1.0.0b3, coreai-torch 0.4.3 et
  coreai-opt 0.3.0.
- Poids BF16 source contrôlés contre leur empreinte publiée ; staging FP16
  vérifié sur les 2 011 tenseurs, puis recette de palettisation mixte 4 bits et
  sidecar PLE INT8. Les empreintes source ont été revérifiées après export.

La tentative précédente atteignait sa limite de mémoire et relisait massivement
les poids avant son arrêt automatique. L’export réussi conserve la cible 32K :
quantification par blocs, palettisation avec un seul worker, finalisation des
poids mappés sur disque via l’API Core AI et réutilisation des indices compactés
inchangés entre graphes. Les tests synthétiques ont vérifié les octets et
résultats avant/après ces adaptations, puis la sauvegarde/relecture de huit
graphes. Cela ne mesure pas la fidélité du modèle complet.

La conversion réelle a pris environ 7 min 16 s, avec un pic de cgroup proche de
8 Gio et aucun OOM. Le partage a enregistré 710 réutilisations et 205 nouveaux
compactages. Ces mesures concernent l’ordinateur de conversion, pas l’iPhone.

## Contrôles du paquet final

- Relecture de l’asset Core AI et contrôle des neuf fonctions : embeddings,
  gather 8/64, décodage et préremplissage des paliers 1 024, 8 192 et 32 768.
- Vérification des dimensions des entrées, sorties et caches, métadonnées texte,
  EOS et PLE, ainsi que des ressources locales du tokenizer.
- Identité du tokenizer et du template avec la source ; comportement des champs
  de configuration contrôlé, y compris les défauts utilisés par Swift.
- Rendu Python de deux conversations, avec accents et emoji : mêmes jetons avec
  le tokenizer source et le tokenizer exporté. Aucune comparaison des jetons
  rendus par Swift et Python n’a été mesurée.
- Vérification indépendante par `scripts/bundle-gemma.mjs` dans un dossier isolé
  contenant les vrais fichiers et leur inventaire SHA-256.
- Relecture complète du ZIP : chacun des neuf fichiers correspond à cet
  inventaire. Les poids restent hors de Git.

## Archive pour l’import manuel

- Nom : `Assist-Gemma-4-E2B-32K.zip`.
- Taille : **2 775 555 626 octets** ; dossier extrait : **3 760 449 746 octets**.
- SHA-256 :
  `e8d3324bed43f9d9f307a073f7137934c4f409352dacb6ff12cda9356ca0fc19`.
- Le téléchargement privé accompagne le ZIP de son empreinte,
  `validated-bundle.json` et `download-integrity.json`.

Extraire tout le dossier `gemma4-e2b-32k` dans **Sur mon iPhone**, puis le choisir
dans Assist. Prévoir l’espace pour l’archive, le dossier extrait et la
spécialisation. Aucun nouveau build TestFlight n’est nécessaire pour cet import.

Ces contrôles de préparation ne prouvent pas à eux seuls une génération correcte
sur iPhone. Le premier résultat physique reçu est décrit ci-dessous ; le
[protocole physique](qualification.md) complet reste à exécuter.

## Premier rapport physique

Le rapport utilisateur reçu le 15 octobre 2026 déclare le build natif **3**,
iOS **27.2 (24B5110a)** et le modèle `gemma4-e2b-32k`. Sa cohérence a été
contrôlée contre l’instrumentation native. Le rapport original est conservé hors
Git ; la conversation et l’identifiant de requête ne sont pas publiés.
Son SHA-256 est
`29e8b0bfa5c1f678c15c899ac2e28fd9aa8ed8f099dfca829839287a486ab98f`.

| Mesure rapportée | Résultat |
| --- | --- |
| Capacité déclarée du moteur | 32 768 jetons |
| Chargement, warmup compris | 94,74 s |
| Premier jeton, depuis le début de la requête native | 0,921 s |
| Entrée formatée / sortie générée | 42 / 251 jetons |
| Durée totale de génération | 7,362 s |
| Débit moyen de cet essai, délai initial inclus | 34,09 jetons/s |
| Empreinte physique de l’app après chargement | 1,586 Go |
| Maximum d’empreinte échantillonné pendant la génération | 1,660 Go |
| Fin de génération / état final | `eos` / `ready` |

Le modèle a produit une réponse française non vide et le moteur est revenu à
l’état prêt. Le débit inclut la préparation, le délai initial et la finalisation
de la requête ; il ne constitue pas une mesure isolée du décodage. Le rapport
ne sépare pas la spécialisation du chargement et ne renseigne pas l’état de son
cache. Les instantanés avant/après ne mesurent pas le pic du chargement, et les
échantillons de génération peuvent manquer des pics transitoires.

Cet essai utilise **293 jetons** au total. Le budget disponible de 32 726 jetons
ne signifie pas qu’ils ont été générés : la sortie s’est arrêtée à l’EOS après
251 jetons. La capacité déclarée de 32K ne prouve donc pas encore la qualité à
8K, 16K ou près de 32K. L’exécution ANE reste explicitement `unverified`.
Le rapport ne fournit ni empreinte du bundle installé, ni type d’iPhone, ni
preuve hors réseau ou de répétabilité.

## Rapports 2 à 8

Les sept rapports reçus sont cohérents avec les compteurs et la politique de
budget natifs. Leurs originaux, empreintes SHA-256 et analyse structurée restent
hors Git. Les trois tests longs sont comparés au corrigé synthétique préparé,
sans modifier les textes ni les réponses attendues après réception.

| Rapport / entrée réelle | Lignes exactement correctes | Premier jeton | Durée totale | Maximum mémoire observé |
| --- | --- | --- | --- | --- |
| 5 / 8 188 jetons | 6/6 | 3,138 s | 6,980 s | 2,015 Go |
| 6 / 16 372 jetons | 6/6 | 8,065 s | 11,736 s | 2,082 Go |
| 7 / 32 256 jetons | 5/6 | 19,692 s | 23,381 s | 2,192 Go |

Les cinq codes et la réponse d’absence sont présents dans le bon ordre au
rapport 7, mais la première clé est `IDENTIFIANT` au lieu de `NACRE-32`.
Cette ligne reste incorrecte pour un consommateur de paires identifiant/code.
La sortie compte 87 jetons : **32 343 jetons** au total ont été comptés pour cet
essai. Il s’agit d’un premier cas réel près de 32K, avec un défaut de format,
pas d’une qualification générale de cette longueur.

### Erreur de calcul confirmée

L’utilisateur confirme avoir demandé les cinq carrés des nombres de 1 à 5 dans
les rapports 2 et 8. Ils répondent tous deux `1,2,3,4,5` au lieu de
`1,4,9,16,25`. La sortie termine normalement à l’EOS après neuf jetons ; le
budget disponible est respectivement de 32 735 et 128 jetons. Il ne s’agit pas
d’une réponse tronquée par la limite de sortie.

Le tokenizer Python du paquet produit 33 jetons pour la consigne confirmée,
comme les compteurs natifs de ces deux rapports. L’inspection du chemin
JavaScript → pont natif → tokenizer ne montre pas de réécriture de la consigne.
L’égalité des comptes ne prouve toutefois pas celle des identifiants de jetons.

Deux contrôles CPU hors réseau ont ensuite été exécutés sur cette même consigne
avec `Gemma4ForConditionalGeneration`, Transformers 5.12.1, attention `eager`,
génération gloutonne et au plus 64 nouveaux jetons :

| Parcours | Réponse observée |
| --- | --- |
| Checkpoint BF16 original, SHA-256 source revérifié | `1,4,9,16,25` |
| Checkpoint FP16 intermédiaire, SHA-256 dérivé revérifié | `1,4,9,16,25` |
| Export Core AI sur iPhone, rapports 2 et 8 | `1,2,3,4,5` |

Les deux contrôles CPU ont terminé sans OOM ni déclenchement de leur garde de
réserve hôte. Ils ne constituent pas une mesure de performance iPhone ni une
preuve de parité numérique entre les implémentations. La conversion BF16→FP16
seule ne reproduit pas l’erreur sur ce cas. Il reste à isoler la palettisation,
la recette Core AI et le pipeline iOS. Le prochain contrôle discriminant est
la comparaison des 33 identifiants produits par Swift et Python, puis du
décodage des deux réponses numériques.

### Hors réseau, annulation et chargement

- L’utilisateur confirme **uniquement le rapport 2** en mode avion avec Wi-Fi
  coupé. Une génération locale achevée est donc observée dans ces conditions,
  avec une réponse mathématique incorrecte. Le rapport ne mesure pas lui-même
  l’état réseau ; les autres essais n’ont pas cette confirmation.
- Le rapport 3 enregistre une annulation après 23 jetons et un retour à `ready`.
  Une génération ultérieure termine normalement au rapport 4. Les mesures du
  dernier chargement diffèrent entre ces deux rapports : la reprise sur le
  même modèle résident, sans rechargement, n’est pas encore établie.
- Le rapport 4 abrège l’énumération de 1 à 5000 avec des points de suspension ;
  il ne démontre pas une énumération exhaustive.
- Quatre ensembles de mesures de chargement distincts apparaissent, entre
  **2,038 et 2,725 s**. Les rapports 4 à 7 répètent le même ensemble : ce ne
  sont pas quatre chargements indépendants. L’état du cache de spécialisation
  reste inconnu.

Les trois essais longs n’enregistrent aucun budget explicite : ils utilisent le
contexte restant, soit 24 580, 16 396 et 512 jetons, puis s’arrêtent à l’EOS.
Ils ne reproduisent donc pas exactement le budget de 256 prévu par le protocole.
Les comptes d’entrée correspondent aux estimations Python des trois fichiers,
sans comparaison directe des identifiants Swift/Python.

Le maximum mémoire reste échantillonné et le pic du chargement non mesuré.
L’attribution ANE, la répétition des cas longs, les sorties longues et la
récupération sans rechargement restent à qualifier. Le verdict de cette série
est **partiel**, avec deux échecs de calcul et un défaut de format conservés.
