# Recherche Gemma, cartes et météo — tranche source du 19 octobre 2026

État : implémenté et vérifié dans le worktree
`feature/private-web-research`, **non livré**. Le runtime candidat demeure
`1.0.0-native29`; aucune build EAS, OTA, inscription App Group ou activation de
capacité/profil Apple n’a été lancée par cette tranche. Le checkout principal
et le service privé actif ne sont pas remplacés.

## Recherche publique avec le même Gemma local

Le workspace propose une recherche simple Ubuntu et une action distincte
« Rechercher avec Gemma ». Cette dernière transmet seulement la question saisie,
sans historique, calendrier, contacts, documents ni OCR. **La question de recherche
quitte l’iPhone vers Ubuntu puis les moteurs Internet** : l’utilisateur doit
éviter d’y saisir des données privées. Le jeton reste natif et n’entre jamais
dans le prompt ou React Native.

`generateResearch` utilise le coordinateur et le moteur Core AI existants,
avec le même verrou d’opération, admission et annulation. Ce n’est pas une
deuxième instance de Gemma ni un service d’inférence distant. Son profil
`research_v1` est séparé du catalogue des 13 outils iOS :

- uniquement `web_search(query)` et `web_read(result_id)`;
- au plus une recherche, puis quatre lectures distinctes, au total cinq appels;
- durée maximale 120 secondes, sorties de modèle bornées à 1 024 tokens par passe;
- question initiale unique, schémas fermés, aucune mutation ou lecture privée;
- format Gemma canonique qualifié par hash; appel complet requis, pas de
  récupération permissive d’une commande tronquée ou noyée dans de la prose;
- réponses et appels d’outil internes non streamés vers le fil ou le TTS;
- texte de pages traité comme donnée non fiable, jamais comme autorisation.

Un résultat de recherche contient seulement un extrait. Une référence de synthèse
provient obligatoirement d’un reçu de lecture validé, lié à la requête, à un ID
réellement émis et à son titre. Les citations `[source:ID]` inconnues ou incomplètes
sont refusées. Le bouton de source ouvre l’URL finale conservée par le natif,
pas une URL libre générée par le modèle. Horodatage de lecture et troncature
restent visibles; une citation ne garantit ni fraîcheur ni exhaustivité.
Une réponse sans recherche/lecture n’obtient aucune référence de page et le
panneau indique explicitement qu’aucune page n’a été lue.

Déconnexion, annulation et perte de premier plan révoquent l’admission et le
transport avant de drainer le moteur. Les résultats tardifs ne rejoignent pas
une autre tâche. La fin réussie est revérifiée après les dernières suspensions;
un résultat annulé ne conserve pas ses références. Aucun travail ne reprend
automatiquement depuis un checkpoint.

## Lecteur Ubuntu v2 : source candidate, pas service déployé

Les contrats v1 restent exacts. Le nouveau client exige explicitement
`GET /v2/capabilities`, puis `POST /v2/read` avec un ID émis par la recherche
au même token et à la même requête. Il ne peut fournir ni URL, en-têtes,
cookies, méthode ou proxy. Un serveur v1 est refusé pour ce parcours plutôt
que présenté comme capable de lire des pages.

Le lecteur consomme le handle avant soumission, sans retry automatique, et
applique TTL, quotas et limites de concurrence. Chaque destination, robots et
redirection est validée : HTTPS, DNS exclusivement public, IP numérique épinglée
pour la connexion, vérification TLS/SNI normale. Les réseaux privés, loopback,
tailnet, métadonnées, plages réservées et réponses DNS mixtes sont refusés.
Le jeton de passerelle n’est jamais transmis aux pages.

La lecture complète est limitée à 15 secondes, trois redirections, 512 KiB
de corps et 8 KiB de texte extrait. Les en-têtes/corps lents ont un délai absolu.
Seuls HTML et texte brut sont acceptés, sans compression, JavaScript, PDF,
authentification, contournement de paywall ou CAPTCHA. Les règles robots sont
conservatrices : certains sites légitimes seront refusés. Voir le
[contrat détaillé](../services/private-gateway/README.md).

**Le service actif reste le snapshot v1** sur `127.0.0.1:8722`, derrière
Tailscale HTTPS 9446. Aucun redémarrage, nouveau token, changement SearXNG ou
Funnel n’a été effectué ici. Le lecteur v2 et la boucle Gemma n’ont donc pas
encore été essayés ensemble contre ce service. Un futur déploiement devra
embarquer `reader.py` avec `server.py`, conserver le fichier de credentials
existant et requalifier explicitement v1 et v2 avant toute preuve iPhone.

## MapKit / WeatherKit : panneau et trois outils Gemma

Les méthodes typées et leur panneau sont câblés au bridge natif : recherche de
lieu bornée, ouverture dans Plans par ID natif, estimation de trajet à pied/en
voiture et météo à partir d’un lieu choisi. Aucun GPS, recherche, prévision ou
navigation ne démarre au montage. Le statut initial est uniquement une lecture
de métadonnées compilées, pas une preuve de service autorisé.

Les coordonnées explicites évitent une nouvelle permission de localisation.
Les opérations possèdent leur identité, délai et annulation natifs; elles ne
partagent pas le transport Ubuntu. Un trajet est une estimation, pas un guidage
démarré ni une heure d’arrivée garantie. `maps_search`, `maps_directions` et
`weather_forecast` sont désormais raccordés au registre fermé `device-v2-16`
dans les sources. Le broker impose l’aperçu des données envoyées et un accord
à usage unique avant chaque accès Apple. Le pont v1 conserve ses 13 outils.
Ce raccordement n’est pas une preuve de fonctionnement Gemma réel ou iPhone.

WeatherKit est importé, lié et déclaré dans les entitlements source. Cela
n’active pas la capacité dans le compte Apple et ne crée pas de profil signé.
Les données contiennent unités, date d’observation/consultation, prévisions
bornées et attribution exacte retournée par Apple.

La source native charge le PNG officiel adapté au thème dans une session
éphémère sans redirection, borne ses octets/dimensions puis le décode/réencode
avec ImageIO. La présentation attend le vrai `onLoad` de l’image avant les
valeurs météo, la prose finale et la voix. Le reçu final conserve les données
si un événement intermédiaire est perdu; un échec ou une annulation bloque les
valeurs et résultats tardifs, sans nouvel essai automatique. Les tests JS
simulent le chargement; ils ne prouvent pas le rendu iPhone. WeatherKit doit
encore être activé et essayé sur un binaire signé, avec attribution claire/sombre.

## Vérifications et limites de preuve

- `npm run check` : TypeScript, ESLint, **1 494 tests / 46 suites**, Codegen iOS
  réussis. Le câblage targets/runtime/bridge passe; après ajout de fixtures
  négatives recherche/framework/entitlement et révocation native, **40 contrôles**
  de câblage passent.
- Python : **52 tests** isolés de passerelle/credentials/qualification/lecteur;
  pages publiques non contactées par ces fixtures.
- Swift 6.2.4 : **125 contrôles de boucle recherche**, **89 contrôles de
  politique réseau**, **59 contrôles cartes/météo** réussis. Le rendu Jinja
  indépendant du tokenizer canonique ajoute trois vérifications, soit 128
  pour le harnais recherche avec golden fixture.
- Sources workspace et deux extensions typecheckées contre SDK simulateur
  iOS 26.2, Swift 6/concurrence stricte/avertissements bloquants. Parsing de
  `AssistCoreAI.swift`, **13 contrôles** de raccordement et **37 tests** de
  packaging/vérification des symboles réussis.

Ces preuves ne sont **pas** une compilation complète de Core AI/Objective-C++
avec le SDK cible, une archive signée, un essai de Gemma réel avec le web,
une validation de performances, d’ANE ou d’iPhone. La passerelle active est
distincte des nouvelles sources. Les preuves historiques de native28 ne
qualifient pas native29.

## Avant le gel de la build groupée

Le [lot principal](native-bundle-preparation.md) n’est pas terminé : restent
notamment AlarmKit/countdowns, traduction, App Intents/Raccourcis et les autres
parcours retenus non implémentés. Il faut aussi achever le rendu d’attribution,
les tests appareil, l’archive préparatoire, les profils/extensions/App Group,
la confidentialité et la décision d’authenticité des OTA. Ne pas lancer une
build partielle payante ou présenter ces fonctions comme déjà livrées.
