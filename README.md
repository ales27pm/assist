# Assist

Prototype React Native iOS indépendant de monGARS : conversation exécutée sur
l’iPhone, moteur Gemma 4 E2B via Core AI derrière un TurboModule typé. Première
qualification à **8 192 jetons**, puis cible **32 768 jetons**. Android reste une
extension future de la même interface, pas un moteur déjà disponible.

Ce dépôt contient le prototype et ses contrôles, **pas un modèle livré ni une
application iPhone qualifiée**. L’absence de plafond artificiel de 32 jetons ne
supprime pas la fenêtre finie du modèle : instructions, historique, entrée et
sortie se partagent le contexte disponible.

## Démarrer

- [Prérequis et compilation iOS](docs/ios-build.md)
- [Compilation distante et signature EAS](docs/eas-build.md)
- [Préparer les exports Gemma 8K / 32K](docs/gemma-export.md)
- [Embarquer un export Gemma vérifié dans l’IPA](docs/bundled-gemma.md)
- [Protocole de qualification sur iPhone](docs/qualification.md)
- [Architecture et limites du prototype](docs/architecture.md)
- [Vérifications exécutées et blocages](docs/verification.md)

Contrôles depuis la racine :

```sh
bash scripts/test-preflight.sh
bash scripts/preflight-ios.sh
```

Le second contrôle est volontairement bloquant sans Mac Apple Silicon, Xcode
27.1+ et SDK iPhoneOS 27.1+. Gemma reste réservé à iOS 27.2+ sur l’appareil ;
ce minimum d’exécution n’établit pas à lui seul un minimum de SDK de compilation.
Le contrôle ne modifie ni Xcode, ni les appareils, ni les certificats.
Un succès ne démontre pas que l’app compile ou que le modèle tourne.

## Entièrement local, pas entièrement déconnecté à l’installation

L’inférence visée ne dépend d’aucun serveur, service Tailscale ou API de modèle.
L’installation des dépendances et l’obtention initiale des poids nécessitent un
téléchargement ou un transfert local. Une future recherche web nécessitera aussi
Internet, sans impliquer une inférence distante.

Ni la mémoire personnelle persistante, ni les outils de recherche/code, ni les
tâches autonomes ne sont présentés comme déjà réalisés par ce prototype. Le
premier objectif est de qualifier le moteur natif et son cycle de vie.

## Confidentialité du dépôt

Ne pas versionner de poids, exports `.aimodel`, conversations, rapports contenant
des données personnelles, identifiants d’appareil, jetons Hugging Face,
certificats, profils de provisionnement ou archives signées. Le projet reste
séparé de monGARS : aucune migration ni suppression de ses imports.

« Core AI » ne signifie pas « toutes les opérations sur l’ANE ». Les tailles
de contexte et le placement matériel doivent être mesurés sur l’appareil cible.
