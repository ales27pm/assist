# État de vérification — 15 octobre 2026

Ce premier prototype est **partiellement vérifié**, pas livré sur iPhone.

## Contrôles locaux exécutés

- React Native 0.87.1, React 19.2.3 ; dépendances npm verrouillées.
- `npm run typecheck` et `npm run lint` : succès.
- `npm test -- --runInBand` : 28 tests de protocole et d’interface avec doublure
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
- Tests de prérequis : 15 cas ; cible app/Pods 27.1 et runtime Gemma 27.2 séparés.
- Empaquetage : 45 tests Node sur de petits fichiers synthétiques, inventaire
  exact et SHA-256, confinement, copie/relecture et refus des ressources absentes
  en mode livraison. Le profil `preview` impose ce dernier contrôle.
- La garde native iOS 27.2 est exécutée avant toute lecture du modèle ; syntaxe
  Swift et branche de disponibilité vérifiées, pas le moteur complet.

## Essai EAS et préparation de Gemma

Le projet `@27pm/assist` est créé. Le premier
[build EAS sans signature](https://expo.dev/accounts/27pm/projects/assist/builds/e51768ff-69cd-480b-a90b-ab50d7819a22)
sur Xcode 27.1 RC a passé les tests JavaScript et CocoaPods, puis **échoué** :
le SDK refuse une cible de déploiement 27.2. L’app et les Pods ciblent désormais
27.1, tandis que le chargeur refuse Gemma avant iOS 27.2. Cette correction ne
constitue pas encore une compilation native réussie.

Le [deuxième essai EAS](https://expo.dev/accounts/27pm/projects/assist/builds/554adb9b-05db-4c0d-a257-c0080c293e72)
a franchi ce blocage et atteint les sources natives, puis échoué à l’import du
header Swift généré : la superclasse React Native de l’AppDelegate n’était pas
déclarée dans l’unité Objective-C++. L’import explicite de son header est ajouté
avant `Assist-Swift.h` ; une nouvelle compilation réelle doit confirmer ce correctif.

Les neuf fichiers source de `google/gemma-4-E2B-it` à la révision documentée
ont été téléchargés hors Git et vérifiés (10 278 849 571 octets). Le shard
`model.safetensors` possède le SHA-256
`2db5482b20d746879bb3ef79b5203e9075a2e2b98f54ec7c2f281c1477ddc550`.
La conversion Core AI sous Linux a été vérifiée sur un Gemma **miniature
synthétique**, y compris les graphes 8K/32K et leur relecture. Aucun de ces tests
ne produit ni ne valide l’export du vrai checkpoint.

## Blocages explicites

Le Mac de vérification dispose de Xcode **26.3**, antérieur au minimum Core AI
**27.0** du paquet Apple. L’exigence **27.2** de Gemma porte sur l’exécution
sur iPhone ; l’ancienne formulation imposant aussi le SDK 27.2 était trop forte.
Le moteur Core AI complet n’a **pas encore été compilé ou exécuté**. Les poids
source sont disponibles, mais le vrai export Gemma n’est pas encore produit,
embarqué, chargé ou testé par ce prototype. Le bouton de chargement embarqué
et la phase de copie sont prêts ; aucun faux inventaire ne remplace l’export.
La signature EAS attend une connexion Apple Developer renouvelée par le
propriétaire ; aucun certificat ni profil Assist n’a encore été configuré.
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
