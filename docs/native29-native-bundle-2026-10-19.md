# Native29 — compléments natifs du 19 octobre 2026

État source non livré dans `assist-private-web-research`, branche
`feature/private-web-research`, HEAD `ecbc78e80303e60f0adc3c6f65ffabe4df988da5`
avec modifications non commitées. Cette tranche complète la
[stabilisation précédente](native29-stabilization-2026-10-19.md).
Le checkout principal et les travaux préexistants sont conservés.

## Parcours implémentés

Le Tool Host v2 annonce maintenant `device-v3-31`. Les 13 outils historiques
restent seuls sur le pont v1; les 3 outils cartes/météo et 15 nouveaux outils
sont négociés par le pont v2. Une capacité compilée ne constitue ni permission
OS, ni confirmation d’une action. Les nouvelles opérations traversent le même
registre fermé, les arguments figés, l’aperçu exact, le permis tactile à usage
unique, la validation du reçu et la boucle Gemma existante.

| Bloc | Sources et comportement |
| --- | --- |
| Alarmes/minuteurs | AlarmKit réel : liste, création, modification, arrêt et annulation des seuls identifiants appartenant à Assist. Propriété persistée avant soumission; état incertain conservé. La modification annule puis remplace sous le même identifiant et le précise dans l’aperçu. Compte à rebours avec une vraie Live Activity WidgetKit. Aucun remplacement par notification. |
| Traduction | Disponibilité des paires Apple, détection locale, distinction pris en charge/installé, traduction locale. Téléchargement seulement après accord explicite au premier plan; aucune traduction cloud. L’annulation invalide le résultat; elle ne garantit pas l’arrêt d’un téléchargement système déjà soumis. |
| Documents | Scanner VisionKit de 8 pages maximum, OCR Apple borné à 40 lignes/8 Kio, PDF protégé dans l’inbox Assist, export PDF par destination choisie, aperçu Quick Look. Les PDF protégés/sans texte ont un état explicite; aucun déverrouillage ou accès global à Fichiers. |
| Composition | MessageUI avec canal, destinataires, objet, texte et éventuelle pièce jointe sélectionnée. L’utilisateur envoie dans l’interface Apple. Un résultat du composeur ne prouve jamais livraison ou lecture. |
| Recherche locale | Core Spotlight sur choix explicite du document, titre et durée de 1 à 7 jours. Le texte choisi est copié dans un index local protégé; retrait, expiration, suppression et réouverture contrôlés. L’accord porte sur le document choisi, sans aperçu préalable de tout son texte extrait. Aucun accès à l’index privé des autres apps. |
| Siri/Raccourcis | Cinq App Intents découvrables, authentification locale, premier plan. Ils préparent un brouillon protégé de cinq minutes, sans démarrer Gemma, microphone, téléchargement ou outil. Le toucher dans Assist charge le brouillon; l’utilisateur l’envoie puis confirme séparément les actions. Spotlight ne fait lui aussi que préparer un brouillon d’un ID encore autorisé. |

Les panneaux manuels reprennent les primitives, thèmes et règles de focus de
l’application. App, Partage et Widget sont câblés dans le projet Xcode; les
nouvelles déclarations AlarmKit/Live Activities sont présentes dans les sources.
Le runtime reste `1.0.0-native29`, numéro 29 pour les trois produits.

## Courses et incertitude

- Un changement de brouillon publie un signal sans contenu privé; le JS relit
  le stockage natif. Un signal reçu pendant l’acquittement d’une fermeture
  entraîne une relecture différée. Un ancien ACK ne charge rien après passage
  en arrière-plan, changement de tâche ou indisponibilité des outils.
- Les continuations de reçus d’alarmes utilisent l’heure historique de validation.
  Une alarme achevée reste réinjectable; une nouvelle proposition datée dans le
  passé reste refusée.
- Une action interactive pouvant publier un scan, exporter un document ou ouvrir
  un envoi est traitée conservativement après transmission au propriétaire natif.
  Une annulation ou perte de reçu ne devient pas une preuve d’absence d’effet.
  Les résultats incertains restent visibles sans nouvel essai automatique.
- Le journal conserve les opérations incertaines. Une capacité de 100 entrées
  non résolues bloque une nouvelle mutation au lieu d’effacer une incertitude.

## Preuves et limites

- `cd mobile && npm run check` : exit0, TypeScript, ESLint sans erreur
  (un avertissement de shadowing préexistant), **1 690 tests Jest / 57 suites**,
  Codegen iOS et contrôles source/capacités réussis. Après le dernier ajustement
  de confidentialité du widget et du signal d’arrivée, **53 contrôles workspace**
  passent séparément; **25 contrôles de capacités iOS** passent dans la suite.
- **47 tests Node** d’archivage EAS et de symboles passent sur fixtures locales.
  Aucun vrai poids ni archive de livraison ne sont préparés par ces tests.
- Swift 6.2, conteneur existant sans réseau et dépôt monté en lecture seule :
  **31 schémas fermés**, **107 contrôles Tool Host**, **44 contrôles de boucle**,
  **307 contrôles de transactions**, **35 contrôles alarmes**, **57 contrôles
  traduction** et **78 contrôles documents** passent après les derniers correctifs.
  La matrice du broker couvre les trois actions interactives, confirmation,
  journal avant transmission, erreur native, reçu malformé, annulation du broker
  et de la tâche, refus sûr, annulation explicite, redémarrage et double callback.

Les tests de politiques et de broker utilisent des doubles de services Apple;
ils ne déclenchent aucune alarme, caméra, traduction ou composition réelle.

L’accès SSH fourni par Alexis a permis de vérifier le Mac réel : Darwin x86_64,
Xcode 26.3, Swift 6.2.4 et SDK simulateur iOS 26.2. Le contrôle
`scripts/check-native-workspace.sh` compile les sources réelles du workspace,
des nouveaux services/broker/App Intents et des deux extensions en objets
simulateur optimisés, concurrence Swift 6 stricte et avertissements bloquants.
La dernière exécution termine avec exit0 sur les trois objets. Les 38 fichiers
transférés (sources et script) sont inventoriés par SHA-256; le contenu
du candidat local concorde avec cet instantané après compilation.
Ce contrôle utilise le SDK disponible; il ne remplace pas le prérequis Apple
Silicon/SDK iPhoneOS 27.1 de la compilation complète CoreAI.

CoreAI/Tokenizers, le pont Objective-C++ complet et l’intégration Expo de
SceneDelegate restent à compiler ensemble sur l’hôte cible. Les métadonnées
App Intents extraites, les profils/signatures des trois produits, App Group,
WeatherKit, permissions et fonctionnement physique iPhone restent à qualifier.
La [checklist appareil](native29-iphone-acceptance.md) décrit ces portes.

Build28 reste la dernière livraison selon les preuves historiques. Aucun
lancement EAS, archive signée, upload, OTA, changement de compte Apple ou
déploiement du lecteur Ubuntu v2 n’a été réalisé. Cette tranche ne corrige pas
les avis de dépendances résiduels consignés dans le rapport de stabilisation.
