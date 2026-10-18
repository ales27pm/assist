# Outils dans le fil : première tranche calendrier

Cette réception visuelle conserve le parcours calendrier initial. Les cartes,
confirmations et reçus des 13 outils, dont l’OCR Apple, sont décrits dans
[l’extension conversationnelle](device-tool-agent.md). Les exclusions et preuves
ci-dessous ne doivent pas être interprétées comme l’état de cette extension.

Le design du 18 octobre est appliqué au parcours **déjà borné** de consultation
du calendrier. Il ne reconstruit ni l’assistant ni le panneau manuel PR2.
Aujourd’hui seulement, **cinq événements maximum**, aucune mutation et aucun
déclenchement sur un message ordinaire ou une transcription vocale. L’exemple
« demain matin » du brief n’est donc pas annoncé comme disponible.

## Source des états et de la preuve

`ToolCallCard` est une vue : elle n’importe pas le bridge et n’exécute rien.
Elle réutilise `appearance`, `uiGrammar`, `ActionButton`, `Disclosure` et une
extension calendrier de l’iconographie native existante. Aucun paquet ajouté.

| Affichage | Preuve qui l’alimente |
| --- | --- |
| Préparation | Tâche explicitement déclenchée par le bouton calendrier. Pas de lecture déclarée. |
| Consultation en cours | Événement natif après appel complet, nom et arguments validés. |
| Réponse en préparation | Observation native validée, reçu de lecture déjà acquis. |
| Lecture confirmée | Reçu validé : période, nombre retourné et éventuelle troncature. Jamais la prose de Gemma. |
| Réponse interrompue / non finalisée | Arrêt ou échec sans effacer un reçu déjà acquis. |
| Calendrier non consulté | Réponse directe sans appel ni preuve contradictoire d’exécution. |
| Accès calendrier requis | Code natif stable `E_PERMISSION`, sans reprendre son message brut. |

Le nouvel événement dédié `onCalendarActivity` transporte une enveloppe `{json}`.
Son contenu fermé/versionné contient seulement identité de requête, séquence
1/2/3, phase, période et reçu sur la troisième phase. Aucun titre, note, résultat
brut, commande ou fragment de planification. Le même reçu est utilisé dans la
réponse finale. Les événements périmés, hors séquence, incohérents ou malformés
ne changent pas la carte; une contradiction finale bloque le résumé.

L’annulation ferme immédiatement l’admission JS aux nouveaux événements/résultats
et affiche l’attente d’arrêt. L’état terminal attend l’ACK natif, qui attend le
drainage de l’opération. Une lecture déjà confirmée n’est pas présentée comme
annulée rétroactivement. Aucun retry automatique. Les cartes et réponses dérivées
des outils restent visibles dans la session mais hors du contexte réutilisé par
la conversation ordinaire.

La carte affiche une date compacte; les bornes exactes, le fuseau et la fin
exclusive restent dans un disclosure. Elle n’utilise pas l’heure JS pour
recalculer une période qui différerait de celle autorisée par le natif. Zéro
événement retourné ne devient pas une garantie d’agenda vide; cinq retournés
signalent explicitement que la liste peut être incomplète.

## Permissions et éléments volontairement différés

« Gérer l’accès au calendrier » ouvre Réglages; le panneau **Outils de l’appareil**
conserve la demande iOS explicite. Ouvrir ce parcours n’accorde aucune permission,
ne consulte pas les événements et ne relance pas la tâche précédente.

Les sheets permission/confirmation dédiées, créations de rappel/événement,
permis d’action, journal durable et réconciliation restent à construire dans
leurs lots natifs. Aucune carte de mutation ni faux reçu de création n’est
présenté comme fonctionnel. `outcome_unknown` reste nécessaire aux futures
écritures, pas une raison d’ajouter un retry aveugle à cette première lecture.

## Prévisualisation visuelle distincte du runtime

`npm run preview:build`, puis un serveur Vite **production preview** sur un port
fixe, expose `/tool-states`. Cette route utilise les vrais composants et thèmes,
mais des fixtures explicitement étiquetées « données fictives · aucune lecture
iOS ». Le bridge de preview reste `null`; la route `/` montre toujours l’app
sans moteur natif. Ces fixtures ne sont pas incluses dans le point d’entrée iOS.

L’aperçu couvre les trois thèmes, préparation/exécution, succès zéro/cinq,
permission, annulation avant/après reçu et échec après reçu. Son zoom éprouve le
retour à la ligne, **pas** Dynamic Type. Les labels, actions accessibles et
changements d’état non tokenisés sont testés séparément; VoiceOver et le vrai
calendrier demandent une réception sur iPhone.

Les liens de maquettes `sandbox:/mnt/data/…` du brief ne correspondent pas à des
fichiers disponibles dans ce workspace. Le rendu est fondé sur les composants
et tokens du dépôt, sans prétendre reproduire des images qui n’ont pas été vues.

## Vérifications du 18 octobre

- `npm run check` : **1039 tests / 37 suites**, TypeScript, ESLint sans avertissement
  et Codegen iOS réussis. Trois suites ciblées couvrent **124** contrôles de carte,
  transaction et intégration App, dont génération terminée avant l’ACK d’arrêt.
- **81 contrôles Swift** de boucle avec exécuteur/modèle scriptés; parse syntaxique
  arm64 iOS sans diagnostic. Swift 6.2.4 / SDK 26.2 : pas un typecheck de l’app
  Core AI SDK27, ni un essai EventKit/iPhone.
- Prévisualisation production sur `http://127.0.0.1:5193/tool-states` : **264 cas**
  (11 états × 3 thèmes × 4 largeurs 320/390/768/1440 × zoom 100/200 %) sans
  débordement horizontal détecté. Le disclosure s’ouvre/ferme avec Entrée et
  conserve le focus. Inspection visuelle des captures et correction du titre
  sur petit écran en grand zoom, au-delà du seul contrôle de débordement.
- Contrastes du texte du fil de succès synthétique : minimum **6,02 / 8,86 / 5,55**
  pour Light/Graphite/Blue. Ce contrôle borné n’est pas un audit WCAG complet.
- Captures locales non versionnées : [clair](../artifacts/tool-ui/light.png),
  [graphite](../artifacts/tool-ui/graphite.png), [bleu](../artifacts/tool-ui/blue.png),
  [320 px / 200 %](../artifacts/tool-ui/permission-320-200.png),
  [matrice de rendu](../artifacts/tool-ui/layout.json).

Le build du preview réussit, avec avertissements de bundling React Native Web
(`use client`) et taille du chunk Web supérieure à 500 kB. Aucun paquet ni
réglage du bundle natif n’a été ajouté pour les contourner. Le checkout principal
sale est resté inchangé; tout le travail se trouve dans le worktree isolé.

## Livraison

Cette tranche étend le bridge natif préparé pour **build/runtime 28**, elle n’est
pas une OTA compatible native27. Le handshake exige aussi l’événement dédié.
Aucune publication, compilation complète, signature ou installation n’est
effectuée. Voir [le contrat et la réception native](gemma-calendar-agent.md).
