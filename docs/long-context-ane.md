# Contexte long et attribution ANE

Protocole préparé le 16 octobre 2026 pour
`gemma4-e2b-32k-group8-rmscomposite`, contexte de 32 768 jetons.
Les cas courts ont été déclarés réussis par l’utilisateur. Cela ne constitue
pas encore un passage des nouveaux cas longs ni une mesure matérielle ANE.

## Fichiers de test

Le générateur [generate-long-context-tests.py](../scripts/generate-long-context-tests.py)
produit neuf messages synthétiques : trois variantes à chacun des paliers
d’environ 8K, 16K et 32K. Il utilise exclusivement un tokenizer local, compte
après application du template de conversation et refuse un dossier de sortie
existant. Les poids ne sont ni chargés ni modifiés.

```sh
python scripts/generate-long-context-tests.py \
  --tokenizer /chemin/vers/le/bundle/tokenizer \
  --output artifacts/long-context-nouvelle-serie
```

Utiliser l’environnement Python de l’export qui contient déjà Transformers.
Les artefacts locaux préparés sont dans
`artifacts/long-context-20261016/` : `index.html`, neuf prompts `.txt`, neuf
corrigés séparés et `manifest.json`. Ce dossier est ignoré par Git.

Chaque prompt demande exactement dix lignes :

- cinq codes placés vers 5, 25, 50, 75 et 95 % des jetons, avec des
  identifiants voisins servant de distracteurs ;
- une valeur à la révision numérique maximale, dont la ligne gagnante n’est
  pas la dernière ;
- une valeur obtenue par deux jointures entre des fiches éloignées ;
- une clé absente et une chaîne de jointures incomplète ;
- un conflit entre deux valeurs à la même révision maximale.

Les valeurs sont fixées avant toute réponse du modèle. Le corrigé ne doit
jamais être ajouté au message. Les mêmes variantes existent aux trois
longueurs pour comparer l’effet de la distance.

## Exécution et décision

1. Conserver le même modèle 32K et noter sa provenance, la build de l’app,
   l’OS et le type d’iPhone. Utiliser une température de zéro si elle est
   configurable ; sinon noter la valeur réellement utilisée.
2. Commencer par les trois cas 8K, puis les trois cas 16K, puis les trois cas
   proches de 32K. Pour chacun, ouvrir une nouvelle conversation, régler le
   budget de sortie à 256 et envoyer le prompt entier comme seul message.
3. Conserver le texte exact, le rapport de génération et le monitoring après
   chaque cas. Le nombre natif `promptTokens` fait foi ; le nombre Python du
   manifeste est une mesure préparatoire. Un changement de template peut
   modifier ce nombre. Entrée formatée + budget doivent tenir dans 32 768.
4. Comparer chaque ligne au corrigé, puis compter les cas entièrement exacts.
   Ignorer uniquement l’espace extérieur à la réponse. Les codes, la casse,
   la ponctuation et l’ordre des lignes doivent correspondre. Conserver les
   échecs, sorties tronquées, erreurs et crashs.
5. Pour la répétabilité, effectuer trois passages du même cas. Trois variantes
   différentes ne remplacent pas trois répétitions. Séparer les passages
   après relance normale de l’app de ceux réutilisant le même processus.

Une erreur à une question est un échec de ce cas. Pour distinguer une difficulté
de raisonnement d’un effet de longueur, comparer la même variante aux paliers
inférieurs. Conserver aussi premier jeton, durée totale, vrais jetons de sortie,
raison d’arrêt, mémoire maximale observée et état thermique. Le maximum
échantillonné n’est pas nécessairement le pic réel.

Ces cas évaluent des recherches et des règles documentaires précises. Même
un succès complet ne qualifie pas toutes les tâches possibles à 32K.

## Preuve d’activité ANE

Apple documente le template Instruments **Core AI**, qui réunit les
instruments Core AI, Neural Engine, GPU et Time Profiler. La timeline Core AI
sépare Specialization, Load, Setup et Inference et permet de développer
chaque modèle puis ses fonctions :
[Analyzing model runtime performance with Instruments](https://developer.apple.com/documentation/coreai/analyzing-model-runtime-performance-with-instruments).

Sur un iPhone physique visible dans Instruments :

1. Noter modèle, empreinte, préférence de calcul, build, OS et processus.
2. Enregistrer une période sans génération, une génération à entrée longue,
   puis une période sans génération. Répéter dans la même trace.
3. Rechercher les événements d’inférence du modèle, notamment ses fonctions
   `prompt_opt_*` et `extend_*`, et leur correspondance avec l’activité Neural
   Engine. Examiner simultanément GPU et CPU.
4. Conserver la trace `.trace` originale, une vue générale et une vue zoomée,
   avec le rapport du cas exécuté. Distinguer préparation et génération.

Une conclusion possible est « activité ANE observée pendant les inférences
de ce modèle dans cette trace ». Le résultat doit préciser les phases
observées et l’éventuelle activité GPU concomitante. Une préférence
`neural_engine_preferred`, un chargement réussi, la disponibilité de Metal,
des compteurs mémoire Metal ou une jauge de disponibilité ne prouvent pas
l’exécution sur ANE. Une activité ANE globale dont le client n’est pas
identifié reste insuffisante pour attribuer l’exécution à Assist.

## Environnement examiné

La VM macOS répondait aux commandes SSH le 16 octobre 2026 : macOS 15.7.9,
Xcode 26.3, xctrace 26.0. L’iPhone 16 Pro sous iOS 27.2 était visible dans
`devicectl` et `xctrace`, et Assist 1.0.0 build 11 y était installé.

La liste des templates de cet Xcode ne contient pas Core AI ; la liste des
instruments contient toutefois Neural Engine et GPU. Il faut vérifier une
capture réelle et son attribution avant de décider si cette installation
suffit. La présence de l’instrument ne prouve pas que la capture est possible
avec cette version d’iOS. Aucune installation ou mise à jour de Xcode n’est
effectuée par ce protocole.

Les essais de capture du jour ont échoué : le ciblage par nom puis par PID
ne retrouvait pas Assist dans Instruments, alors que `devicectl` confirmait
son processus après ouverture par l’utilisateur. La capture système a ensuite
atteint l’étape d’enregistrement, puis terminé avec le code 2 et le message
« An unknown problem is preventing this device from recording ». Une trace
partielle a été sauvegardée. Le même rapport signale l’absence de symboles
système pour cet iOS ; cet avertissement ne suffit pas à établir la cause
de l’échec. L’export de la table des matières de la trace montre une durée
nulle, aucun processus, aucune table de données et aucune piste. La trace
vide est conservée dans `artifacts/ane-20261016/`. Aucune attribution ANE
n’est établie par ces tentatives.

Pour poursuivre avec le protocole Core AI documenté par Apple, il reste à
disposer d’un Xcode qui fournit ce template et prend en charge l’iOS de
l’iPhone. Apple indique que Xcode 27 fonctionne uniquement sur Mac Apple
Silicon et demande macOS Tahoe 26.6 ou ultérieur : cette VM Intel ne peut
donc pas être mise à niveau vers ce chemin pris en charge. Le tableau des
versions demande également macOS 26.6+ pour Xcode 27.2 beta 2, qui fournit
le SDK iOS 27.2. Un autre hôte compatible et une capture réelle restent
nécessaires ; la cause précise de l’échec de capture avec Xcode 26.3 n’est
pas établie.

Sources : [notes Xcode 27](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes),
[exigences des versions Xcode](https://developer.apple.com/xcode/system-requirements).

Le panneau de télémétrie retrouvé dans `ales27pm/lumen-clone`, révision
`b8276064fb3fcbca8cbeed6a6a5394e767f2b00f`, affiche les jauges recherchées.
Son producteur `RuntimeAccelerationDiagnostics.forCurrentRuntime` fournit
cependant `nil` pour l’utilisation GPU et ANE, et `false` pour l’ANE utilisé
par son moteur GGUF. Le panneau montre alors une disponibilité et non une
utilisation mesurée. Son indicateur CPU est explicitement un proxy de densité
d’événements. Il ne constitue pas une source de preuve ANE pour Assist.

Sources : [panneau](https://github.com/ales27pm/lumen-clone/blob/b8276064fb3fcbca8cbeed6a6a5394e767f2b00f/ios/Lumen/Developer/DeveloperFramework.swift),
[producteur des valeurs](https://github.com/ales27pm/lumen-clone/blob/b8276064fb3fcbca8cbeed6a6a5394e767f2b00f/ios/Lumen/Services/RuntimeAccelerationDiagnostics.swift).
