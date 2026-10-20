# Workspace Documents / Ubuntu — état du 19 octobre 2026

Implémentation dans le worktree `feature/private-web-research`, pas livraison
TestFlight. Le checkout principal et ses modifications indépendantes sont préservés.
Aucune build EAS payante, publication OTA ou mutation du compte Apple n’a été lancée.
La [tranche native29 courante](native29-native-bundle-2026-10-19.md) rassemble les
preuves après les ajouts natifs; les nombres de la dernière section restent les
preuves historiques du workspace initial.

## Fondations réalisées

- Appairage UIKit à une origine HTTPS exacte, vérification des capacités avant
  stockage Keychain `WhenUnlockedThisDeviceOnly`, non synchronisé. La clé ne
  passe ni par React Native, Gemma, l’App Group, les URL ou les logs.
- Transport éphémère typé, TLS standard, aucune redirection de la passerelle,
  limites pendant la réception, IDs de requête/configuration et invalidation
  avant annulation. Les cookies/credentials du navigateur ne sont pas réutilisés.
- Workspace dans Réglages : saisie d’une recherche explicite, ouverture des
  résultats par ID natif dans `SFSafariViewController`, état de configuration
  non secret. Les méthodes absentes sur native28 désactivent ce parcours.
- Trois vrais targets Xcode : Assist, AssistShare et AssistWidget. Les deux
  extensions sont embarquées, avec leurs entitlements, manifestes de confidentialité
  et App Group `group.org.27pm.assist`. Elles n’embarquent pas React/Gemma/TTS.
- Share Extension Save/Cancel pour une sélection bornée. Inbox coordonnée entre
  processus, fichiers protégés, quotas, expiration, consommation idempotente,
  contrôle des liens symboliques et fermeture des admissions annulées. Widget
  de lancement limité au nombre d’éléments en attente et à l’ouverture de
  `assist://inbox`, sans contenu documentaire ni exécution de modèle/action.
  Le bundle contient désormais aussi la Live Activity AlarmKit de décompte;
  ses libellés verrouillés/Dynamic Island restent génériques (« Minuteur Assist »),
  le décompte est annoté sensible et la présentation physique reste à qualifier.
- Import de fichiers sélectionnés, texte UTF-8, extraction de texte PDF et OCR
  Vision d’images bornés; aperçu explicite et export `.txt` vers la destination
  choisie par l’utilisateur. Pas d’accès général à Fichiers/iCloud. Un PDF importé
  sans couche texte n’est pas annoncé comme OCRisé; les scans VisionKit ont
  leur parcours OCR distinct, et l’OCR n’est pas de la vision générale.
- Checkpoints de recherche/document protégés et bornés, sans requête ni contenu
  conservé; après interruption/relance, reprise explicite seulement. Ils ne
  contiennent aucun exécuteur. Un résultat incertain ne se relance pas.
  `inactive` ferme aussi les anciens callbacks et attend l’annulation native;
  une tâche orpheline peut être interrompue, une tâche en pause abandonnée avec
  sa révision exacte. Cet abandon ne rejoue aucun travail et ne masque jamais
  un `outcome_unknown`.
- Lecture prudente des reçus d’outils inconnus après rollback : ils restent
  visibles comme opérations à vérifier, sans appel, faux succès ou retry implicite.
- Runtime candidat cohérent `1.0.0-native29`, build number source 29 pour les
  trois targets. Ce nouveau natif ne peut pas être ajouté à native28 par OTA.
- Packaging de symboles adapté aux trois produits : identités Info.plist et UUID
  des exécutables/dSYM concordants, archive incomplète refusée. Le schéma 1 sans
  extensions reste compatible avec les anciennes builds. Aucun exécutable ou
  poids de modèle n’est ajouté à l’archive de symboles.

## Lot natif courant : catalogue fermé de 31 outils

Le Tool Host v2 annonce `device-v3-31` dans le profil `device_v1` : les 13 outils
historiques, les 3 outils cartes/météo et 15 additions. La frontière historique
`device-v2-16` est dépassée dans ces sources. Le pont v1 demeure limité aux 13
outils historiques; aucune OTA ne crée les nouvelles API dans native28.
Les opérations sont proposées par Gemma, validées puis confirmées par toucher
avant leur exécution; l’annonce d’une capacité compilée ne vaut ni autorisation
système ni consentement. Le moteur et son admission restent uniques.

- `maps_search`, `maps_directions`, `weather_forecast` sont raccordés à Gemma,
  avec fournisseur et lieux exacts dans l’aperçu. Attribution météo officielle
  et porte prose/TTS restent obligatoires; signature et appareil non qualifiés.
- `alarm_list/create/update/stop/cancel` exécutent réellement AlarmKit pour les
  seuls IDs d’Assist. Propriété et opération sont persistées avant effet, et
  l’autorisation n’est demandée qu’après une action confirmée. Les minuteurs
  utilisent `AlarmConfiguration.timer` avec la Live Activity du Widget.
  Une modification annule puis remplace la programmation sous le même ID.
  Un ACK perdu reste `outcome_unknown`, sans répétition automatique; liste et
  annulation explicites servent à réconcilier l’état présent, sans prétendre
  prouver qu’une alerte a sonné. Les déclarations plist sont présentes.
- `translation_languages` et `text_translate` utilisent les disponibilités Apple,
  Natural Language et Translation locale. Modèle installé et paire simplement
  prise en charge restent distincts. Aucun téléchargement implicite : demande
  explicite, accord et parcours Apple au premier plan, sinon refus sûr.
  Annulation/arrière-plan invalident les résultats tardifs; aucun fallback cloud.
- Scanner VisionKit multipage (huit pages maximum), lecture/OCR Vision et PDFKit,
  création/export PDF et aperçu Quick Look opèrent sur des documents sélectionnés
  de l’inbox Assist. PDF protégé, absence de texte et dépassements restent explicites;
  un OCR ne transforme pas Gemma texte en modèle visuel. Les feuilles natives,
  les fichiers temporaires et l’annulation sont détenus par le propriétaire natif.
- `message_compose` prépare le composeur MessageUI après aperçu exact : courriel
  avec éventuelle pièce jointe Assist ou SMS sans pièce jointe. L’utilisateur
  vérifie/modifie et décide l’envoi dans la feuille Apple. Annulation, brouillon
  enregistré ou `queued_by_user` sont des résultats distincts; aucun reçu de
  livraison/lecture ni accès aux inbox n’est revendiqué.
- L’index Core Spotlight est dédié et protégé `.complete`. Indexation uniquement
  après choix du document, titre, texte et durée; manifeste protégé, durée de
  un à sept jours plafonnée par l’expiration de l’inbox. Recherche et réouverture
  revérifient choix, identité et présence du document. Retrait/suppression/expiration
  ferment l’accès même si un résultat système arrive tard; les autres apps ne
  deviennent jamais recherchables par ce parcours.
- Cinq App Intents/Siri/Raccourcis préparent conversation, minuteur, alarme, scan
  et traduction, en mode premier plan et avec authentification locale. Leur
  brouillon est protégé, unique et expire après cinq minutes. Une arrivée alors
  qu’Assist est déjà ouvert est signalée; chargement, envoi puis confirmation
  restent des gestes distincts. Aucun intent ne lance automatiquement Gemma,
  une caméra, une traduction ou une mutation; une réouverture Spotlight ne
  transmet qu’une demande à vérifier, pas un permis d’accès.

Ces comportements sont implémentés en sources. La compilation SDK partielle,
les tests simulés et les anciens reçus TestFlight ne les qualifient pas sur iPhone.

## Ubuntu et Tailscale

La façade `assist-private-gateway.service` est installée comme service utilisateur
Ubuntu et fonctionne seulement sur `127.0.0.1:8722`. Elle réutilise SearXNG existant
sur `127.0.0.1:8721`, sans modifier ni redémarrer ce dernier. Les sources déployées
sont un snapshot protégé dans `~/.local/share/assist/private-gateway/releases/`.

Clé dédiée créée une seule fois dans
`/home/ales27pm/.local/share/assist/private-gateway/tokens.json`, fichier 0600,
répertoire 0700. Ce document ne contient pas la clé. Déconnexion iOS = suppression
locale, pas révocation serveur; une révocation opérateur exige de retirer la clé
du fichier puis de redémarrer uniquement cette passerelle.

Origine active : `https://ales27pm-system-product-name.tail7ee921.ts.net:9446`.
Après les refus non privilégié et `sudo -n`, l’opérateur a exécuté dans son
terminal la commande administrateur suivante :

```sh
sudo tailscale serve --bg --https=9446 http://127.0.0.1:8722
```

La comparaison avec la configuration avant intervention confirme l’ajout exclusif
de TCP/HTTPS 9446 et de son proxy vers 8722; anciennes routes et anciens réglages
Funnel inchangés, **aucun Funnel sur 9446**. Aucun changement global d’opérateur.
Le qualificateur suivant a réussi, sans afficher de secret :

```sh
python3 services/private-gateway/verify.py \
  --origin https://ales27pm-system-product-name.tail7ee921.ts.net:9446 \
  --tokens-file /home/ales27pm/.local/share/assist/private-gateway/tokens.json \
  --query 'WeatherKit Apple documentation'
```

Sans `--query`, le contrôle n’envoie aucune recherche. Le rapport contient
seulement TLS/authentification/capacités/comptages, aucun token ou résultat brut.
Résultat HTTPS : TLS standard valide; sans clé et mauvaise clé → 401;
capacités authentifiées exactes et recherche typée réussies, 10 résultats,
`degraded=true`, aucune page téléchargée. Depuis le second pair Mac : certificat
validé sans bypass (`ssl_verify_result=0`) et réponse anonyme 401.
L’iPhone doit être connecté au même tailnet, puis être appairé depuis le futur
binaire avec la clé saisie dans le formulaire natif, jamais dans cette conversation.
Ces contrôles ne prouvent pas encore l’appairage ni le fonctionnement sur iPhone.

## Limites et portes de livraison

- Le workspace comporte maintenant une recherche Gemma séparée et bornée,
  déclenchée par une question publique explicite. Son lecteur Ubuntu v2 et ses
  protections DNS/rebinding/SSRF sont implémentés et testés dans les sources,
  **pas déployés sur le service actif v1**. La recherche simple reste compatible
  avec ce service. Voir [la tranche recherche/cartes/météo](public-research-implementation.md).
- Le mode Gemma n’expose que `web_search` et `web_read`, sans historique privé
  ni outils iOS. Ses sources sont des reçus de pages effectivement lues; un
  extrait de recherche ne devient pas une citation de page. Ce parcours n’a pas
  encore été exécuté de bout en bout avec Gemma sur l’iPhone.
- App Group, profils et signatures Apple n’ont pas été enregistrés/activés;
  les déclarations source ne constituent pas une archive signée utilisable.
- Les outils MapKit/WeatherKit, AlarmKit, traduction et documents/composition
  sont raccordés au catalogue Gemma `device-v3-31`; les App Intents préparent
  seulement des brouillons. Leur présence source n’est pas une livraison.
  WeatherKit exige toujours une activation et une signature compatibles;
  l’affichage réel de sa marque et tous les parcours appareil restent à qualifier.
- Les tests de contrats, typechecks et générations d’objets UIKit/SwiftUI avec
  SDK simulateur 26.2 ne remplacent ni compilation complète Core AI/Objective-C++
  sur Apple Silicon avec le SDK iPhoneOS 27.1 minimum requis,
  ni archive signée, ni permissions, fonctionnement ou acoustique sur l’iPhone.
- Pas de tâche de fond illimitée ni reprise automatique. Une annulation après
  publication d’un document ne supprime pas un import déjà commis; l’inbox permet
  de le retrouver sans création répétée.

Les contrôles sont intégrés aux hooks iOS : politiques privées, inbox partagée,
checkpoints, typechecks SDK et câblage des targets/runtime/bridge. Une future
livraison nécessite encore la qualification complète et l’accord de lancement.

## Preuves locales de la tranche workspace initiale

Les nouveaux contrôles de recherche et cartes/météo sont consignés séparément
dans [l’état de la tranche suivante](public-research-implementation.md).

- `npm run check` : TypeScript, ESLint, **1 377 tests Jest / 43 suites**, Codegen
  iOS et **28 contrôles de câblage** réussis.
- Python : **27 tests** isolés de passerelle, credentials et qualificateur HTTPS.
  Sur le service actif en loopback : absence de clé → 401, mauvaise clé → 401,
  clé correcte → capacités exactes 200. Une recherche technique publique
  authentifiée retourne **10 résultats typés**, `degraded=true` (résultats bornés
  ou couverture dégradée), **0 page lue**. Ce n’est pas une preuve TLS/iPhone.
- Symboles : **37 tests** de packaging/vérification réussis, dont trois produits,
  archive Xcode, UUID discordants, extensions inconnues/partielles, limites ZIP
  et refus des liens symboliques. Fixtures seulement, pas archive signée réelle.
- Mac / Swift 6.2.4 : **56 contrôles inbox**, **61 contrôles checkpoints** et
  **68 contrôles politique réseau** réussis; sources workspace et deux extensions
  typecheckées avec SDK simulateur iOS 26.2, concurrence stricte et warnings
  bloquants. Les contrôles inbox/SDK ont été rejoués après les derniers correctifs
  d’annulation et de publication atomique. Pas d’archive complète Core AI.
- `git diff --check` réussi; modifications suivies du checkout principal
  inchangées par cette intervention. Les preuves TestFlight de native28 ne sont
  pas réutilisées comme preuves de livraison du candidat native29.
