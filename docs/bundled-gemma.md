# Inclure Gemma dans l’app signée

Le code d’empaquetage est prêt à contrôler et copier un **véritable export**.
Cela ne signifie pas qu’un export existe, qu’une IPA signée le contient déjà ou
que Gemma fonctionne sur l’iPhone. Aucun faux modèle ni verrou d’inventaire
provisoire ne doit être créé pour faire réussir une compilation.

## Entrées contrôlées

Après la conversion et la vérification indépendantes décrites dans
[gemma-export.md](gemma-export.md), placer le dossier complet à cet emplacement
local, hors du suivi Git des poids :

```text
mobile/ios/Assist/BundledModels/Gemma/
  metadata.json
  <nom-export>.aimodel/…
  <sidecar-PLE>
  tokenizer/tokenizer.json
  tokenizer/tokenizer_config.json
  tokenizer/chat_template.jinja
  …tous les autres fichiers du bundle vérifié
```

Le chemin `.aimodel` et le sidecar PLE sont lus depuis `metadata.json` ; leurs
noms ne sont pas devinés. Il faut le modèle complet, pas les poids Hugging Face
bruts. Une ressource iCloud non téléchargée n’est pas suffisante.

Le checkpoint Gemma épinglé fournit son template de conversation dans
`chat_template.jinja`, pas dans `tokenizer_config.json`. Conserver ce sidecar
dans le dossier `tokenizer/` de l’export : le chargeur Swift local le lit et
l’associe à la configuration. Son absence est bloquée avant l’empaquetage,
même si le reste de l’inventaire et ses empreintes sont cohérents.

Une fois l’export réel vérifié, créer et revoir séparément
`mobile/gemma-bundle.lock.json` avec ce schéma :

```json
{
  "schemaVersion": 1,
  "model": {
    "repository": "google/gemma-4-E2B-it",
    "revision": "3e22461f65e89153144f8adb70e3b8c2cc9845a7"
  },
  "export": {
    "repository": "apple/coreai-models",
    "revision": "9db747612f972001279f02adb04d3ef982310d0e",
    "contextLength": 8192
  },
  "files": [
    {"path": "metadata.json", "bytes": 0, "sha256": "EXEMPLE_NON_VALIDE_A_REMPLACER"}
  ]
}
```

Cet exemple est volontairement **invalide** : remplacer l’inventaire par les
tailles et SHA-256 réels de **chaque** fichier de l’export approuvé. Le contexte
doit être 8 192 ou 32 768, identique aux métadonnées. Ne pas régénérer ce verrou
automatiquement juste avant la compilation : un inventaire recalculé sur des
fichiers altérés ne constitue pas un contrôle indépendant. Le dépôt conserve le
verrou approuvé ; les gros fichiers restent hors de Git mais doivent être
présents dans l’archive de construction EAS lorsque Gemma est requis.

La vérification refuse un inventaire vide, incomplet ou comportant des extras,
les empreintes incorrectes, les chemins absolus/traversants, les liens
symboliques et les fichiers spéciaux. Les fichiers tokenizer, l’asset Core AI
et le PLE doivent être présents et non vides. Le SHA-256 est calculé en flux
avec des blocs bornés, sans mettre les poids entiers en mémoire.

Les révisions dans ce verrou sont des déclarations de provenance à contrôler
lors de l’export, **pas une signature cryptographique du producteur**. Le verrou
fixe les octets approuvés, mais ne démontre ni la fidélité numérique de l’export,
ni la capacité 32K réelle, ni l’exécution matérielle ANE.

## Vérifier avant l’envoi EAS

Depuis la racine du dépôt :

```sh
node scripts/bundle-gemma.mjs --verify
node --test scripts/test-bundle-gemma.mjs
```

`--verify` échoue si le bundle ou le verrou manque. Les tests utilisent uniquement
de minuscules fichiers synthétiques et ne remplacent pas le test du vrai modèle.

Pour les contrôles d’un prototype sans poids seulement :

```sh
node scripts/bundle-gemma.mjs --verify --if-present
```

Cette option n’autorise l’absence que si **le bundle et le verrou manquent tous
deux**, et seulement lorsque `ASSIST_REQUIRE_BUNDLED_GEMMA` ne vaut pas `1`.
Une présence partielle, une empreinte erronée ou des métadonnées incompatibles
reste toujours une erreur. Le profil destiné à fournir Gemma dans l’app doit
définir `ASSIST_REQUIRE_BUNDLED_GEMMA=1`, y compris lors de la vérification avant
l’upload et de la compilation Xcode. Ne pas désactiver ce contrôle pour obtenir
une IPA qui ne satisferait pas la demande.

## Copie dans les ressources iOS

La phase de construction Xcode exécute, depuis `mobile/ios` :

```sh
node ../../scripts/bundle-gemma.mjs --copy
```

Elle utilise les variables Xcode `SRCROOT`, `TARGET_BUILD_DIR` et
`UNLOCALIZED_RESOURCES_FOLDER_PATH`, vérifie les octets source, copie les fichiers
approuvés dans `Assist.app/BundledModels/Gemma`, puis **recalcule les empreintes
des octets copiés**. La source doit être ce projet iOS et la destination doit
rester à l’intérieur du dossier `.app` dérivé de ces variables.

Un fichier destination déjà présent n’est réutilisé que si son empreinte est
correcte. Les fichiers divergents ou supplémentaires font échouer la phase ;
le script ne les efface pas et ne les écrase pas. Utiliser un nouveau dossier
de construction après avoir compris l’écart. Si les entrées sont absentes lors
d’un build prototype facultatif, une ancienne copie de Gemma dans `.app`
provoque également un échec, pour éviter de distribuer silencieusement des poids
périmés.

Après création de l’IPA, vérifier son inventaire réel et sa signature avant
publication. Le transfert EAS et la signature sont distincts de la
[qualification physique](qualification.md) : chargement, mémoire, qualité,
annulation, contexte long et trace ANE restent à tester sur l’appareil cible.
