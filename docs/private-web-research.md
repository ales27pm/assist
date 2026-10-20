# Recherche privée Ubuntu et navigateur de sources

## Périmètre du 19 octobre 2026

Après installation de la build28, l’utilisateur demande une recherche avancée
gratuite, le moins d’API externes possible, puis accepte un hébergement Ubuntu.
Il demande ensuite de réparer l’existant plutôt que de créer une autre instance,
et d’étudier en parallèle un navigateur intégré. La demande a ensuite évolué
vers la préparation d’un [lot natif regroupé](native-bundle-preparation.md),
après revue des omissions et avec une base compatible avec de futures OTA.
Aucun remplacement de Gemma/STT/TTS ni lancement payant TestFlight n’est prévu
pendant cette préparation source.

## Réparation du service existant

L’instance existante appartient à la pile monGARS sur cet Ubuntu :
`/home/ales27pm/original-monGARS/deploy/searxng/`. Sa configuration, son contrôle
de qualification et son README sont les sources de vérité de la réparation.
La passerelle reste strictement locale : `127.0.0.1:8721`, `POST /search`.
L’ancien accès interne `GET /search` n’est pas changé.

Les essais ont montré des résultats CSE hors sujet et des blocages Brave/DDG.
Une allowlist de moteurs qualifiés (`mwmbl`, `seznam`, `wikipedia`) évite ces
défaillances par défaut, sans contourner les CAPTCHA. La couverture et la langue
restent variables; il ne s’agit pas d’une garantie équivalente à un grand moteur.
Les recherches quittent toujours Ubuntu vers les fournisseurs gratuits.

Preuves fraîches : les 24 tests du qualificateur, Ruff, la syntaxe Bash et le
contrôle complet en conteneurs jetables/proxy sont réussis. Trois recherches
actives retrouvent les domaines primaires Apple, Python et RTC. Un délai Mwmbl
intermédiaire a été signalé comme dégradation; le contrôle final a réussi, sans
promesse de disponibilité permanente. Le checkout Assist principal et les
modifications monGARS indépendantes restent inchangés. Aucun commit ou push.

Cette réparation n’est **pas** le raccordement de Gemma au web. L’API SearXNG,
sans authentification applicative, n’est pas exposée directement. La nouvelle
[passerelle privée](../services/private-gateway/README.md) fonctionne sur
`127.0.0.1:8722`, avec clé dédiée et contrats bornés; les refus 401 sans clé/avec
mauvaise clé et les capacités authentifiées ont été vérifiés. Tailscale Serve
9446 est désormais actif : TLS et recherche authentifiée qualifiés, TLS/401 aussi
vérifiés depuis un second pair Mac. Les routes existantes sont inchangées,
aucun Funnel ajouté sur 9446. Le lecteur v2 bloque désormais dans les sources
les destinations privées après résolution et à chaque redirection, avec connexion
à l’IP publique validée. Il n’a pas été déployé : la passerelle active reste v1
et ne télécharge aucune page de résultat. Voir
[le chemin Gemma et ses preuves](public-research-implementation.md).

La boucle native28 reste limitée à quatre outils/180 secondes. Ne pas relever
globalement ces bornes pour simuler une recherche approfondie : concevoir un
budget de recherche distinct, en lecture seule, et conserver le propriétaire
unique du moteur et l’annulation.

## Navigateur intégré : sources implémentées, appareil à qualifier

La première version « Voir la source » utilise
[`SFSafariViewController`](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller)
dans le bridge natif existant. Interface Apple, aucune dépendance supplémentaire
et aucune exposition du DOM, des cookies ou des comptes connectés à Gemma.
Ouverture par toucher uniquement, depuis une référence de source validée par
l’hôte; jamais depuis un token de service dans une URL ni une commande JavaScript
du modèle. Ce contrôleur est opaque : ne pas prétendre filtrer chacune de ses
redirections ou sous-ressources comme avec le lecteur agentique.

`WKWebView` permettrait plus tard « Lire cette page », mais exige un consentement
explicite, un store isolé et des restrictions supplémentaires. Ne pas réutiliser
le pont JSI de `@expo/dom-webview` pour du contenu web tiers. `expo-web-browser`
et `react-native-webview` ne sont pas des dépendances directes de la build28.

Le workspace affiche uniquement les résultats typés reçus de la passerelle;
les boutons ouvrent des IDs temporaires validés par le natif, jamais des liens
libres générés par Gemma. Un résultat de recherche n’est pas une page lue.
Le candidat est désormais native29, non construit/non publié : aucune OTA
native28 n’est publiée par cette étape. Voir [l’état détaillé](native-workspace-implementation.md).

## Services Apple demandés

WeatherKit et MapKit ont désormais des primitives natives et un panneau manuel
dans les sources du candidat, sans exposition automatique au registre Gemma.
WeatherKit exige toujours l’activation de la capacité et un profil compatibles,
ainsi que la marque officielle et l’attribution Apple Weather réellement reçues.
L’entitlement est déclaré dans les sources seulement; aucune activation Developer
Portal ni modification de profil/signature n’est effectuée ici. Les API Apple
sont natives, mais prévisions, lieux et itinéraires utilisent le réseau. Il
n’existe pas d’autorisation générale donnant accès à tout iOS.
