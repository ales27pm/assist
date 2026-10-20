# TestFlight 29 — candidat et livraison

## Autorisation

Le 19 octobre 2026, Alexis demande explicitement : « Commit, push / Build and
submit with eas ». Cette instruction autorise le commit et le push de la branche
`feature/private-web-research`, puis une build EAS iOS du profil `testflight` et
la soumission de son ID exact après vérification des artefacts. Elle ne déclenche
ni OTA, publication App Store, diffusion externe, déploiement Ubuntu ni relance
payante automatique. Les anciens produits TestFlight sont conservés.

## Candidat source

Assist 1.0.0 (29), runtime `1.0.0-native29`, trois produits App/Share/Widget.
Le modèle complet Gemma 32K et les packs vocaux restent importables; le profil
TestFlight conserve `ASSIST_REQUIRE_BUNDLED_GEMMA=0`. Aucun poids, clé privée ou
contenu de l’iPhone n’est ajouté à Git ou envoyé comme ressource de build.

Le lot est détaillé dans les rapports de
[stabilisation](native29-stabilization-2026-10-19.md) et de
[compléments natifs](native29-native-bundle-2026-10-19.md) : 31 outils négociés,
cartes/météo avec attribution, AlarmKit/Live Activity, traduction locale,
scanner/PDF/Quick Look, MessageUI, Spotlight choisi et brouillons App Intents.
Le pont v1 garde ses 13 outils; aucun permis de mutation n’est créé par Siri,
Raccourcis ou Spotlight. La passerelle Ubuntu active reste v1, sans lecteur v2.

## Contrôles avant lancement

- 1 690 tests Jest / 57 suites, TypeScript, lint sans erreur et Codegen passants.
- 53 contrôles workspace et 25 contrôles de capacités; 31 schémas fermés,
  107 Tool Host, 44 boucle, 307 transactions, 35 alarmes, 57 traduction,
  78 documents; 47 tests d’archivage/symboles passent localement.
- Les nouvelles sources Swift et les deux extensions ont été compilées en
  objets optimisés sur SDK simulateur 26.2, concurrence stricte. Ce résultat ne
  remplace pas la compilation complète CoreAI sur la cible EAS Xcode/SDK27.1.
- La sérialisation native expo-updates est normalisée avant gel du commit,
  avec runtime29 et BSDiff conservés. L’archive réelle doit être contrôlée
  depuis le commit propre avant upload.
- Vérifier les trois profils distants, App Group et WeatherKit; ne pas révoquer
  de certificat existant ou réparer un compte sans nécessité identifiée.

## Vérifications avant et après soumission

Attendre le résultat du seul ID EAS lancé. En cas d’échec, conserver son état et
son diagnostic, sans relance automatique. Si la build réussit : télécharger IPA
et symboles de cet ID, vérifier signature/profils/entitlements des trois produits,
UUID et empreintes des symboles, source, runtime/canal, métadonnées App Intents,
confidentialité et exemption de chiffrement. Soumettre uniquement cet ID via EAS,
sans `--latest`, groupe automatique ou diffusion externe.

Le résultat EAS, le traitement Apple, la disponibilité TestFlight et le
fonctionnement physique iPhone sont consignés séparément. Les résolutions
Podfile.lock/Package.resolved produites par le runner doivent être conservées
comme preuves; leur absence dans ce candidat limite la reproductibilité native.

Aucune build29 n’existait dans la liste EAS consultée avant préparation.
Le résultat du lancement et les identifiants seront ajoutés après observation.
La [checklist iPhone](native29-iphone-acceptance.md) reste à exécuter sur le binaire.
