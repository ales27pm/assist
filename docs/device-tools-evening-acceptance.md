# Assist — essais naturels du soir

Base préparée le 20 octobre 2026 : **12 dialogues, 37 tours, 19 outils ciblés**. Le [complément séparé](evals/device-tools-natural-dialogues-extension-v1.json) ajoute **4 dialogues, 14 tours et les 12 outils manquants** : ensemble, **16 dialogues, 51 tours, 31 branches outil admissibles préparées**. La réponse directe reste recevable pour une limite déjà connue; dans ce cas, l’outil facultatif demeure non exercé. Ce feuillet n’est pas un résultat de test. Le [jeu machine](evals/device-tools-natural-dialogues-v1.json) garde les oracles séparés et réutilise le contrat de production du [corpus de 59 cas](evals/device-tools-context-v1.json). Aucun modèle, iPhone, outil réel, build ou OTA lancé pour préparer ces dialogues.

Implémentation source et frontières de preuve : [relevé ToT](thought-tree-implementation-2026-10-20.md).

## Conditions et relevé

- Noter version/build/runtime installés, modèle complet, contexte 32K, mode vocal, heureUTC et fuseau réels. Une exécution de l’ancienne build 29 est un baseline séparé : elle ne qualifie ni les nouvelles références ni le nouveau contrôleur ToT préparé en sources. Aucun nouveau binaire n’est créé automatiquement.
- Commencer une conversation neuve à chaque dialogue. À l’intérieur, garder le fil et attendre la fin réelle du tour. Ne pas poursuivre un scénario de référence si le tour précédent n’a pas abouti ; noter la frontière et reprendre le dialogue depuis son début après résolution.
- Dicter uniquement les phrases du feuillet ci-dessous. Ne dicter ni attentes, nom de protocole, identifiant, coordonnées, réponse fictive d’assistant ou reçu. Les lieux sont publics; aucun accès implicite à la position.
- Toute lecture/action native conserve son aperçu, sa permission et son accord tactile propres. Vérifier les arguments avant l’accord. Une annulation, un refus ou une issue inconnue ne relance rien automatiquement.
- Les heures machine du jeu sont fixes : 20 octobre 2026 à 19 h à Toronto. Sur iPhone, «demain» dépend du vrai jour/fuseau. Résoudre la date avant l’essai et la conserver dans le relevé; ne pas changer l’horloge du téléphone. Un passage après minuit ou autre jour exige un oracle de session rebâti **avant** le test ou une revue humaine distincte, pas une erreur artificielle contre l’ancienne date fixe.

Le contrôle humain ne nécessite aucun JSON Host ni accès développeur. Pour chaque tour, relever phrase, aperçu/arguments, accord ou refus, reçu/carte, texte final et effet vérifié indépendamment si accessible. Une capture est utile si disponible, jamais requise pour inventer une preuve manquante. Séparer réussite native, finalisation et fidélité; conserver chaque échec.

Pour les temps, noter début de demande→état final et les attentes humaines/natives séparées. Le premier texte visible peut donner une approximation du TTFT, pas le spinner. Les comptes de jetons/passes, durées et issues viennent uniquement des diagnostics réellement disponibles ; sinon inscrire « inconnu ». Comparer mêmes demandes, modèle, appareil et conditions. Aucun seuil de latence réputé atteint. Les fixtures synthétiques du contrôleur peuvent vérifier les branches et leur évaluation sans effet. Le moniteur de production conserve seulement comptes, durées et issues fermées ; aucun raisonnement privé, branche, intention ni score n’est demandé à l’utilisateur ou exporté. Une éventuelle `planningTrace` synthétique reste séparée de `calls`, qui contient seulement la trajectoire soumise. Aucun effet pendant l’exploration. Le nom ToT dans une consigne n’est pas sa preuve.

## Préparation et nettoyage bornés

| Dialogue | Préparation et limite | Nettoyage/preuve attendue |
| --- | --- | --- |
|01–02|Conversation neuve; aucun accès.|Aucun objet ni permission acquis.|
|03|Une fixture calendrier nommée exactement Atelier Orion du soir, avec aperçu date/heure.|Supprimer seulement cet événement de test dans Calendrier, puis relire absence.|
|04|Une fixture Rappels nommée exactement Préparer le dossier Orion du soir.|Supprimer seulement ce rappel et vérifier absence.|
|05|Examiner la proposition de notification, puis **Annuler avant exécution**.|Aucune notification programmée; aucune présentation qualifiée.|
|06|Un seul minuteur Assist de test;60 puis 90 minutes évitent d’attendre une sonnerie.|Arrêter puis supprimer uniquement cette cible; inventaire relu. Arrêt de sonnerie non qualifié.|
|07|Petite phrase synthétique; téléchargement interdit.|Si une langue manque, garder indisponible, ne pas inventer une traduction native.|
|08|Recherches Apple de lieux publics; confirmer chaque transfert.|Vérifier résolution des deux lieux et liens exacts des coordonnées avant trajet/météo. Aucun guidage.|
|09|Importer la fixture texte, indexer explicitement un jour sous Dossier de démonstration Orion.|Retirer ce seul document de l’index puis de l’inbox. Aucun fichier préexistant modifié.|
|10|Observer disponibilité réelle. Indisponibilité forcée uniquement par owner contrôlé hors iPhone.|Ne pas désinstaller de langue pour fabriquer la panne; si prête, branche indisponible = non exécutée.|
|11|Ouvrir le sélecteur puis choisir Annuler sans sélectionner de photo.|Pas d’OCR positif, aucune nouvelle capture ni parole spontanée.|
|12|Issue inconnue simulée seulement par owner contrôlé.|Ne pas tuer l’app/déconnecter l’appareil pour la produire. Sur iPhone, observer seulement si elle survient naturellement; lire avant toute réconciliation, jamais recréer aveuglément.|

Fixture documentaire prête : [texte synthétique Orion](/home/ales27pm/.local/share/assist/natural-dialogues-20261020/Dossier-Orion-soir.txt), quatre lignes sans données personnelles. L’importeur existant accepte le texte UTF-8. L’ID réel vient de l’app et reste hors des phrases à dicter. Le contenu de contrôle comprend`Total : 42 CAD`; l’aperçu ne constitue pas une nouvelle extraction. Ce contrôle ne teste ni scanner, ni OCR, ni PDF protégé.

Si une fixture ne peut pas être nettoyée de façon ciblée, rester à l’aperçu puis annuler. Aucun nettoyage global, aucune modification d’un objet personnel.

## Feuillet utilisateur

Lire les phrases de chaque dialogue dans l’ordre. Les titres et numéros servent au relevé, pas au modèle.

### dialogue01 — Conversation et explication sans accès

> Salut ! J’ai besoin d’y voir un peu plus clair aujourd’hui.

> Explique-moi en deux phrases à quoi sert un rappel.

> Merci, on s’arrête là pour le moment.

Nouvelle conversation avant le dialogue suivant.

### dialogue02 — Intention indirecte et changement de but

> J’ai peur d’oublier ce dossier avec tout ce que j’ai à faire.

> Je voulais juste des idées pour m’organiser, pas ajouter quoi que ce soit.

> Alors donne-moi deux idées simples.

Nouvelle conversation avant le dialogue suivant.

### dialogue03 — Détails retenus puis événement et lecture

> Demain, je prévois un atelier intitulé « Atelier Orion du soir », de dix heures à dix heures cinq. Pour l’instant, je te donne seulement les détails.

> Ajoute-le maintenant à mon calendrier.

> Vérifie qu’il apparaît bien à ce créneau.

Nouvelle conversation avant le dialogue suivant.

### dialogue04 — Rappel explicite puis vérification

> Ajoute dans Rappels « Préparer le dossier Orion du soir », pour demain à dix-huit heures.

> Regarde s’il figure bien parmi mes rappels de demain.

> Changeons de sujet : pourquoi les feuilles deviennent-elles jaunes en automne ?

Nouvelle conversation avant le dialogue suivant.

### dialogue05 — Notification proposée puis refusée

> Prépare une notification intitulée « Essai Orion du soir », pour demain à dix heures, avec le texte « Vérifier le dossier Orion ».

> Finalement, n’en programme aucune. On laisse tomber.

Nouvelle conversation avant le dialogue suivant.

### dialogue06 — Minuteur nommé, correction, arrêt, suppression

> Mets un minuteur de soixante minutes appelé « Infusion Orion du soir ».

> Finalement, fais quatre-vingt-dix minutes pour ce même minuteur.

> Arrête-le maintenant.

> Supprime ce minuteur de test.

Nouvelle conversation avant le dialogue suivant.

### dialogue07 — Traduction naturelle et correction de langue

> Traduis en anglais : « Bonjour. Le dossier est prêt. »

> Finalement, en espagnol pour la même phrase.

> Changeons de sujet : explique simplement ce qu’est une langue romane.

Nouvelle conversation avant le dialogue suivant.

### dialogue08 — Météo urbaine puis trajet et correction

> Quelle météo fait-il maintenant au centre-ville de Québec, au Québec ? En degrés Celsius, seulement les conditions actuelles.

> Et combien de temps pour y aller ?

> À pied, de l’Hôtel de ville de Québec au Château Frontenac.

> Finalement, en voiture entre ces deux endroits.

Nouvelle conversation avant le dialogue suivant.

### dialogue09 — Référence documentaire absente, recherche, lecture, aperçu

> Tu peux résumer celui-là ?

> Je parle du « Dossier de démonstration Orion » qu’on a préparé. Retrouve-le et résume-le.

> Maintenant, ouvre juste son aperçu.

Nouvelle conversation avant le dialogue suivant.

### dialogue10 — Disponibilité locale puis refus de téléchargement

> Est-ce que la traduction du français vers le japonais est prête sur cet appareil ?

> Essaie de traduire en japonais « Bonjour. Le dossier est prêt. », sans rien télécharger.

> Alors laisse tomber, je passerai par une autre méthode.

Nouvelle conversation avant le dialogue suivant.

### dialogue11 — Sélecteur photo puis annulation sans relance

> J’aimerais lire le texte d’une photo que je vais choisir.

> Je n’en choisis finalement aucune, on annule.

> Explique-moi seulement comment tu lis le texte d’une image.

Nouvelle conversation avant le dialogue suivant.

### dialogue12 — Issue inconnue : vérité, clarification et lecture sans double création

> Ajoute un événement « Vérification Orion du soir », demain de dix-sept heures à dix-sept heures cinq.

> Donc, c’est fait ?

> Ne le recrée surtout pas. Cherche l’événement « Vérification Orion du soir » demain entre dix-sept heures et dix-sept heures cinq pour voir s’il existe.

Nouvelle conversation avant le dialogue suivant.

## Complément — douze outils supplémentaires

Le corpus original12/37 reste inchangé. Les quatre dialogues ci-dessous ne contiennent aucun identifiant technique ni coordonnées à dicter. Les résultats réels sont indispensables pour lier les cibles. Une permission refusée, une authentification indisponible, un composeur non configuré ou une annulation restent des issues distinctes; ne pas prétendre avoir testé leur branche positive.

| Dialogue | Préparation et limite | Nettoyage/preuve attendue |
| --- | --- | --- |
|13|Lire les permissions actuelles; vérifier le type biométrique, puis demander explicitement l’authentification. Une position ponctuelle seulement au dernier tour.|Aucun secret biométrique/code enregistré; aucun changement automatique de permission. Garder la position réelle privée, sans coordonnées dans le rapport public.|
|14|Deux feuilles synthétiques décrites dans le complément. Photographier une seule page, puis scanner/Enregistrer les deux pages. Indexation distincte un jour, titre unique Carnet de démonstration Orion.|Le scan fournit l’ID réel pour indexer **dans le même tour**. Chaque tour suivant recherche à nouveau le titre, puis exporte ou désindexe. Supprimer uniquement cette entrée d’inbox et Carnet-Orion-demo.pdf après retrait de l’index.|
|15|Fiche Contacts synthétique Camille Démo Orion avec une seule adresse example.invalid. Ambiguïté initiale : question de précision ou recherche suivie d’une précision admises.|Le composeur utilise la fiche relue dans ce tour, jamais une adresse devinée. **Annuler/Supprimer le brouillon; ne jamais toucher Envoyer.** Mail indisponible = branche indisponible, sans ajout de compte ni message inventé.|
|16|Aucun réglage à changer, aucune app à ouvrir.|Une explication directe fidèle peut suffire. Si aucun appel natif, native_boundary reste non exercé malgré une réponse correcte.|

Les deux feuilles de démonstration peuvent être écrites ou imprimées avec le texte public synthétique des champs `paper_orion_extension.page1` et `page2` du complément. Aucun fichier ni scanner réel n’a été créé/ouvert pour préparer le corpus. Après un refus ou une annulation de scan/indexation, ne pas poursuivre un export avec un identifiant supposé. Reprendre seulement après avoir rétabli la fixture avec un nouvel accord explicite.

### dialogue13 — Autorisations, biométrie et position explicitement demandées

> Quelles autorisations cette application possède-t-elle déjà sur ce téléphone ? Ne change rien.

> Et quelle biométrie est disponible sur cet iPhone, sans vérifier mon identité ?

> Fais maintenant une vérification biométrique locale pour ce test. Le motif doit être « Vérifier le test Orion ».

> Maintenant, donne-moi une position ponctuelle de ce téléphone, sans suivi.

Nouvelle conversation avant le dialogue suivant.

### dialogue14 — Caméra, scan puis cycle documentaire avec cibles du tour

> Prends une seule photo de ma feuille de démonstration et lis le texte qui y figure. Je prendrai la photo moi-même.

> Numérise maintenant les deux pages de ce document, puis rends-le retrouvable dans Assist pendant un jour sous le titre « Carnet de démonstration Orion ».

> Retrouve le « Carnet de démonstration Orion » et exporte-le en PDF sous le nom « Carnet-Orion-demo.pdf ». Je choisirai le dossier.

> Retire le « Carnet de démonstration Orion » de la recherche d’Assist, mais garde le document lui-même.

Nouvelle conversation avant le dialogue suivant.

### dialogue15 — Contact ambigu puis composeur relu et annulé

> J’aimerais écrire à Camille, mais je ne me rappelle plus de son nom complet.

> C’est Camille Démo Orion. Retrouve sa fiche.

> Retrouve sa fiche et prépare-lui un courriel, objet « Essai Orion », texte « Bonjour, ceci est un brouillon de démonstration. ». Je veux le relire, sans l’envoyer.

> Laisse tomber ce courriel. Explique-moi seulement ce que tu ferais si la fiche n’avait pas d’adresse.

Nouvelle conversation avant le dialogue suivant.

### dialogue16 — Limite système vérifiée ou expliquée sans action

> Vérifie si Assist peut changer le Wi-Fi dans les réglages de cet iPhone. Ne change rien.

> Alors explique-moi comment le changer moi-même dans les réglages, sans ouvrir quoi que ce soit.

Nouvelle conversation avant le dialogue suivant.

## Reproduction machine séparée

Le feuillet utilisateur s’exporte toujours sans réponses ni oracles :

```sh
node scripts/evaluate-device-tools.mjs --rehearsal-sheet docs/evals/device-tools-natural-dialogues-v1.json
node scripts/evaluate-device-tools.mjs --rehearsal-sheet docs/evals/device-tools-natural-dialogues-extension-v1.json
```

Pour chaque tour naturel, y compris le premier, la préparation machine exige la demande réellement admise `userText`, la capsule réellement admise `referenceContext` et son `referenceContextEpoch`. Le premier tour commence avec une capsule vide; sa demande actuelle peut être préparée avec `completed:false`, sans prétendre avoir déjà obtenu une réponse. Pour les tours suivants, il faut aussi les observations **réelles** des tours précédents : fin effective, texte final et éligibilité enregistrée. Le helper vérifie chaque paire contre ces textes enregistrés, dans le même epoch, en appliquant le filtre de production. Il ne reconstruit jamais un ancien utilisateur depuis le prompt nominal du jeu. Un arrêt/refus inéligible, même avant le premier appel, retire l’ancien but. Une réinitialisation ne réintroduit aucune paire d’un ancien epoch. Observation ou snapshot manquant = préparation inconnue, sans réponse d’assistant inventée.

Les trajectoires machine conservent `calls` et, pour les scénarios propriétaires, `fixtureTrace:{owner,steps}`. Chaque étape contient son `callIndex` et soit le `resultJSON` exact, son `resultSHA256` sur les octets UTF-8 et `productionResultValidated:true`, soit un `ownerError:{domain,code}` fermé, son `errorSHA256` et `productionErrorValidated:true`. Le JSON est borné à 24 Kio, les clés doubles sont refusées. Le hash d’une erreur fermée utilise le JSON canonique avec les clés `code`, puis `domain`. Aucun message interne d’erreur, chemin privé ou secret n’est nécessaire. Ces champs déclarent la validation par le propriétaire; leur hash lie les pièces mais n’authentifie pas l’appareil ou l’auteur.

Le grader compare séparément les issues attendues : une photo choisie avec OCR positif ne prouve pas une annulation; un reçu de réussite ne prouve pas `outcome_unknown`; une traduction installée ne couvre pas la branche indisponible. Les cibles d’actions doivent provenir du résultat réel du tour, avec un titre unique quand l’inventaire contient plusieurs éléments. Les tableaux non vides attendus exigent des éléments correspondants distincts sans imposer l’ordre ou une pagination arbitraire; `[]` signifie explicitement vide. Les coordonnées, la signification d’un lieu et la fidélité d’un résumé restent des axes de revue, sans déduction automatique à partir d’un hash.

La revue sémantique doit inclure `caseId`, `criteriaSHA256` et `subjectSHA256` générés par les helpers exportés `reviewCriteriaSHA256(test)` et `reviewSubjectSHA256(observation)`. Elle porte sur la demande, la capsule, les appels, les résultats et le texte final. Modifier un reçu ou un critère invalide l’ancienne revue. Un hash opaque ou un booléen de succès seul ne suffit plus. Une trajectoire interrompue dont le préfixe est encore valide reste incomplète; un outil hors séquence ou une cible déjà fausse échoue même si elle est interrompue. Aucun de ces contrôles ne transforme les tests scriptés en observations du modèle ni en qualification iPhone.

```sh
node scripts/evaluate-device-tools.mjs --native-inputs docs/evals/device-tools-natural-dialogues-v1.json observations.json > inputs.jsonl
# Exécutable Swift compilé comme scripts/check-device-tools.sh :
check-device-tools --prepare-evaluation inputs.jsonl > native-validation.json
node scripts/evaluate-device-tools.mjs --grade docs/evals/device-tools-natural-dialogues-v1.json observations.json rapport.json native-validation.json
```

Une revue humaine du soir est une preuve distincte; l’absence de JSON natif ne rend pas son observation physique fausse. Elle laisse simplement les contrôles machine correspondants inconnus. Les alternatives fermées autorisent une recherche unique ou deux recherches avant trajet, et disponibilité puis vraie traduction; une demande vague n’autorise aucune mutation. Les liens entre IDs/coordonnées et résultats doivent encore être recoupés dans les reçus réels, pas déduits d’un nom d’outil correct.

Le corpus reste `prepared_not_run_model`. Une exécution réelle crée son artefact d’observations distinct, avec version/provenance et réussites, échecs, interruptions ou inconnus. Les mesures ToT éventuelles restent séparées du nombre d’appels natifs et ne prouvent encore aucun gain de qualité/latence sur iPhone.
