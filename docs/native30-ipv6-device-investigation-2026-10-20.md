# Native30 — essais physiques par IPv6, 20 octobre 2026

La panne du fil est reproduite au-delà de la météo : cinq demandes terminées sont rejetées pendant la préparation ToT, sans génération des feuilles ni passe d'outil observée. En revanche, le panneau manuel obtient réellement un lieu Apple Maps, une prévision WeatherKit et la marque officielle sur cet iPhone. Le service météo et la préparation Gemma constituent donc deux frontières distinctes.

## Accès vérifié et périmètre

- Worktree `assist-private-web-research`, branche `feature/private-web-research`, base `b18f705658723db4bd6b01f60b4fc932891164bb`. Les modifications locales antérieures sont préservées.
- Linux → SSH IPv6 vers le Mac existant → CoreDevice en réseau local TCP → iPhone 16 Pro sous iOS 27.2, build 24B115. Mac : macOS 15.7.9, Xcode 26.3/SDK 26.2. Ceci ne qualifie pas une compilation CoreAI avec ce SDK.
- La première lecture de détails était périmée/déconnectée. Une seule requête réelle des apps a acquis le tunnel et les services développeur, sans réappairage, redémarrage ou modification des réglages.
- App installée : Assist 1.0.0 (30). Runner WDA 16.15.3 déjà signé réutilisé avec `test-without-building`, sans reconstruction d'Assist. Session de test propre `69654CFF-74F3-4500-854A-F0C8373B58FF`, `forceAppLaunch=false`, `shouldTerminateApp=false`, aucun ancien propriétaire actif.
- Modèle sélectionné observé : `gemma4-e2b-32k-group8-abliterated-rmscomposite`, contexte détecté 32 768, chargement affiché 2,48 s. Le nom et la disponibilité ne constituent pas une nouvelle vérification des hashes des poids. Ce chargement n'est pas une mesure de spécialisation à froid.

Les essais n'utilisent ni contacts ni événements personnels. Aucun événement, rappel, message, alarme ou notification n'est créé. Les deux appels Apple manuels utilisent uniquement le lieu public Québec, sans lecture GPS. Aucune permission n'est changée.

## Demandes et résultats physiques

Durées natives de préparation jusqu'au rejet, distinctes du délai total utilisateur et du temps d'automatisation :

| Essai | Profil | Jetons roots entrée/sortie | Durée roots | Jusqu'au rejet | Résultat |
| --- | --- | --- | --- | --- | --- |
| « Combien font 6 fois 7 ? » | Conversation, outils OFF | 246 / 105 | 3,228 s | 3,319 s | Rejet de préparation, brouillon conservé |
| « Quel temps fait-il ? » | Outils iOS ON | 1 649 / 102 | 3,647 s | 4,681 s | Alerte générique outils, aucune passe d'outil |
| « Recherche pour “meta-cognition” sur internet » | Outils iOS ON, conversation réinitialisée | 1 521 / 121 | 4,030 s | 4,937 s | Même rejet ; aucun appel web démontré |
| Bouton calendrier aujourd'hui | Calendrier | 423 / 13 | 0,616 s | 0,756 s | Rejet et message trompeur suggérant une autorisation |
| « Combien font 6 fois 7 ? », après annulation | Conversation, outils OFF | 246 / 105 | 3,034 s | 3,115 s | Nouvelle génération admise, même rejet ; moteur non bloqué |

Ces cinq générations roots sont étiquetées `eos` dans la build30, suivies de `tree_rejected`. Cette étiquette ne révèle toujours pas le stop exact : la frontière 50 peut aussi recevoir ce libellé. Aucun début `:tree-leaves` ni `TOOL_PASS` n'est observé. Le motif précis reste impossible à récupérer dans ce binaire ; ne pas transformer ce constat en diagnostic de JSON malformé, de longueur de champ ou de stop particulier.

Deux annulations séparées :

1. Envoi puis arrêt immédiat : `CANCELLATION_REQUESTED` → retour `ready` en environ 125 ms, avant démarrage observé de l'arbre. Ce n'est pas une mesure d'arrêt du décodage.
2. Envoi puis arrêt après 1,6 s : `THOUGHT_TREE_STARTED`, `GENERATION_STARTED`, puis annulation acquittée en environ 621 ms et `THOUGHT_TREE_CANCELLED`. Aucun premier jeton accepté n'est mesuré ; l'agrégat omet correctement ses compteurs. La requête suivante est admise sans relance de l'objectif interrompu.

Le moteur reste `ready`, l'état thermique nominal et le processus Assist observé demeure PID 4072. Aucun crash n'est consigné. Le maximum échantillonné final est 1 748 275 392 octets, pas un pic exhaustif. `memoryPressure=unknown` ne prouve pas l'absence de pression ; le budget d'allocation restant n'est pas la RAM libre. Aucune exécution ANE n'est revendiquée.

## Météo manuelle : preuve positive indépendante de Gemma

Le panneau « Documents et Ubuntu » / « Cartes et météo Apple » trouve **Québec QC, Canada**. Un seul appui sur « Météo : Québec » produit :

- coordonnées publiques du résultat : 46.8136, -71.2241 ;
- véritable marque officielle française **Apple Météo**, visible dans la capture ;
- données devenues visibles après le chargement de la marque : 8,1 °C, ressenti 6,2 °C, vent 7 km/h, condition brute `clear`, consultation vers 19:41:35 locale ;
- prévisions horaires et cinq jours affichés, bouton « Sources et attribution Apple » présent.

Il s'agit d'une consultation physique réussie, pas d'une qualification répétée de tous les lieux, thèmes, modes réseau, annulations ou restitutions Gemma. Le lien légal n'a pas été ouvert pendant cette tranche. Le texte légal complet occupe plusieurs écrans avant les prévisions : défaut de présentation effectivement observé, distinct d'un échec de WeatherKit ou de son image.

## Corrections source de cette tranche

1. **Messages de préparation cohérents** pour conversation, voix sans outils et calendrier. Le code natif fermé pré-exécution est nécessaire ; une simple absence de carte ne suffit pas. Toute activité, portée, séquence ou reçu courant conserve la gestion conservatrice existante. Une permission calendrier n'est suggérée que sur `E_PERMISSION` réel.
2. **TTS différé au premier texte public** : la construction du flux vocal démarrait auparavant une session de synthèse avant toute sortie publique, même lors d'un rejet ToT. L'annulation interdit toute construction tardive. Aucune reprise ni nouvelle génération automatique.
3. **SYSTEM final maîtrisé par l'hôte** : seuls texte fixe et mode/outil fermés y entrent ; `intent`/`condition` libres restent privés pour validation et anti-écho. La préparation roots/leaves, les budgets 192/384 et les deux passes sont inchangés. La présence des racines libres dans le SYSTEM de la passe leaves reste un sujet séparé, non corrigé ici.
4. **Attribution météo compacte** : logo et lien légal restent visibles et montés ; l'intégralité du texte légal est accessible dans une section dépliable, sans coupe ni résumé. Le vrai `Image.onLoad` reste la condition de présentation. Les [exigences Apple](https://developer.apple.com/weatherkit/) demandent la marque et le lien légal ; la propriété [legalAttributionText](https://developer.apple.com/documentation/weatherkit/weatherattribution/legalattributiontext) fournit le texte à rendre disponible lorsque la page Safari ne peut pas être présentée. La section dépliable est notre choix de présentation, pas une interface prescrite par Apple.

Ces corrections s'ajoutent au [diagnostic natif fermé préparé précédemment](native30-tree-rejection-2026-10-20.md). Elles ne démontrent pas une réparation de la production des arbres réels. Aucun parseur permissif, nouvelle tentative cachée, suppression de ToT, modèle réduit ou réduction du contexte n'est introduit.

## Validation et portes restantes

Les régressions Swift du SYSTEM final échouent avant correction, puis 126 contrôles du vrai contrôleur passent en Swift 6 strict dans le conteneur existant sans réseau. Modèle scripté seulement. Les 21 gardes source Python passent. Les nouvelles régressions UI reproduisent également les messages erronés et le démarrage TTS prématuré avant correction.

Contrôle intégré final depuis `mobile/` : **`npm run check`, exit 0**, 1 865 tests Jest / 61 suites, TypeScript, ESLint sans erreur, Codegen iOS, 54 contrôles workspace, 26 contrôles capacités et 63 contrôles d'évaluation. Un avertissement React shadow préexistant demeure. La suite Jest dure 64,844 s ; la commande complète environ 77,7 s.

Le premier contrôle intégré a échoué sur sept attentes, et son log est conservé. Deux exigeaient encore le texte légal déplié par défaut. Les deux scénarios primaires d'interruption vocale injectaient `speaking` avant tout texte public et avant `beginSpeech`, chronologie devenue invalide avec le TTS différé ; leurs promesses non résolues contaminaient ensuite trois cas via les mocks `once`. Les deux reprises de micro passaient déjà isolément avant toute correction supplémentaire. Les tests simulent désormais le vrai ordre texte public → début vocal → interruption, avec les mêmes assertions sur les premiers mots et la reprise. Un nouveau cas vérifie qu'un `speaking` prématuré est ignoré. Aucune régression applicative de reprise du micro n'a été démontrée dans cette investigation. Le second contrôle intégré passe entièrement. Les parcours météo texte et voix vérifient que l'ouverture du volet légal ne libère ni données, ni réponse, ni TTS avant `onLoad`.

Les résultats du contrôle intégré et les empreintes finales sont consignés dans `validation-summary.json` du dossier privé ci-dessous. Ils ne remplacent pas un typage CoreAI complet, une archive signée ni une nouvelle qualification iPhone du candidat.

Preuves privées : `/home/ales27pm/.local/share/assist/ipv6-device-investigation-20261020T233322Z/`. Elles comprennent requêtes/réponses WDA, captures, copies ciblées des checkpoints du moniteur, essais avant/après, logs et SHA. Aucun plan privé n'est extrait. La session de test est nettoyée en conservant Assist et les données du modèle ; seuls nos échanges/brouillons de test sont effacés et le sélecteur outils est remis à son état initial OFF. Après suppression de notre session WDA, Assist est toujours observé sous le même PID 4072. Seul notre runner Xcode est ensuite arrêté, avec propriété du processus vérifiée ; `TEST EXECUTE INTERRUPTED` correspond à cet arrêt volontaire, pas à un crash d'Assist.

**Le blocage principal ToT demeure non résolu dans l'app installée.** La build30 ne peut pas fournir la règle précise perdue ; le diagnostic Swift préparé nécessite un nouveau binaire. Les outils Gemma ne sont pas déclarés qualifiés puisque leur exécution est bloquée en amont. Le routage web du fil et le service v2 restent des travaux distincts décrits dans [l'investigation approfondie](native30-deeper-investigation-2026-10-20.md). Aucune build EAS, OTA, soumission, installation de remplacement ou modification de service n'a été lancée dans cette tranche.
