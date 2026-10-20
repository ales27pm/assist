# Native29 — corrections après les essais des outils

État du 20 octobre 2026. Worktree `assist-private-web-research`, branche
`feature/private-web-research`, base `60d54a28f743ddd5ae1df47cf97b7bab49cf5b53`.
Les corrections ci-dessous sont non commitées et non livrées. La build29
installée reste celle du rapport physique précédent ; elle ne contient pas ce
correctif. Aucun nouveau binaire EAS, OTA, remplacement de l’application ou
déploiement de service n’a été effectué pendant cette intervention.

## Défauts traités

### Callback CoreSpotlight

`AssistDocumentSpotlight.swift` construit les entrées de callback hors de
`MainActor`, avec des types `@Sendable` explicites. La collecte copie seulement
les identifiants et domaines autorisés dans un état protégé par `Mutex`, puis
la complétion rejoint `MainActor`. Les callbacks d’indexation et de suppression
ne peuvent acquitter leur continuation qu’une fois. Annulation et expiration
révoquent l’identité et le collecteur avant `CSSearchQuery.cancel()` ; une
réponse tardive ne peut donc réactiver la recherche. Le délai est de quinze
secondes et la collecte reste bornée à la limite demandée plus un résultat.

Cette correction vise la frontière d’isolation fortement indiquée par le
SIGTRAP physique précédent. Swift documente le risque des callbacks héritant
d’un acteur lorsque leur signature n’est pas `Sendable` ; la complétion en
propriété ne doit pas être assimilée aux paramètres de méthode corrigés par
SE-0463. [Guide Swift 6](https://docs.swift.org/latest/documentation/swift-6-concurrency-migration-guide/incrementaladoption/),
[SE-0463](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0463-sendable-completion-handlers.md).

### Reçu réel, finalisation et contenu des documents

`AssistDeviceToolRun.swift` conserve les continuations canoniques
`tool_calls`/`tool_responses` et permet encore une lecture structurée après une
écriture, avec les limites existantes de quatre appels et une écriture.
Après un reçu ne contenant que des métadonnées, un EOS complet sans nouvel
appel retourne un texte déterministe fondé sur ce reçu. Une prose libre ne
peut ajouter de faits au reçu de fermeture d’un aperçu ou à un acquittement.
Un `document_read` ultérieur fournit, lui, des données pouvant être résumées.

Le repli ne masque ni erreur moteur, ni génération incomplète, ni limite de
jetons, ni protocole invalide, ni annulation. Un EOS vide après une lecture de
données reste rejeté. Un résultat incertain conserve `outcome_unknown` et
n’autorise aucune répétition automatique. Les textes distinguent programmation
et présentation d’une alerte, envoi accepté par un composeur et livraison,
aperçu fermé et texte effectivement extrait.

Les marqueurs et historiques respectent le protocole officiel de Gemma ; le
template et le modèle n’ont pas été modifiés. La cause interne des anciens EOS
immédiats n’est pas établie par cette correction. [Appels de fonctions Gemma](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4),
[format des messages](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4).

### Annulations dans les outils et la voix

Le broker reconnaît le code d’annulation fermé du sélecteur photo/caméra au
lieu de le réduire à un échec générique. Les annulations explicites sans
soumission deviennent un résultat `cancelled` jusqu’à l’interface et au
contrôleur vocal. Le brouillon est conservé, aucune réponse n’est prononcée et
la capture ne redémarre pas automatiquement. La reprise invalide également
l’ancien texte final et attend la fin du nettoyage. Une issue inconnue après
soumission reste distincte d’une annulation confirmée sans mutation.

### Reçus natifs et contrats TypeScript

- Une mutation d’alarme réussie exige sa cible exacte, un état certain et, pour
  création/remplacement, les titre, type, date et durée approuvés. Les
  inventaires vides ou historiques légitimes restent supportés.
- Les clés JSON décodées en double, y compris échappées ou imbriquées, sont
  refusées pour les reçus concernés, en Swift et TypeScript.
- Les positions imposent les plages géographiques, une précision finie
  positive ou nulle et une date UTC réelle au format canonique.
- Les six catégories de permission exigent leur vocabulaire natif fermé ; le
  panneau vérifie aussi les valeurs biométriques natives et les frontières.
- La méthode d’extraction correspond au type de document. L’expiration d’une
  indexation est future et ne dépasse pas la durée approuvée ; la durée de vie
  plus courte d’un élément de la boîte reste valide.

Les 17 attentes négatives auparavant non satisfaites sont maintenant
respectées dans les mêmes pilotes hors appareil. Il ne s’agit pas de 17
nouveaux incidents iPhone ni d’une nouvelle exécution des frameworks Apple.

### Météo : catégories d’erreur et suivi de l’autorisation

Le broker et les cartes conservent désormais une catégorie fermée : réseau
Apple, autorisation WeatherKit, attribution indisponible, service indisponible
ou reçu natif invalide. Les erreurs inconnues restent génériques. Les
descriptions arbitraires, URL, `userInfo` et données privées d’une erreur ne
sont pas affichées ou réinjectées dans Gemma. L’attribution, le chargement
effectif de la marque et les portes prose/TTS demeurent obligatoires.

Les deux échecs météo physiques précédents ont perdu leur catégorie ; leur
cause ne peut pas être déduite rétrospectivement. Une lecture de
`WeatherService.attribution` sur Mac retourne une attribution officielle
valide, dont un texte légal de 1 279 octets : le seuil de 4 Kio n’est donc pas
démontré comme cause de ces échecs. Cette lecture ne prouve aucune prévision
sur iPhone.

Apple exige WeatherKit dans **App Services** et **App Capabilities** ; un
entitlement signé ne démontre pas à lui seul les deux activations.
[Instructions Apple WeatherKit](https://developer.apple.com/help/account/services/weatherkit/).
Lors du premier contrôle, les sessions Apple mémorisées Ubuntu et Mac ont
été rejetées. Les voies normales EAS/trousseau n’ont pas fourni de mot de
passe réutilisable. Dans Chrome, le formulaire Apple attendait une
authentification fraîche, sans remplissage proposé ; la connexion avec un
iPhone n’avait pas abouti. Aucun mot de passe n’a été deviné ou extrait et
aucun réglage Apple n’avait alors été modifié. L’état d’activation
**App Services** restait inconnu à ce premier contrôle.

Une voie de connexion via Safari sur l’iPhone a également été examinée. Le
runner WDA signé et son `.xctestrun` existants sont intacts, mais les deux
requêtes réelles CoreDevice (identité logique puis UDID matériel vérifié)
échouent avec `CoreDeviceError1011`, appareil introuvable. L’appairage en cache
ne fournit ni tunnel utilisable ni accès à Safari ; le verrouillage reste
inconnu. Aucun runner, application ou écran de connexion n’a été lancé sur
l’iPhone pendant cette vérification. Cette voie exige d’abord que l’appareil
redevienne joignable depuis le Mac.

Suivi du 20 octobre, vers 13:54 UTC : une authentification Safari sur le Mac
avec les identifiants fournis ensuite par Alexis et sa validation à deux
facteurs a permis d’ouvrir le portail de l’équipe `52T7P32J34`. Pour
`org.27pm.assist`, **App Services → WeatherKit était décoché**. Le service a
été activé, enregistré et confirmé ; une réouverture de l’App ID vérifie la
case cochée, ainsi que **Capabilities → WeatherKit** déjà actif. MusicKit et
ShazamKit restent décochés. Les captures avant/après et le suivi des profils
sont conservés dans le dossier privé `tool-access-20261020` décrit ci-dessous.
Cette correction d’une condition d’autorisation ne constitue pas un retest
positif des prévisions sur iPhone. Apple exige aussi de régénérer les profils
affectés pour les prochaines compilations.
[Services Apple](https://developer.apple.com/help/account/identifiers/enable-app-services/),
[profils Apple](https://developer.apple.com/help/account/provisioning-profiles/edit-download-or-delete-profiles/).

À 14:15 UTC, le profil App Store actif `Y4S38TH4JM` est régénéré avec le
certificat de distribution existant, sans nouvelle création de certificat.
Apple affiche le statut **Active**. La copie téléchargée conserve l’App ID,
l’équipe, WeatherKit, l’App Group et le certificat attendus ; la signature
CMS est vérifiée (intégrité du contenu, sans validation de la chaîne).
Son UUID est `cd81c660-fdba-4fba-a51a-a8ae9ccb7aaa` et son SHA-256
`90dbc7c9a2ebb59ccf52ed8bc867d70132dd7a02eb6149a0a0b322f7946274d5`.
Le même enregistrement de profil EAS est mis à jour une seule fois, puis
relu par le SDK : empreinte, UUID et statut actif concordent. Les
associations App Store et le certificat restent identiques. Le vieux profil
historique du 15 octobre et les profils Share/Widget ne sont pas modifiés.
Aucune build ni soumission n’est lancée par cette synchronisation.

Après la confirmation d’Alexis « Tailscale actif et Assist ouvert », un
nouveau contrôle à 14:17 UTC échoue encore à la frontière CoreDevice :
deux requêtes de métadonnées, avec relecture des détails et un seul rejeu,
retournent `CoreDeviceError1011`. Aucun runner ni appel météo n’a pu être
lancé. La validation des variantes 1 h/1 jour et 0 h/0 jour reste donc
ouverte ; ce suivi ne transforme pas les échecs physiques en résultats
positifs. Le rapport et les traces de cette nouvelle fenêtre sont conservés
dans `tool-access-20261020/weather-retest/20261020T141711Z/`.

## Vérifications du correctif

| Frontière vérifiée | Résultat | Limite |
| --- | --- | --- |
| `npm run check` | 1 777 tests / 59 suites, TypeScript, ESLint, Codegen, 54 contrôles de câblage et 25 de capacités : exit 0 | Une alerte ESLint préexistante de variable masquée ; doublures natives JS |
| Pilotes broker de la revue précédente | 71/71 attentes conformes, dont les 17 échecs antérieurs ; expiration réelle à 120 s, zéro exécuteur | Propriétaires natifs scriptés hors appareil |
| Mac Swift 6.2.4 strict | 31 schémas ; 107 contrôles Tool Host ; 112 de boucle ; 391 de transactions ; 69 Apple Places ; 50 attribution et 5 ImageIO ; 58 alarmes ; 97 documents ; 48 callbacks Spotlight | Harnais ciblés, pas une archive |
| Sources App, Share, Widget | Compilation en objets contre le SDK simulateur iOS26.2, Xcode26.3 : exit 0 | Pas de lien complet CoreAI/Objective-C++, signature ou archive SDK27.1 |
| Callback CoreSpotlight réel sur Mac | Callback de framework hors thread principal puis livraison sur `MainActor`, sans trap | Requête en lecture seule sur identités aléatoires non indexées ; le service renvoie NSCocoaErrorDomain4097, donc pas de recherche positive |
| Tokenizer/Jinja Swift réel | 5/5 cas, mêmes identifiants de jetons que la référence Jinja indépendante ; registre31, continuation, quatre appels et sous-ensembles | Aucune inférence Gemma ni exécution iPhone |

Le tokenizer utilise les huit révisions épinglées du cache existant, sans
téléchargement ; l’exécution interdit le réseau et désactive le cache Hub.
Le projet et le binaire de validation antérieurs sont conservés avec les mêmes
empreintes. Les deux instantanés Mac contiennent chacun 106 fichiers ; seuls
la boucle et son harnais diffèrent entre les passages, et leurs contrôles ont
été rejoués sur l’instantané final. Les empreintes sont vérifiées avant et
après les contrôles.

## Preuves locales et portes restantes

Rapport et preuves privés :
`/home/ales27pm/.local/share/assist/releases/1.0.0-29-f1cbfd7a/fixes-20261020-g_3e1a0h/`.
Le rapport physique d’origine, avec ses échecs et ses limites, reste séparé
dans `all-tools-20261020/report.md` ; il n’est pas réécrit comme preuve d’un
correctif installé.

Suivi ultérieur de l’accès Apple et de la correction du connecteur Ordinateur :
`/home/ales27pm/.local/share/assist/tool-access-20261020/`. Les secrets joints
et les codes de vérification ne sont pas recopiés dans les preuves produites.

Avant livraison et qualification positive :

1. Requalifier les prévisions exactes 1 h/1 jour et 0 h/0 jour après
   l’activation Apple et la synchronisation du profil désormais confirmées.
   L’état physique antérieur reste un échec tant qu’un retest n’est pas observé.
2. Compiler et lier l’application entière contre le SDK cible, puis vérifier
   l’archive signée, les trois produits et leurs entitlements.
3. Installer ce correctif dans un binaire identifié et reprendre les scénarios
   physiques : recherche Spotlight, écritures puis lecture, aperçu sans texte,
   annulations et reprise vocale, météo, arrière-plan et callbacks tardifs.
4. Terminer les essais positifs photo, caméra, scanner et Face ID avec une
   fixture non personnelle, puis observer la présentation d’une notification
   et d’une alerte. Le parcours Ubuntu/web, partage/widgets, App Intents,
   import des modèles et rollback gardent leur qualification distincte.

Les poids complets, le contexte 32 768, le moteur unique, les dépendances et
les trois thèmes sont conservés. Ces résultats de source et de harnais ne
permettent pas de déclarer les 31 outils corrigés et qualifiés sur iPhone.
