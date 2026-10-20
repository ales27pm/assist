# Native29 — stabilisation locale du 19 octobre 2026

Rapport de la première tranche. Le catalogue 16 et les blocs encore ouverts
ci-dessous décrivent ce jalon; ils sont complétés dans les
[implémentations natives suivantes](native29-native-bundle-2026-10-19.md),
avec catalogue 31 et nouvelles preuves locales. Ces deux tranches restent non livrées.

État source, non livré. Worktree `assist-private-web-research`, branche
`feature/private-web-research`, HEAD `ecbc78e80303e60f0adc3c6f65ffabe4df988da5`
avec changements non commités. Cette base contient déjà la référence locale
`origin/main` de l’audit, puis les trois commits de build28. Le checkout principal
`/home/ales27pm/assist` n’a pas été modifié par cette tranche. Les travaux présents
avant la reprise sont conservés; aucun reset, fusion globale, commit ou push.

## Comportements corrigés

- Le Tool Host v2 annonce `device-v2-16` : `maps_search`, `maps_directions` et
  `weather_forecast` traversent schémas Gemma, registre fermé, validation,
  confirmation tactile, exécution Apple et reçus. Le pont v1 conserve ses 13
  outils. La sélection v2 est figée et les contrats incompatibles sont refusés.
- Les lieux et le fournisseur sont explicitement présentés avant l’accès Apple.
  Les réponses sont bornées, validées et liées à l’opération. Aucun GPS implicite.
- Le reçu météo final conserve les prévisions même si l’activité intermédiaire
  manque. La carte et la réponse attendent la vraie marque officielle chargée;
  annuler invalide aussi l’affichage tardif des températures, pas seulement la
  prose/TTS. Les résumés génériques ne contiennent pas de valeurs météo.
- Après changement confirmé de moteur et au retour au chat, les capacités
  vocales sont relues. Un ancien résultat ne remplace pas cette relecture.
  Le choix de voix est réconcilié avec le natif après une sauvegarde interrompue
  par inactive/active, sans rejouer un aperçu.
- La génération texte réserve la même identité révocable que les outils et la
  recherche avant son lancement asynchrone. Annuler avant admission empêche le
  calcul; l’acquittement attend le drainage de l’opération concernée.
- Le natif refuse plus de 4 Mio de JSON UTF-8 avant décodage, plus de 512 messages
  pendant décodage, ou plus de 1 Mio par message. Le rejet explique comment
  poursuivre; aucune troncature silencieuse. Le vrai budget après template et le
  modèle complet 32K sont conservés.
- La préparation/tokenisation quitte l’acteur propriétaire tout en gardant son
  verrou. L’acteur peut traiter statut/annulation; la fonction synchrone du
  tokenizer n’est pas préemptible mais son résultat annulé n’atteint pas le moteur.

## Archivage local et dépendances

`.easignore` permet maintenant au copieur EAS de parcourir les répertoires
autorisés. `mobile/eas.json` conserve `requireCommit: true` et TestFlight conserve
`ASSIST_REQUIRE_BUNDLED_GEMMA=0`, avec import signé du modèle complet.

`scripts/prepare-eas-archive.mjs` exige une source propre committée et produit une
préparation hors dépôt avec inventaire SHA-256 et archive locale, sans appel à
EAS build/upload/submit. Pour preview uniquement, la copie isolée utilise
`requireCommit=false` et ajoute le bundle complet 32K depuis un verrou externe
dont l’empreinte a été revue indépendamment. La copie réellement produite par
EAS est comparée aux sources et ressources attendues; liens, clés privées,
fichiers inattendus et dépassement de taille compressée sont refusés.

```sh
node scripts/prepare-eas-archive.mjs --project-root /chemin/checkout-propre --profile testflight --output /chemin/nouvelle-preparation
node scripts/prepare-eas-archive.mjs --project-root /chemin/checkout-propre --profile preview --output /chemin/autre-preparation --bundle /chemin/bundle-approuve --lock /chemin/verrou-revu.json --lock-sha256 EMPREINTE_SHA256_REVUE
```

Ces commandes préparent une preuve locale, pas une livraison. Aucun vrai modèle
ni archive du candidat actuel n’a été préparé : ses changements ne sont pas
commités. Les tests utilisent de petits bundles factices hors Git.

Les overrides corrigent UUID dans les consommateurs CommonJS et plusieurs
dépendances compatibles de l’outillage EAS. Expo58, RN0.88 et TypeScript6 mobile
sont conservés. Le lockfile racine utilise TypeScript5.9.3 pour satisfaire le peer
de son outillage; sa version antérieure empêchait `npm ci`. Les dépendances
versionnées sous `node_modules` restent inchangées. Une reconstruction isolée
valide les nouveaux locks et les consommateurs Xcode/Bunyan/EAS.

Audit frais des lockfiles :

| Graphe | Avant cette tranche | Après | Répartition restante |
| --- | ---: | ---: | --- |
| Racine, outillage EAS | 32 | 18 | 11 élevés, 6 modérés, 1 faible |
| Mobile | 60 | 53 | 35 élevés, 18 modérés |

Ces nombres sont des entrées propagées, pas autant de failles indépendantes.
`braces`, `node-forge` et `sprintf-js` restent sans version corrigée publiée au
relevé npm. `diff` et `ts-deepmerge` côté racine demandent un traitement séparé
avec changement majeur. Les chemins observés concernent Metro/Jest/CLI,
certificats de développement Expo et couverture; aucun import correspondant
n’a été trouvé dans App/src. Cela ne prouve pas leur absence d’un IPA. Même
`--omit=dev` conserve des transitives CLI Expo et ne mesure pas l’exposition iPhone.

## Vérifications et limites

- `npm run check` termine avec exit0 : TypeScript, ESLint sans erreur (un avertissement de shadowing préexistant),
  **1 550 tests / 50 suites Jest**, Codegen iOS et contrôles de câblage workspace
  passent, dont **42 contrôles workspace**. Le test CLI de capacités utilise désormais son chemin propre,
  indépendamment du répertoire de lancement; **25 tests** passent depuis mobile.
- **47 tests Node** archivage EAS et symboles, **74 contrôles de bundles** et
  **3 contrôles** des dépendances passent, ces derniers sur une reconstruction
  isolée. Les hooks sont inclus dans Jest. Aucun de ces tests n’est l’archive réelle.
- Swift6.2.4/concurrence stricte : **101 politiques**, **9 admission/préparation**,
  **81 boucle agentique**, **16 schémas**, **92 Tool Host**, **44 boucle outils**,
  **64 transactions**, **69 Apple Places** passent dans le conteneur existant,
  réseau désactivé et dépôt en lecture seule. Syntaxe CoreAI et gardes de câblage
  vérifiées. Ces harnais utilisent des collaborateurs scriptés.
  Les 15 gardes de câblage agent et 12 contrats vocaux Python passent également.
- La tokenisation annulée est drainée avant libération du moteur. L’annulation
  réseau Apple demande l’arrêt et invalide les résultats; elle ne prouve pas
  l’arrêt physique complet du travail des frameworks Apple.

Les révisions natives/entitlements/runtime restent `1.0.0-native29`, source-only.
Compilation complète CoreAI/Tokenizers/Objective-C++, signature des trois produits,
WeatherKit, Gemma réel et qualification iPhone restent non vérifiés. Build28 reste
la dernière livraison selon les preuves historiques. Aucun EAS, OTA, upload,
déploiement du lecteur v2 ou changement de compte Apple exécuté.

La [checklist du lot](native-bundle-preparation.md) reste ouverte pour la
compilation complète, la signature et la qualification physique. AlarmKit et
countdowns, traduction, App Intents/Raccourcis et documents ont été complétés
dans la tranche suivante, sans que leur présence source les qualifie. La
[réception iPhone](native29-iphone-acceptance.md) est un protocole, pas un résultat.
