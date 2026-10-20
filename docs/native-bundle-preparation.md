# Préparation du prochain socle natif Assist

## État et décisions utilisateur — 19 octobre 2026

Voir la [tranche native29 courante](native29-native-bundle-2026-10-19.md)
pour les implémentations et preuves réunies après la
[stabilisation locale native29](native29-stabilization-2026-10-19.md).
Les nombres conservés ci-dessous décrivent les validations historiques des
tranches précédentes, pas les totaux finaux de ce lot.

Préparation source **en cours**, pas livraison. La build 28 possède les 13 outils
iOS et l’OCR Vision décrits dans [device-tool-agent.md](device-tool-agent.md).
Le contrat extensible v2, le workspace Documents/Ubuntu, le navigateur de sources,
les extensions Partage/Widget et les checkpoints sont implémentés dans ce worktree;
voir [l’état et les preuves détaillés](native-workspace-implementation.md).
Le runtime candidat est désormais `1.0.0-native29`, avec trois targets configurés.
Ce code n’est pas publié et ne doit pas être envoyé par OTA à native28. Une boucle
Gemma de recherche publique et un lecteur Ubuntu v2 sont désormais implémentés
dans les sources, ainsi que les primitives MapKit/WeatherKit, leur panneau
manuel et leur raccordement au catalogue Gemma. Le catalogue courant compte
**31 outils**, révision `device-v3-31` : les 13 historiques, les 3 outils
cartes/météo et 15 outils alarmes, traduction, documents et composition MessageUI.
Le jalon `device-v2-16` décrit la tranche précédente, dépassée dans les sources.
AlarmKit/Live Activity, traduction locale, VisionKit/PDF/Quick Look, index
Spotlight choisi et App Intents de préparation sont désormais implémentés;
ces sources ne valent ni livraison ni qualification iPhone. Le lecteur Ubuntu
v2 n’est pas déployé et les portes Apple restent ouvertes. Voir
[la tranche recherche et ses limites](public-research-implementation.md).

Décisions à conserver :

- Objectif d’**une seule build groupée**, sans garantir qu’aucun défaut ne
  nécessitera un correctif. Pas de build intermédiaire recherche seule.
- Gemma, moteur unique, React Native, STT/TTS et protections existants conservés.
- Recherche sans abonnement moteur, sur Ubuntu existant; Internet reste requis
  et les moteurs gratuits ont une disponibilité/couverture variables.
- MusicKit exclu : l’utilisateur emploie Spotify. Aucune intégration Spotify
  supplémentaire ni souscription n’est implicitement autorisée.
- HealthKit/HomeKit optionnels : différer s’ils compliquent la livraison, sans
  bloquer le lot principal ni ajouter leurs permissions à titre préventif.
- Préparer les vraies fonctions, leurs ponts et déclarations nécessaires; pas
  de stubs dormants, permission générale « tout iOS » ou inflation des accès.
- Aucun lancement payant EAS, retry payant automatique, achat de plan Expo,
  changement Developer Portal/signature/profil ou autre mutation de compte sans
  accord explicite. La préparation source n’accorde pas ces autorisations.

## Première tranche réalisée : Tool Host v2

Les API additives `getToolHostCapabilities` et `generateWithToolHost` conservent
le chemin v1 intact. Le catalogue annonce les contrats compilés, leur version,
effet et lieu d’exécution; ce n’est pas une permission accordée. L’interface
négocie ses contrats connus, fige sa sélection par tâche et ne rétrograde vers
v1 que si le pont v2 est absent. Un pont partiel ou incompatible est refusé.

Le natif vérifie version, révision et profil `device_v1`, puis réduit le schéma
Gemma au sous-ensemble demandé. Un outil connu mais exclu n’atteint pas le
broker. Moteur, admission, confirmations, journal, annulation et plafonds
restent uniques. Le profil `device_v1` du Tool Host v2 annonce désormais
`device-v3-31`, avec les 13 outils historiques, `maps_search`, `maps_directions`,
`weather_forecast`, les 5 outils `alarm_*`, les 2 outils de traduction et les
8 outils documents/composition. La révision exacte est négociée; l’ancien
`device-v2-16` ne doit pas être annoncé comme le catalogue courant.
Le pont v1 conserve les 13 outils et ne permet pas les 18 additions. La nouvelle entrée native `generateResearch` négocie séparément le
profil fermé `research_v1` : `web_search` et `web_read`, sans accès aux outils iOS.
Les trois outils Apple passent par le même broker de confirmation et de reçus;
les lieux exacts et le fournisseur sont présentés avant l’appel réseau. Ce
raccordement et les 15 additions sont source-only, sans qualification Gemma
réelle/iPhone. Cela
prépare la composition de futures recettes OTA, pas l’ajout de code natif par OTA.

Validation historique de cette tranche, avant le raccordement des 16 outils :

- `npm run check` : TypeScript, ESLint, **1 319 tests / 40 suites** et
  Codegen iOS réussis. Le test de préinstallation vérifie aussi que l’échec du
  nouveau harnais bloque les contrôles suivants; il ne lance pas EAS.
- Swift 6.2.4 sur macOS, concurrence stricte et avertissements bloquants :
  89 contrôles de contrat/sélection et 43 contrôles de boucle réussis; aucun
  accès appareil ou modèle pendant ces tests.
- Les 13 schémas et le parseur fermé passent leurs contrôles. Le template
  Gemma local au SHA-256 canonique est rendu indépendamment avec Python/Jinja
  sur Ubuntu puis validé par l’exécutable Swift sur Mac : catalogue complet,
  calendrier seul et quatre continuations chronologiques réussis. Le Python
  par défaut du Mac n’a pas Jinja; aucune dépendance système n’a été installée.
- Parsing syntaxique de `AssistCoreAI.swift`, 12 contrôles de câblage source,
  Codegen iOS et revue indépendante réussis. Ces preuves ne remplacent **ni**
  compilation complète Core AI/Objective-C++, **ni** boucle Gemma réelle,
  autorisations iOS, archive signée ou validation iPhone.

Le nouveau harnais `scripts/check-device-tool-host.sh` fait partie des contrôles
préalables iOS; aucune commande EAS n’a été exécutée pour cette préparation.

## Lot principal et portes natives à ne pas oublier

Le tableau décrit le lot complet visé, pas une liste de fonctions livrées.
Les fondations réalisées et les limites restantes sont suivies séparément dans
[l’état d’implémentation](native-workspace-implementation.md). Une importation
de framework ne constitue pas un outil.

| Bloc | Fonction réelle et limites à embarquer |
| --- | --- |
| Recherche Ubuntu | Pairing/configuration HTTPS native, Keychain, transport typé, recherche puis lecture bornée des pages, citations vérifiables, annulation. Réutiliser SearXNG derrière une façade authentifiée, jamais exposer directement son port local sans authentification. |
| Navigateur de sources | `SFSafariViewController` ouvert par toucher depuis un ID de source validé. Pas de DOM/cookies transmis à Gemma; pas de promesse de filtrage de toutes les redirections internes de Safari. Le lecteur agentique reste séparé. |
| WeatherKit | Activation/capacité et profil compatibles à obtenir avec accord; prévisions datées, unités, erreurs/réseau/quota, marque Apple Weather et attribution légale issues du service, non inventées par Gemma. La formule incluse au compte Developer n’autorise aucun achat supplémentaire. [Apple](https://developer.apple.com/weatherkit/) |
| MapKit | Recherche de lieux, itinéraires et ouverture de carte; ville/adresse explicite utilisable sans demander le GPS. Position courante seulement sur demande et avec l’accès existant; réseau, attribution et limites des résultats visibles. [MapKit](https://developer.apple.com/documentation/mapkit) |
| AlarmKit | Sources réalisées : créer, lister, remplacer, arrêter et annuler **les alarmes d’Assist**, autorisation après confirmation, IDs stables et propriété persistée avant effet. Le remplacement annule puis programme sous le même ID; perte de reçu = `outcome_unknown`, sans retry. Les vrais minuteurs utilisent `AlarmConfiguration.timer` et la Live Activity du Widget. `NSAlarmKitUsageDescription` et `NSSupportsLiveActivities` sont déclarés; comportement réel, confidentialité et signature restent à qualifier. Aucun accès aux alarmes de l’app Horloge. [Exemple Apple](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit) |
| Documents | Sources réalisées : scanner VisionKit multipage borné, OCR Vision, PDFKit pour lecture/création de PDF et Quick Look pour aperçu; import **et export/partage** de documents sélectionnés. Types et tailles bornés, PDF protégé/sans texte signalé, security-scoped access équilibré et fichiers temporaires purgés. Aucun accès général à Fichiers/iCloud; caméra, feuilles Apple et verrouillage à qualifier sur appareil. [Document picker](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller) |
| Translation / Natural Language | Sources réalisées : détection Natural Language bornée, vérification des paires/modèles Apple, traduction locale avec modèles installés. `supported` ne signifie pas `installed` : préparation/téléchargement Apple uniquement après accord explicite au premier plan. Annulation et réponses tardives clôturées; aucune conservation du texte ni fallback cloud. Disponibilité réelle et premier téléchargement restent à qualifier. [Disponibilité](https://developer.apple.com/documentation/translation/languageavailability), [préparation](https://developer.apple.com/documentation/translation/translationsession/preparetranslation()) |
| Siri / Raccourcis / bouton Action | Cinq App Intents réels préparent conversation, minuteur, alarme, scan ou traduction. Ils exigent premier plan et authentification locale, puis déposent un brouillon protégé expirant après cinq minutes. Arrivée signalée, chargement/envoi manuels et confirmation du broker restent distincts. Aucun intent, widget ou lien entrant ne génère de texte avec Gemma, ne programme une alarme, ne lance la caméra ou n’émet de permis de mutation automatiquement. [Authentification](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy) |
| Widgets / Live Activities | Extension Widget existante et vraie Live Activity AlarmKit de compte à rebours ajoutée au bundle. Progression détenue par AlarmKit, libellé générique et décompte annoté sensible sur écran verrouillé/Dynamic Island; fin/expiration/arrêt et présentation physique à qualifier, sans revendiquer ces tests comme exécutés. Afficher un décompte ne garantit pas que Gemma continue en arrière-plan. [ActivityKit](https://developer.apple.com/documentation/activitykit) |
| Courriels / messages | Sources MessageUI réalisées : destinataires/texte et pièce jointe Assist pour courriel validés, aperçu exact puis composition Apple. SMS sans pièce jointe. L’utilisateur peut modifier, annuler, enregistrer ou décider l’envoi dans l’UI Apple; un reçu `queued_by_user` n’est ni livraison ni lecture. Aucun accès aux inbox; absence de compte/capacité et annulation restent à qualifier. [Limites du composeur](https://developer.apple.com/documentation/messageui/mfmailcomposeviewcontroller) |
| Recherche locale | Sources Core Spotlight réalisées : index dédié protégé `.complete`, titre et texte extrait d’un document Assist indexés seulement après choix explicite. Manifeste protégé, durée choisie de 1 à 7 jours plafonnée à l’expiration inbox, retrait et revalidation d’ID avant réouverture. Ni indexation automatique des imports ni lecture de l’index privé des autres apps; verrouillage, expiration et résultats OS tardifs à qualifier. [Core Spotlight](https://developer.apple.com/documentation/corespotlight) |

## Socle réseau et extensibilité OTA

La [réparation SearXNG](private-web-research.md) est maintenant utilisée par une
façade authentifiée sur Ubuntu, `127.0.0.1:8722`; le port SearXNG 8721 reste local.
L’UI native prépare un appairage à une origine HTTPS exacte, certificat normalement
validé, sans extension VPN Assist. Après exécution de la commande administrateur
par l’utilisateur, Tailscale Serve 9446 est actif et qualifié : TLS standard,
refus des clés absentes/incorrectes, capacités et recherche authentifiées.
Les anciennes routes et réglages Funnel restent inchangés; aucun Funnel ajouté
sur 9446. Une vérification Mac confirme aussi TLS/401 depuis un second pair.
L’appairage et le parcours iPhone restent à qualifier dans le futur binaire.

Checklist de fondation :

- [x] Jeton dédié limité à la recherche, natif write-only;
  Keychain `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, non synchronisé.
  Aucun secret dans les URL, logs, prompts, manifestes OTA ou App Group.
  [Protection Apple](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly).
- [x] Setup natif, état non secret, déconnexion locale, handshake versionné,
  recherche/lecture/annulation typées dans les sources. La révocation serveur
  reste opérateur; le service actif demeure v1, sans lecture. Pas de pont générique
  `request(url, headers)`, d’exécution de code ou de chargement natif distant.
- [x] `NSLocalNetworkUsageDescription` ajouté pour le chemin LAN, avec
  `NSAllowsLocalNetworking=true`. Garder
  `NSAllowsArbitraryLoads=false`; aucune permission n’est demandée maintenant.
  Bonjour seulement si une découverte réelle est retenue, sans multicast inutile.
  ATS et accès réseau local sont distincts. [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
- [x] Séparer dans les sources l’origine privée autorisée et les destinations du lecteur public Ubuntu :
  bloquer SSRF/DNS rebinding, IP privées/tailnet/loopback/link-local/métadonnées,
  IPv6 et redirections vers ces réseaux. Valider les adresses effectivement
  utilisées à chaque saut; ne jamais transférer le jeton aux pages publiques.
- [x] Session réseau éphémère sans cookies/cache/credentials partagés avec le
  navigateur; redirections de la passerelle refusées, TLS standard, limites de
  taille décompressée/MIME/pages/durée appliquées pendant la réception.
- [x] Résultats de recherche typés, IDs natifs temporaires liés à la requête et
  à la configuration; titre/extrait non fiables. Les références de synthèse ne
  proviennent que de reçus de lecture validés, jamais des seuls extraits.
  Une citation de page exige sa lecture réelle;
  URL/prose libre du modèle ne produit pas de bouton de source fiable.
- [x] Catalogues de tâche séparés dans les sources : recherche web publique **sans outils de
  lecture privée ou mutation iOS**. Aucun contexte contacts/calendrier/OCR/
  documents privé envoyé au web. Une future combinaison exige un transfert
  explicite et borné approuvé par l’utilisateur, pas une instruction de page.

Le Tool Host v2 conserve l’API v1 et négocie le
profil `device_v1` : révision exacte du catalogue, versions des opérations et
sous-ensemble requis figé pour le tour parmi les 31 outils compilés de
`device-v3-31`. Le pont v1
reste limité aux 13 outils historiques. Une
disponibilité annoncée « compilée » ne signifie pas permission accordée. Le
profil `research_v1` a désormais son entrée et ses capacités natives dédiées,
sans modifier le catalogue `device_v1`. Une passerelle limitée à v1 est refusée
explicitement par la recherche Gemma; aucune rétrogradation en faux succès.

Le socle final doit négocier capacités **réellement implémentées**, opérations,
schémas et plafonds natifs. L’exposition d’un outil est l’intersection du
manifeste/politique autorisé, du support natif et du choix utilisateur. Une OTA
peut composer les briques présentes ou ajouter un connecteur Ubuntu compatible;
elle ne peut ajouter du Swift, un entitlement, une extension ou relever les
limites de confiance. Outil absent/contrat inconnu : désactivé, pas de faux succès.
Un serveur ne s’auto-attribue ni permissions iOS ni droit de mutation.
[Compatibilité runtime Expo](https://docs.expo.dev/eas-update/runtime-versions/).

## Gate d’omissions avant gel du candidat

- [ ] **Signature** : les trois targets Assist/Share/Widget sont câblés dans les
  sources, avec identifiants, ressources, embedding et App Group commun uniquement
  pour une inbox sélectionnée et des snapshots minimisés. Pas de partage de
  jeton avec les extensions. Profils, archive et signatures restent à vérifier.
  Enregistrer/activer côté compte uniquement après
  accord. [App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups).
- [x] **Entrées/sorties source** : Share Extension avec UTI/activation bornés, import/
  export sélectionné, handoff d’ID et navigation dans Assist, annulation,
  doublons, nettoyage et protection au verrouillage. Déclarer seulement les
  document types/routes nécessaires; pas d’Associated Domains ou URL schemes
  supplémentaires sans parcours concret validé.
- [x] **Cycle de tâche source** : request/turn/configuration IDs; délai, annulation,
  401, déconnexion, changement d’origine et résultats tardifs clôturés une fois.
  Conserver moteur unique, journal/confirmation et `outcome_unknown` existants.
  Budget recherche distinct : ne pas relever globalement 4 outils/180 s.
  Migration/rollback du journal : un nom d’outil devenu inconnu ne doit pas
  masquer les opérations incertaines ni provoquer leur répétition.
- [x] **Checkpoint et arrière-plan source** : sauvegarde minimale protégée et
  bornée, aucune reprise ou mutation automatique après relance.
  Une recherche longue peut être interrompue par iOS. Si retenu,
  `BGContinuedProcessingTask` exige action de premier plan, progression et
  expiration/annulation OS; ce n’est pas un droit à exécution illimitée.
  [Apple Background Tasks](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados).
- [x] **Exécuteurs source du lot** : AlarmKit et Widget de décompte, traduction
  locale, scanner/PDF/Quick Look, composition MessageUI, Spotlight sur choix
  explicite et App Intents de brouillon sont présents et raccordés aux ponts.
  Le catalogue v3 contient 31 outils; v1 reste fermé aux 13 historiques. Cette
  case valide la présence source, pas l’appareil, l’archive ou les comptes.
- [ ] **Retraits et disponibilité** : permission refusée/révoquée, API/langue
  indisponible, Ubuntu hors ligne, quotas et défauts de compte ont un état sûr.
  Aucune demande de permission au lancement pour une capacité inutilisée.
- [ ] **Données et UI** : séparation web/privé, attribution météo/cartes,
  diagnostics sans contenu personnel, Dynamic Type/VoiceOver et TTS sans JSON,
  IDs, syntaxe d’outil ou flux périmé. Widgets verrouillés expurgés. Les cartes
  identifient les trois outils réseau comme « service Apple en ligne ».
- [ ] **Compatibilité appareil** : régression des 13 outils/OCR/voix à qualifier;
  le JS désactive proprement le workspace si les méthodes natives sont absentes.
  Les sources du runtime sont passées ensemble à native29; l’archive reste à
  vérifier. Jamais une OTA du nouveau natif vers 28.
- [ ] **Authenticité OTA et coût** : décider la signature des updates, sa clé
  et les conditions du plan Expo avant configuration; cette protection n’est
  pas actuellement embarquée. Ne pas acheter Production/Enterprise ni présenter
  la signature comme acquise. Le registre versionné ne remplace pas la confiance
  dans la provenance du JavaScript. [Signature Expo](https://docs.expo.dev/eas-update/code-signing/).

## Réception et décision de lancement

Avant EAS : contrats v2 et refus de versions/capacités incompatibles, tests des
exécuteurs et de sécurité réseau, Codegen/TS/lint, archive préparatoire avec SDK
requis, extensions/entitlements cohérents et checklist ci-dessus sans omission
silencieuse. Si un bloc principal manque, le signaler avant gel plutôt que
livrer un stub annoncé comme fonctionnel. Tout report substantiel est explicite.

La preuve iPhone doit couvrir au minimum recherche puis citations/Safari,
Ubuntu indisponible, annulation/arrière-plan/résultat tardif, GPS refusé avec
ville explicite, WeatherKit et attribution, alarme + countdown/widget,
document import/export/partage et PDF protégé, paire de langues indisponible,
modèle non installé et téléchargement autorisé puis annulé, intent depuis appareil
verrouillé et réception du brouillon au premier plan sans exécution, composeur
annulé, index Spotlight protégé/opt-in et purge à l’expiration. Tests
simulés, compilation, upload Apple et fonctionnement sur iPhone sont des preuves
différentes : conserver leurs statuts séparés.

Après revue du candidat et accord de coût : **un lancement groupé visé**, pas
de relance payante automatique. Vérifier IPA signée, extensions, symboles,
runtime et état TestFlight; une éventuelle nouvelle tentative exige une nouvelle
décision après diagnostic. Les améliorations OTA ultérieures restent limitées
au contrat et au binaire effectivement livrés.
