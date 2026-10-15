# État de vérification — 15 octobre 2026

Ce premier prototype est **partiellement vérifié**, pas livré sur iPhone.

## Contrôles locaux exécutés

- React Native 0.87.1, React 19.2.3 ; dépendances npm verrouillées.
- `npm run typecheck` et `npm run lint` : succès.
- `npm test -- --runInBand` : 21 tests de protocole et d’interface avec doublure
  du moteur natif. Ne prouve pas l’inférence.
- `npm run codegen:ios` : succès ; protocole, événements et fournisseur
  `NativeAssist` → `RCTNativeAssist` générés.
- Bundle JavaScript iOS Release produit par Metro : succès. Avertissement de
  résolution d’un sous-chemin privé `ReactNativeFeatureFlags` dans les
  dépendances amont ; aucune compilation native n’est impliquée par ce succès.
- Swift 6 : 28 contrôles Foundation de contexte, chemins, EOS et UTF-8 exécutés sur
  macOS ; sélecteur UIKit type-checké avec le SDK simulateur disponible.
- Syntaxe du moteur Swift et format du projet Xcode contrôlés. Une analyse
  syntaxique ne vérifie ni les symboles Core AI ni leur édition de liens.
- Tests de prérequis : 12 cas contrôlés passent.

## Blocages explicites

Le Mac de vérification dispose de Xcode **26.3**, et non du SDK **27.2** requis.
Le moteur Core AI complet n’a donc **pas été compilé ou exécuté**. Le modèle
Gemma n’a pas été exporté, téléchargé, chargé ou testé par ce prototype.
Les 8K/32K, la stabilité, les performances et l’usage matériel de l’ANE restent
à qualifier. Aucune signature, installation ou modification de monGARS.

Le sélecteur n’effectue pas de copie durable : le dossier doit rester disponible
sur l’iPhone, et doit être sélectionné à nouveau après fermeture de l’app.
L’historique de conversation est également limité au processus pour cette étape.
Les contrôles de structure ne certifient pas l’identité cryptographique des poids.

## Alerte dépendances non résolue

`npm audit --omit=dev --audit-level=high` échoue : 20 entrées transitives liées
à l’avis [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
sur `braces` 3.0.3, via Metro/CLI et leurs dépendances. Ce nombre n’est pas
20 vulnérabilités indépendantes. L’avis ne publie pas de version corrigée à la
date du contrôle. `npm audit fix --force` propose un retour incompatible à
React Native 0.72 : cette modification n’a pas été appliquée.

Ne pas exposer Metro au public ni donner des motifs glob non fiables à cet
outillage. Aucun correctif amont ni absence d’impact n’est revendiqué.
La CI de contrat ne doit pas être interprétée comme un audit sécurité vert ou
une autorisation de livraison. Réévaluer cet avis avant distribution.
