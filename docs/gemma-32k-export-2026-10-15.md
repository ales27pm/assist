# Export Gemma 4 E2B 32K — 15 octobre 2026

Un véritable export texte **32 768 jetons** est préparé pour l’import manuel dans
Assist TestFlight. Le paquet a été rouvert et vérifié ; le chargement et la
génération sur iPhone ne sont pas encore qualifiés.

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
  le tokenizer source et le tokenizer exporté. Le rendu Swift n’a pas été exécuté.
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

Ces résultats ne prouvent ni une génération correcte sur iPhone, ni la capacité
32K réelle en conversation, ni les performances ou l’exécution ANE. Le
[protocole physique](qualification.md) reste à exécuter sur le paquet livré.
