# Outils iOS conversationnels et OCR local

Implémentation source du 18 octobre 2026 dans le worktree isolé
`assist-gemma-calendar-readonly`. Le checkout principal et les poids du modèle
ne sont pas modifiés. Ce document prolonge la première tranche
[calendrier seule](gemma-calendar-agent.md), sans la remplacer.

## Utilisation prévue

Dans Conversation, activer **Outils iOS dans la conversation**, puis formuler
une demande nouvelle, par exemple « Lis le texte d’une photo » ou « Crée un
rappel pour demain à 8 h de prendre les mesures ».

L’option est désactivée par défaut. Elle exige le nouveau handshake natif et
reste désactivée sur native27 ou dans le navigateur. Une requête ordinaire,
option désactivée, ne reçoit aucun outil. Une transcription partielle ne
déclenche rien. Le tour vocal finalisé utilise la même boucle et la même
confirmation tactile que le texte; aucune confirmation vocale n’est acceptée.

Chaque accès proposé, y compris une lecture, affiche un aperçu natif. Le
modèle ne reçoit jamais le token de confirmation. Seul un toucher de l’utilisateur
fait accepter ce token à usage unique, valable 120 secondes, lié à l’outil,
ses arguments normalisés, sa destination et son opération. Un accès iOS accordé
ne vaut pas accord pour l’action : gérer la permission termine la tâche et
demande une nouvelle requête explicite. Rien ne reprend automatiquement.

## Registre fermé

| Outil | Fonction et limites |
| --- | --- |
| `contacts_search` | Recherche nominative, 1–5 contacts; champs et canaux minimisés. Aucune communication ni modification. |
| `calendar_list` | Période UTC explicite, au plus 31 jours et 5 événements; ordre/exhaustivité non garantis. |
| `calendar_create` | Titre/dates/notes/lieu validés; calendrier par défaut capturé avant aperçu, jamais choisi par un ID du modèle. |
| `reminders_list` | Période de 31 jours maximum, 5 résultats; incomplets par échéance, terminés par date d’achèvement. |
| `reminder_create` | Titre, échéance facultative et notes; liste par défaut figée avant confirmation. |
| `location_current` | Position ponctuelle, accès iOS existant, pas de suivi en arrière-plan. |
| `photo_select` | Sélecteur système limité à une photo, puis OCR Apple local. Pas d’accès à toute la photothèque. |
| `camera_capture` | Photo unique, permission caméra séparée, puis le même OCR local. Pas de vidéo. |
| `notification_schedule` | Date UTC future, au plus 365 jours; ID fourni par l’hôte. Programmation acceptée ≠ alerte présentée. |
| `biometrics_status` | Disponibilité et type, aucune donnée biométrique. |
| `biometrics_authenticate` | Dialogue iOS explicite; le résultat n’autorise aucune autre action. |
| `device_capabilities` | États des accès iOS connus, sans demande implicite de permission. |
| `native_boundary` | Limites des fonctions explicitement non exposées. Ce n’est pas un exécuteur arbitraire. |

Les commandes d’administration du moteur, les imports/réparations de modèle et
les diagnostics ne sont pas des outils du modèle. MCP, web, exécution de code,
édition/suppression de données et vision générale restent hors périmètre.

## OCR natif, pas vision du modèle

Le chemin agentique photo/caméra utilise
[`VNRecognizeTextRequest`](https://developer.apple.com/documentation/vision/vnrecognizetextrequest),
en reconnaissance précise avec correction linguistique. Les langues préférées
français canadien, français de France et anglais canadien sont filtrées selon
les langues réellement prises en charge par Vision; sinon la détection
automatique est demandée. Aucun modèle TTS/STT ni poids Gemma n’est changé.

La photo est redimensionnée à 2048 pixels maximum et le JPEG borné à 10 Mio.
Pour le sélecteur, les données et dimensions sont également bornées avant
décodage (4096 pixels par côté / 16 mégapixels maximum). L’image fournie par
UIKit pour la caméra est contrôlée avant le redimensionnement.
L’orientation est prise en compte. L’OCR ne crée pas de fichier d’attachement
destiné au modèle. Le panneau manuel PR2 garde son contrat d’attachement existant.

Gemma reçoit uniquement un objet de données minimisé :

```json
{
  "selected": true,
  "source": "photoLibrary",
  "byte_count": 12345,
  "vision_available": true,
  "ocr_status": "text",
  "ocr_text": "Texte extrait…",
  "ocr_lines": 1,
  "ocr_truncated": false,
  "ocr_reliable": false
}
```

`vision_available` désigne ici l’extracteur Apple, **pas** une capacité visuelle
de Gemma. Les statuts `no_text` et `failed` n’incluent pas `ocr_text`. Le texte est
plafonné à **40 lignes / 8192 octets UTF-8**, avec indicateur de troncature. La
reconnaissance peut se tromper : une réussite d’exécution ne prouve pas la qualité
du texte, sa disposition, un objet, un visage ou la compréhension de l’image.

Le texte OCR, comme un titre de calendrier ou un contact, reste non fiable : il
ne peut ajouter un outil, accorder une permission ou confirmer une mutation.
Les marqueurs réservés sont refusés avant insertion dans le prompt. Aucun
pixel, URI, chemin de fichier ou erreur brute de framework ne revient au modèle.

## Propriétaires et budgets

`AssistInferenceCoordinator` conserve l’unique moteur et son verrou à travers
les passes, confirmations et attentes natives. `AssistDeviceToolRun` borne la
tâche à **4 appels séquentiels / 1 écriture / 5 passes**, sans retry. La sortie
est limitée à 1024 jetons par passe; délai coopératif de 180 secondes incluant
les confirmations. Ce délai ne promet pas de préempter un appel OS synchrone.

`AssistDeviceToolAdapter` respecte le template Gemma canonique : chaque appel
et son résultat restent dans le même tour assistant. Ce n’est ni du JSON à
exécuter dans la prose ni un faux message utilisateur. Un appel incomplet,
tronqué, hors registre ou à paramètres supplémentaires n’atteint aucun outil.
Le template compatible reste une copie en mémoire liée au hash canonique;
ni tokenizer, ni fichier du modèle importé, ni template de chat ordinaire ne
sont réécrits.

`AssistToolTransactionCoordinator` contrôle permissions, aperçu, confirmation
et exécuteurs PR2. Les callbacks sont à règlement unique et les résultats
périmés ne reprennent pas le modèle. L’arrière-plan annule; les interactions
iOS possédées par le broker seules peuvent traverser une inactivité transitoire.
Les outils interactifs attendent le véritable `onDismiss` de la confirmation
React Native avant de consommer le token et présenter le sélecteur iOS.

## Preuve d’effet et confidentialité

Les écritures sont inscrites atomiquement dans un journal local **avant** leur
soumission. Celui-ci contient seulement ID, outil, état et horodatages, au plus
100 entrées, sans titres, notes, contacts, coordonnées ou texte OCR. Une
soumission trouvée sans résultat au redémarrage devient `outcome_unknown`.
Un journal indisponible bloque l’écriture.

Une opération incertaine affiche une vérification manuelle, jamais un retry
automatique. Le modèle ne reçoit pas une nouvelle occasion d’agir après cette
incertitude; l’hôte fournit un texte prudent. Le frontend empêche aussi une
prose contradictoire d’afficher un faux succès. Pas de promesse `exactly-once`,
pas de réconciliation automatique EventKit, pas d’annulation rétroactive d’un
effet confirmé quand la voix est interrompue.

Les cartes et résumés restent visibles pendant la session mais sont exclus du
contexte réutilisé par le chat ordinaire. Ni plan, ni résultat brut, ni syntaxe
d’outil, ni token de confirmation ne passe dans le flux progressif public/TTS.
Seule la réponse finale validée peut être parlée.

## Livraison et réception

Le bridge ajoute `getDeviceToolCapabilities`, `generateWithTools`,
`confirmToolAction`, `getToolOperations` et `onToolActivity {json}`. L’API
calendrier précédente reste compatible. La source prépare **native28** : ces
changements Swift/bridge ne sont pas une OTA pour native27. Pas de commit,
push, EAS, signature, publication ou installation effectué par ce travail.

Les tests de contrats et exécuteurs simulés ne qualifient pas le choix d’outil
par les poids Gemma, les permissions/pickers réels, la qualité de l’OCR ou la
latence/mémoire/thermique sur iPhone. Le SDK26 disponible permet les contrôles
Swift ciblés, pas une compilation complète de l’app Core AI SDK27.

Avant réception, tester sur l’iPhone réellement installé : demande sans outil,
permission refusée, confirmation expirée/double tap, retour arrière-plan,
perte de reçu après écriture, interruption de voix après reçu, photo tournée,
photo sans texte, document long/tronqué et instruction hostile imprimée dans
l’image. Vérifier que seul le texte extrait est utilisé et qu’aucune mutation
n’en découle sans son propre aperçu et toucher explicite.

L’aperçu navigateur `/device-tool-states` utilise les vrais composants dans les
trois thèmes, avec **fixtures fictives et bridge absent**. Il ne prouve ni OCR
ni permissions ni comportement du microphone sur iOS.

## Vérifications de cette extension

- `npm run check` : **1252 tests / 39 suites**, TypeScript, ESLint sans
  avertissement et Codegen iOS réussis. Les API générées incluent les quatre
  méthodes et le nouvel événement. Les générés restent hors du diff suivi.
- Contrats Swift 6 stricts, avec exécuteurs/modèle synthétiques : **38 contrôles
  de boucle** et **43 contrôles de broker/journal/payload**, dont les treize
  dispatches, échéances natives réelles et reçus d’écriture partiels rejetés.
- Treize schémas/parser natifs et golden indépendant Python/Jinja2 canonique :
  quatre paires appel/résultat chronologiques vérifiées. Cela ne prouve pas la
  parité complète du nouveau catalogue avec le tokenizer Swift-Jinja réel.
- Typecheck iPhoneOS SDK26 ciblé de la passerelle, des contrats et du broker,
  Swift6/concurrence stricte/avertissements bloquants réussi; sources Foundation
  de boucle également vérifiées. CoreAI SDK27 : contrôle syntaxique uniquement,
  pas de compilation complète de l’app.
- Gardes de source appareil, raccordement agent et voix exécutées séparément;
  elles ne sont pas des appels de frameworks iOS ni des essais de précision OCR.
- Aperçu production : **63 cas** (7 états × 3 thèmes × 320/390/768 px) sans
  débordement horizontal. Le focus entre sur le titre de confirmation; les
  valeurs normalisées sont lisibles. Aucune action native exécutée par le preview.

Les tests ont guidé notamment la correction de la traduction des dates
`start_iso/end_iso/due_iso` vers les clés EventKit existantes, des révisions
d’activité, des retours de sélecteur périmés et de l’ordre fermeture modale →
confirmation native. Ces corrections sont testées dans la source, mais leur
fonctionnement matériel demande encore la réception iPhone décrite plus haut.
