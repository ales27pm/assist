# Assist — analyse des outils et amélioration du contexte Gemma

État du 20 octobre 2026. Worktree `assist-private-web-research`, branche
`feature/private-web-research`, base `60d54a28f743ddd5ae1df47cf97b7bab49cf5b53`.
Les modifications préexistantes sont préservées. Les changements décrits ici
sont des sources non livrées ; aucune nouvelle build Assist, OTA, soumission,
installation ou modification de la passerelle n’a été lancée.

La [seconde passe approfondie](device-tool-deeper-review-2026-10-20.md)
consigne les correctifs et vérifications supplémentaires. Les chiffres
ci-dessous restent ceux de cette première tranche.

## Conclusion de la revue

Les essais des 31 outils ne démontraient pas une sélection naturelle fiable
ni 31 résultats utilisateur réussis. Ils établissaient des observations
distinctes : choix de l’outil, arguments, confirmation, effet natif, réponse
finale, fidélité du texte, annulation et reprise. Une création confirmée
suivie d’un message d’échec est un défaut produit, même si le contrat JSON
est valide : elle peut pousser l’utilisateur à recréer un objet déjà présent.

Les priorités sont la vérité du reçu, la fidélité de la réponse et la
continuité du but. Une amélioration mesurée du choix par les vrais poids de
Gemma reste à établir ; le candidat n’est pas présenté comme optimal ni
qualifié sur iPhone par les seuls contrôles locaux.

La [matrice historique complète, 31 outils sur huit axes](/home/ales27pm/.local/share/assist/context-review-20261020/tools31-evidence/tools-matrix31.md)
et son [analyse détaillée](/home/ales27pm/.local/share/assist/context-review-20261020/tools31-evidence/report.md)
conservent les limites de chaque cas. Le [rapport physique initial](/home/ales27pm/.local/share/assist/releases/1.0.0-29-f1cbfd7a/all-tools-20261020/report.md)
reste inchangé. Les correctifs précédents sont décrits dans
[native29-tool-fixes-2026-10-20.md](native29-tool-fixes-2026-10-20.md).

## Résultats qui ont guidé les modifications

| Famille | Preuve physique antérieure | Problème à traiter |
| --- | --- | --- |
| Contacts, calendrier, rappels | Fixtures relues et absences recoupées après nettoyage | Choix spontané, fuseaux, listes tronquées et reprise encore peu mesurés |
| Créations, notifications, alarmes | Sept mutations avec effet confirmé puis finalisation échouée | Le reçu et l’incertitude doivent rester prioritaires ; ne pas répéter l’effet |
| Cartes | Recherches et trajet reçus ; certains nombres conservés seulement dans la prose | Recouper les chiffres et unités avec les données natives |
| Météo | Échecs gérés ; demande 0/0 d’abord proposée 1/1 | Rendre la signification de zéro visible ; retester après activation Apple |
| Traduction | Réponse sans outil, puis traduction native après insistance | Rendre explicite le parcours de traduction quand les outils sont activés |
| Documents | Lecture exacte ; aperçu suivi d’un contenu inventé ; recherche Spotlight crashante | Distinguer texte acquis, métadonnées et aperçu ; préserver leur provenance |
| Photo, caméra, scanner, Face ID | Ouvertures/annulations ou échec géré | Les succès OCR, scan et authentification restent à qualifier physiquement |
| Composeur | Destinataire, objet et texte vérifiés ; annulation observée | Ne pas déduire envoi, livraison ou pièce jointe de l’ouverture du composeur |

L’activation WeatherKit dans App Services et la synchronisation du profil EAS
ont été vérifiées séparément. Le retest iPhone suivant n’a pas franchi
CoreDevice1011 ; il ne fournit aucune nouvelle prévision. Les anciennes
erreurs avaient perdu leur catégorie : le réglage manquant ne démontre pas
rétrospectivement leur cause exclusive.

## Modifications du candidat

### Des contraintes effectivement visibles dans le prompt

Le template canonique Gemma rend les descriptions, les types et les enums,
mais omet notamment `minimum`, `maximum` et `maxLength`. Une borne présente
seulement dans le schéma Swift ne pouvait donc guider le modèle, même si
l’hôte la vérifiait ensuite.

Les descriptions précisent maintenant les unités, les bornes et les
préconditions utiles : zéro pour les prévisions horaires/quotidiennes,
secondes et conversion des minutes, pages du scanner, durée d’indexation,
langues, identifiants exacts et provenance du texte. Les enums `alarm/timer`
et `email/sms` sont déclarées. `document_preview`, `document_read`,
`document_search` et `document_scan` ont des finalités distinctes. La
politique demande le traducteur natif pour une traduction à cible claire,
tout en permettant une conversation ordinaire sans outil.

Aucun routeur par mots-clés, second modèle ou nouveau framework agentique
n’a été ajouté. Les 31 outils restent déclarés ; masquer arbitrairement une
famille sans évaluation du vrai modèle risquerait de cacher l’outil utile.
Le dialecte, les marqueurs et le template canonique restent conservés.
[Appels de fonctions Gemma](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4),
[format des tours](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4).

### Références conversationnelles négociées

Avec les outils activés, l’ancien parcours supprimait tout l’historique avant
chaque demande. Le contexte v3 permet des références aux échanges récents
sans transformer un ancien accord ou une ancienne demande en nouvelle action.

- La demande actuelle reste un seul message utilisateur, de 8192 octets au plus.
- Le sidecar contient au plus trois paires complètes, 2048 octets UTF-8 par
  texte et 8192 octets au total ; le payload JSON reste borné à 24 Kio.
- Les textes sont exacts, sans résumé automatique. Les paires sont écartées
  entières si nécessaire ; `omittedTurns` rend les exclusions explicites.
- Aucun reçu brut, marqueur, chemin privé ou UUID interne n’est repris.
  Ce filtrage structurel n’anonymise pas les faits exprimés en langage naturel.
- Un résultat d’outil exige une preuve native finale d’éligibilité, un EOS
  complet, les portes d’attribution réussies et des activités cohérentes.
  Permission manquante, échec, annulation et issue inconnue ne deviennent pas
  des références réussies, même si un événement d’activité a été perdu.
- Arrière-plan, retrait du mode outils, nouvelle conversation et changement
  de modèle invalident les références concernées et les résultats tardifs.
- Le profil de recherche publique ne reçoit pas ce sidecar ni l’historique privé.

Le natif annonce Host2 et Host3. Un ancien bundle peut continuer en Host2 ;
le nouveau JS face à la build29 Host2 garde la demande isolée et n’envoie pas
de références. La forme v3 et le profil `device_context_v1` sont validés
ensemble ; un mélange de versions est refusé. La continuité nouvelle exige
donc un binaire contenant ce code natif.

Cette capsule ne conserve volontairement pas les handles natifs d’un document
d’un tour précédent. Une référence documentaire sans ID utilisable ni résultat
de recherche indexée exige une précision ; aucune API de sélection documentaire
supplémentaire n’est supposée disponible.

### Budget et fidélité après les outils

SYSTEM reste fixe pendant le tour. Chaque réponse d’outil de la vue modèle
reçoit un champ racine `_assist_run_budget`, calculé par le natif : appels
et écritures exécutés après ce reçu, budgets restants. Les compteurs d’un
ancien reçu ne changent pas quand un nouveau reçu est ajouté. Cette vue
temporaire ne modifie ni les reçus applicatifs ni l’historique canonique
`tool_calls/tool_responses`. Les plafonds restent quatre appels, une écriture
et 180 secondes ; le modèle ne peut pas élargir ces droits.

Une régression reproduite avec le modèle scripté perdait le résumé dans
`document_read → document_preview → réponse`. Le candidat conserve désormais
cette réponse seulement si une lecture avec texte concerne **le même document
dans ce run**. Un autre ID, une lecture de capacités, une extraction sans
texte ou une ancienne citation ne débloquent pas cette provenance. Un aperçu
seul reste un acquittement de fermeture, jamais une preuve du contenu.
Cela ne constitue pas un validateur sémantique universel des réponses du modèle.

Les replis déterministes après reçu restent limités aux opérations réellement
confirmées. Ils ne masquent ni erreur moteur, ni génération incomplète,
ni protocole invalide, ni issue inconnue. Aucun retry automatique d’écriture.

### Diagnostics utiles pour les prochains essais

Le moniteur conserve 35 codes constants : cinq indices de passage et sept
issues fermées, distinguant notamment EOS sans jeton accepté et frontière
d’outil. Ils sont enregistrés avant la validation de sortie, dans l’anneau
borné existant. Aucun prompt, texte, argument, logit, contenu de cache ou
identifiant privé supplémentaire n’est enregistré.

Le wrapper transmet le prompt entier et attend l’arrêt effectif du moteur.
Les preuves disponibles n’établissent pas un défaut de réutilisation KV.
Aucun reset aveugle entre les passages n’a été ajouté. La cause des EOS
immédiats historiques reste inconnue ; les nouveaux codes aideront à séparer
les frontières lors d’une future exécution réelle.

## Vérifications et coût du contexte

| Contrôle courant | Résultat | Limite |
| --- | --- | --- |
| `npm run check` | 1810 tests / 61 suites ; TypeScript, ESLint, Codegen, câblage et capacités passent | Une alerte ESLint préexistante ; modules natifs doublés |
| Grader du benchmark | 8 tests passent | Validation du grader, pas sélection par Gemma |
| Swift Mac strict, warnings-as-errors | 31 schémas, 148 contrôles de boucle et 139 contrôles Host2/3 passent | Modèle/exécuteurs scriptés ; aucun outil iPhone exécuté |
| Swift Tokenizers/Jinja réel | 11 cas aux IDs exactement égaux à la référence Python canonique | Aucun poids, CoreAI ou génération |
| Moniteur Swift sur Mac | Événements fermés, vie privée, bornes, arrêt et récupération après SIGKILL passent | Processus de test, pas crash d’Assist sur iPhone |
| CoreAI et câblage | Analyse syntaxique Swift et 15 contrôles de câblage passent | Pas de typage/lien complet contre le SDK27.1 |

Les anciens binaires, dépendances épinglées, lockfiles et fixtures du tokenizer
sont préservés. Les contrôles réutilisent les huit révisions locales du cache,
sans téléchargement ; l’exécution du tokenizer interdit le réseau.

Mesures sur les mêmes fixtures et le même tokenizer natif :

| Prompt | Jetons |
| --- | ---: |
| Ancienne planification, 31 déclarations | 3957 |
| Nouvelle planification, 31 déclarations, sans références | 5499 |
| Après un reçu et son budget natif | 5679 |
| Planification avec trois échanges synthétiques courts | 5769 |
| Après quatre reçus synthétiques et leurs budgets | 5903 |
| Fixture atteignant 8192 octets de références | 8540 |

Le prompt initial augmente de 1542 jetons dans cet exemple. C’est un coût
explicite pour fournir des informations auparavant absentes, pas une preuve
de gain de latence. La fixture à 8192 octets n’est pas un maximum de jetons
pour tout texte possible. Le budget natif après template continue de contrôler
le vrai total, sans troncature silencieuse. Poids complets, fenêtre32768 et
propriétaire unique du moteur restent inchangés.

Une première version des compteurs réécrivait SYSTEM à chaque passage :
seuls 435 jetons du préfixe restaient communs sans références, 549 avec les
références synthétiques. La version finale conserve **tout le prompt
précédent** aux trois transitions mesurées : 5499, 5679 et 5769 jetons
communs, comparés ID par ID. Les budgets ajoutés aux anciens reçus restent
identiques. Cela établit la stabilité du préfixe d’entrée, pas sa réutilisation
effective par CoreAI ni un gain de vitesse ou de mémoire sur l’iPhone.

## Évaluer le vrai Gemma sans confondre les preuves

Le [jeu versionné](evals/device-tools-context-v1.json) contient **58 cas**,
les 31 outils et 16 scénarios nécessitant des fixtures ou une préparation
du contexte v3.
Il reste `prepared_not_run_model`. Les demandes naturelles ne citent pas les
noms du protocole. Les oracles et données de service ne sont jamais joints
aux entrées du modèle ; les fixtures ne deviennent des résultats qu’au point
prévu comme de vrais `tool_responses`.

Commandes locales :

```sh
node scripts/evaluate-device-tools.mjs --export-inputs docs/evals/device-tools-context-v1.json
node scripts/evaluate-device-tools.mjs --grade docs/evals/device-tools-context-v1.json observations.json rapport.json
```

L’export fournit les demandes et leur contexte synthétique, **pas un prompt
natif déjà préparé**. Le runner doit utiliser le sérialiseur v3 de production
pour convertir/filtrer les paires, puis le vrai template. Un cas avec contexte
reste incomplet sans `referenceContextPrepared:true` dans ses observations.
L’horloge fixe du jeu appartient au runner de test, pas à l’app de production.

Le grader sépare premier outil, arguments critiques, séquence et budget.
Il conserve les cas absents comme `not_run`, une trajectoire de fixture non
achevée comme incomplète et les critères qualitatifs comme inconnus sans
revue indépendante. Il ne qualifie jamais lui-même l’application. Les
observations doivent déclarer leur couche : modèle scripté, sortie du vrai
modèle ou appareil physique. Un statut renseigné dans un fichier n’est pas
une preuve indépendante de l’état externe.

Pour la réception : exécuter les mêmes cas avant/après, au moins trois fois,
et recouper les valeurs finales avec les reçus. Mesurer la tâche entière et
ses phases ; la durée de la dernière passe seule ne mesure pas le parcours.
Reprendre aussi les fixtures8K/16K/proche32K en comptant déclarations et
résultats d’outils dans les vrais `promptTokens` natifs.

Avant livraison restent nécessaires : typage/lien/archive SDK cible, trois
produits signés, installation du candidat et essais physiques. La sélection
spontanée, la fidélité sémantique, les longues chaînes, la stabilité et les
succès OCR/scan/Face ID n’ont pas été requalifiés par cette intervention.

Preuves privées de cette tranche :
`/home/ales27pm/.local/share/assist/context-review-20261020/`.
