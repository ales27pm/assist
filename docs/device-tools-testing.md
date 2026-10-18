# Essais manuels des outils du PR 2

## Périmètre

Le pont iOS du PR 2 est déjà compilé dans TestFlight 27. Le panneau ajouté sous
**Réglages → Outils de l’appareil** appelle ce pont uniquement après une action
explicite. Il ne connecte pas encore les outils à Gemma et n’ajoute ni dépendance,
ni méthode native, ni nouvelle déclaration de permission, ni changement de runtime.

Repère visible : **Tests manuels du PR 2 · panneau v1**. Sa présence sur l’iPhone
doit être constatée après livraison ; une réussite locale ne l’active pas sur
la build déjà installée.

## Parcours sur iPhone après livraison

Garder le mode vocal fermé et attendre la fin de toute opération du modèle.
Ouvrir le panneau puis utiliser **Vérifier les autorisations** : cette commande
ne doit afficher aucune demande d’accès. Ouvrir ensuite une seule section à la
fois et accorder seulement les accès que l’on souhaite tester. Un refus n’est
pas un échec système ; il se modifie ensuite dans les réglages iOS.

| Section | Essai borné | Observation attendue |
| --- | --- | --- |
| Contacts | Demander l’accès, saisir un nom connu, rechercher | Zéro à cinq correspondances ; aucune coordonnée affichée ; une recherche vide est désactivée |
| Calendrier | Lire les prochaines 24 h | Zéro à cinq événements ; aucun titre privé affiché |
| Rappels | Lire les prochaines 24 h | Zéro à cinq rappels non terminés ayant une échéance dans cette période ; les rappels sans échéance ne font pas partie de cet essai |
| Position | Obtenir une mesure au premier plan | Une réponse de position ; pas de suivi continu ni de coordonnées affichées ; iOS peut demander la permission |
| Photos et caméra | Choisir ou prendre une seule image | Sélecteur/caméra système puis taille de l’image ; aucun envoi à Gemma ; annuler doit rester une annulation |
| Notifications | Préparer puis confirmer une notification | « Test Assist », message fixe, délai de 60 s ; « programmée » n’est pas une preuve d’affichage ou de réception |
| Biométrie | Vérifier la disponibilité, puis lancer l’authentification | Disponible ≠ authentifié ; un succès demande Face ID/Touch ID, sans code de secours proposé par Assist |

### Créations réelles, facultatives

L’événement et le rappel sont nommés **Test Assist**. La confirmation de
l’événement fixe un début cinq minutes après sa préparation et une durée de
trente minutes ; celle du rappel fixe une échéance dix minutes après sa
préparation. Le contenu et les dates présentés sont ceux envoyés au natif,
pas des valeurs recalculées après confirmation.

Ces objets utilisent le calendrier/la liste par défaut et peuvent donc être
synchronisés par iOS. Les supprimer manuellement dans Calendrier ou Rappels
après vérification. Assist n’expose pas leur suppression dans ce lot.

La notification utilise un identifiant de test fixe pour remplacer un essai
encore en attente. Son délai court après la confirmation et l’autorisation.
Sa présentation dépend d’iOS ; observer aussi l’iPhone hors de l’app après le
délai. Aucun envoi à une autre personne n’est effectué par ces essais.

Ne pas répéter une création lorsque son résultat est incertain : vérifier
d’abord l’app concernée. Fermer le panneau ou mettre l’app en arrière-plan
n’annule pas une création déjà acceptée par le natif. Les confirmations non
utilisées sont invalidées après changement d’état ou fermeture ; les actions
ne sont jamais rejouées automatiquement.

## Données et limites

Les résultats sont des résumés en mémoire locale, pas un rapport exportable.
Une lecture en cours devient périmée après un passage en arrière-plan et ne
réaffiche pas son ancien résultat. Un reçu statique de création déjà acceptée
reste distinct : il évite de répéter une écriture dont le natif a confirmé l’effet.
Les coordonnées, noms de contacts, titres privés et chemins d’images ne sont
pas rendus ni transmis au modèle. La sélection/capture peut créer un fichier
temporaire privé via le pont existant ; fermer ce panneau ne prétend pas
supprimer ce fichier. Aucun changement de conservation native n’est introduit.

Les tests RN simulent uniquement la frontière NativeAssist. L’aperçu navigateur
la laisse indisponible. Ni l’un ni l’autre ne valide les permissions, le rendu
des écrans système, la biométrie ou les écritures réelles sur iPhone.

## Compatibilité OTA de TestFlight 27

L’IPA conservée du build EAS `2a6f86ae-e99c-4e45-9bcf-9588127d673d`
contient Expo Updates activé, runtime **1.0.0-native27**, canal **testflight**.
Le panneau ne dépend que des méthodes NativeAssist déjà embarquées. Il est
donc structurellement compatible avec une OTA JavaScript de ce runtime.

Avant une publication séparément autorisée : vérifier la révision exacte,
les tests et l’export iOS local, puis confirmer qu’aucun Swift, Obj-C, pod,
entitlement, Info.plist, contrat TurboModule, configuration ou dépendance
native n’a changé. Conserver le runtime et publier seulement sur le canal
exact. Un futur changement natif impose un nouveau runtime/binaire.

La vérification de compatibilité ne vaut ni publication ni téléchargement ni
activation sur appareil. Le délai d’attente de lancement embarqué est nul :
ne pas déduire qu’un premier lancement a déjà appliqué une OTA. Après livraison,
vérifier le marqueur du panneau sur l’iPhone et son parcours réel.

**À la fin de la préparation locale, aucune OTA ni nouvelle build EAS n’avait été lancée.**

## Vérifications locales du 18 octobre 2026

- `cd mobile && npm run check` : TypeScript, ESLint sans avertissement,
  **793 tests / 33 suites**, puis Codegen iOS réussis. Les deux nouvelles suites
  comprennent 35 cas d’outils ; la frontière native est simulée, pas l’iPhone.
- `npm run preview:build` : réussi, avec les avertissements de directives
  `use client` des dépendances RN Web. Navigation, focus du titre et retour au
  contrôle vérifiés dans un aperçu de production à 320/390 px ; aucun
  débordement horizontal observé. Les trois thèmes ont été parcourus à 320 px,
  et les 18 commandes natives restent désactivées dans le navigateur.
- `expo export --platform ios --max-workers 2` : bundle Hermes produit localement,
  sans commande EAS et sans publication. SHA-256 du bundle :
  `1f208088a8c1e0086ae8718140a06e9679c84febfbee13fc018fbae85a23849a`.
- Formatage et `git diff --check` réussis. Aucun écart natif, configuration,
  dépendance ou contrat TurboModule par rapport à la source livrée du build 27
  (`c3da00d41cd210ce71a249fdc4bb2d85c697332e`).

Les tests ont d’abord exposé puis couvert des réponses malformées de statut et
biométrie, un reçu photo incomplet/incohérent et une lecture tardive après
arrière-plan. Les confirmations à usage unique, les résultats d’écriture
incertains, la conservation d’un reçu de création accepté après arrière-plan
et l’absence de relance automatique sont également couverts.

Ces contrôles ne prouvent pas le téléchargement ou l’activation OTA, ni les
permissions et effets réels sur appareil. Aucun commit, push, publication ou
nouveau build n’était inclus dans cette préparation.

## Publication autorisée

L’utilisateur autorise ensuite le commit/push et la publication d’une OTA iOS
sur le canal `testflight`, compatible avec la build 27, sans nouvelle build EAS.
Les résultats de publication sont ajoutés après observation ; cette
autorisation seule ne démontre ni publication ni activation sur appareil.
