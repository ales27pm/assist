# Diagnostic avancé embarqué — préparation du prochain binaire

Travail du 20 octobre 2026, poursuivi après minuit UTC. Point de reprise : worktree `assist-private-web-research`, branche `feature/private-web-research`, HEAD de départ `b18f705658723db4bd6b01f60b4fc932891164bb`. Les modifications locales antérieures sont conservées. Aucun commit, push, build EAS, OTA, installation iPhone ni déploiement n'est effectué pour cette tranche.

Le nouveau journal complète le suivi natif de performances déjà présent. Il doit permettre de configurer, conserver et exporter des observations utiles après un incident, sans recompiler pour modifier son niveau de détail. Une nouvelle sonde native qui ne serait pas déjà embarquée nécessitera toujours un nouveau binaire. Ce changement ne corrige pas, à lui seul, le rejet ToT constaté sur la build 30 ; il prépare une observation plus précise de sa phase, de son champ et de son motif.

## Parcours dans l'application

Réglages → Diagnostics → Diagnostic avancé. Trois niveaux : désactivé, standard, détaillé pendant quinze minutes. Le natif décide du niveau effectif et de l'expiration monotone ; l'interface ne prétend pas qu'une configuration a réussi avant sa réponse. Le niveau désactivé persiste après relance ; le niveau détaillé revient au standard après relance ou expiration. Désactiver ce journal ne coupe pas le suivi de performances historique, ni les mécanismes de diagnostic propres à iOS.

Le panneau présente les observations récentes, les constats à vocabulaire fermé, la couverture réelle et l'état de sauvegarde. L'export exige une action explicite et utilise la feuille de partage iOS. La purge est confirmée dans le panneau. Les réponses tardives après fermeture, arrière-plan ou purge ne sont pas affichées. Un ancien binaire signale l'absence de cette capacité ; il n'exécute aucun remplacement silencieux.

## Catégories enrichies et points de mesure

Toutes les catégories ci-dessous restent de couverture partielle. Une catégorie présente n'est ni un test de toutes ses fonctions ni une certification de disponibilité de son framework.

| Catégorie | Observation embarquée | Limite de la preuve |
|---|---|---|
| Moteur | Chargement, admission acceptée, passages de génération, motif d'arrêt, annulation drainée | Les rejets avant admission ne sont pas tous instrumentés ; pas de placement ANE mesuré |
| Planification | Racines et feuilles ToT, sortie EOS/frontière/longueur, validation du schéma/champ/branche | Ni texte privé du plan, ni preuve que le choix est pertinent |
| Contexte | Taille/nombre de messages, durée de préparation et tokenisation, budget effectif | Pas de contenu de message ; couverture surtout de la préparation ToT |
| Outils | Statuts réels du broker, exécution, reçu, échec sûr, résultat inconnu, annulation | Un appel du pont et un reçu métier sont deux observations différentes |
| Consentement | Attente de permission/confirmation et callback de demande de permission | Aucun argument, permis, identifiant de calendrier ou contenu d'aperçu |
| Voix | Transitions natives de préparation/écoute/lecture/échec et durées de commandes principales | Pas d'audio/transcription ; pas de mesure du naturel ni de fréquence par fragment TTS |
| Réseau | Commandes de recherche privée, appairage/déconnexion et ouverture de source | Durée, taille et erreur classée seulement ; pas d'URL, clé, corps ou preuve du réseau complet |
| Services Apple | Recherche cartographique, trajet, météo, attribution native et annulation | Le retour natif de l'image ne prouve pas son affichage React Native `onLoad` |
| Documents | Import, lecture, retrait, export, scanner/PDF/aperçu et composition via leurs vrais parcours | Aucun document, nom de fichier, chemin ni destinataire conservé |
| Traduction | Commandes natives et transitions du broker | Pas de texte source/cible ; qualité linguistique non mesurée |
| Alarmes | Commandes natives et transitions du broker | Un callback terminé ne prouve pas qu'une alarme a sonné |
| Stockage | Import/restauration des packs vocaux et mises à jour des checkpoints | Pas de contenu/chemin du pack ; erreurs du propre journal indiquées séparément |
| Pont JS/natif | Fin et durée de commandes natives ciblées, intention native ignorée explicitement | Pas de gestionnaire global JS/Hermes ni de capture des piles libres |
| Cycle de vie | Foreground, arrière-plan, actif/inactif et configuration | Ordre de livraison, sans attribuer une interruption à une cause certaine |
| Performances | Projection au plus toutes les30 secondes du moniteur existant, pression mémoire et état thermique | Budget d'allocation restant ≠ RAM libre ; pics non échantillonnés possibles |
| Système | Réception de rapports MetricKit crash/blocage/CPU/disque/mémoire/démarrage | Rapport possiblement différé, non exhaustif et sans lien automatique avec la requête active |

Les callbacks natifs instrumentés enregistrent une fin d'appel (`execution/completed`) quand le transport rend une chaîne, et non un succès métier déduit de son JSON. Le broker possède une sonde distincte sur ses statuts `success`, `failed_safe`, `outcome_unknown`, etc. Aucun reçu n'est reparsé pour fabriquer une preuve supplémentaire.

## Conservation, sûreté et coût

- Registre fermé de catégories, étapes, issues, motifs, champs et métriques numériques ; aucun champ de texte libre à enregistrer.
- Clés de corrélation originales uniquement en RAM, bornées à200 octets et64 identités ; seuls des identifiants locaux `t1`, `t2`… sont exportés. Les deux suffixes ToT sont corrélés à la même demande.
- 512 observations au maximum par session ; trois fichiers fixes (courant et deux précédents), chacun plafonné à256 Kio ; export ≤1 Mio. Saturation et rejets de métriques sont comptés.
- Écritures atomiques espacées, permissions locales restrictives, protection des fichiers sur iOS, exclusion des sauvegardes Apple. Une terminaison brutale peut perdre ce qui n'a pas encore été écrit.
- Aucun prompt, réponse, transcription, argument d'outil, URL, chemin, secret, erreur libre, tenseur, logit ou identifiant de jeton arbitraire. Aucun envoi automatique, serveur distant, `eval`, sonde active, réparation ou relance d'action.
- La file de callbacks est plafonnée à64 entrées et invalidée par une purge ou une reconfiguration. Son ticket est vérifié dans l'acteur sans suspension avant admission ; une ancienne observation ne peut réapparaître après purge.
- Les quatre contrôles sont sérialisés en ordre d'invocation, avec32 demandes en attente au maximum : une ancienne configuration ne peut dépasser une purge plus récente.
- Les sondes de transaction et du moniteur copient leur callback sous verrou puis l'appellent hors verrou. Elles ne font pas attendre UIKit, le broker ou le sampler pour une écriture disque. Les sondes d'inférence restent à des frontières bornées, avec maintien de la réservation à travers leurs attentes.
- Le moniteur existant et la logique d'exécution/confirmation gardent leur propriétaire. Le journal ne possède aucune capacité de déclencher une inférence ou un outil.

Les constats sont étiquetés observé/déduit/non mesuré. Le journal n'infère actuellement pas de blocage à partir d'une simple attente utilisateur ; `stalled` est employé pour un rapport système de blocage. L'absence d'un événement ne prouve ni l'absence d'action ni la cause d'un plantage. Le dernier composant enregistré peut être différent de celui qui a provoqué une terminaison.

## Références techniques et limites de compilation

La nouvelle API Apple [MetricManager](https://developer.apple.com/documentation/metrickit/metricmanager) fournit une séquence de [rapports de diagnostic](https://developer.apple.com/documentation/metrickit/metricmanager/diagnosticreports). Une seule instance et un seul consommateur sont conservés ; ouvrir le panneau ou revenir au premier plan n'en crée pas un autre. La projection conserve uniquement des types fermés et quelques valeurs numériques. Les déclarations Apple iOS 27 ont été consultées et archivées ; les tests de projection hors SDK n'établissent pas que le collecteur compile contre ce SDK.

Les logs système ne servent pas d'archive durable. Le journal possède ses propres checkpoints bornés. Aucun intercepteur d'exception fatale n'est ajouté au runtime React Native. La [documentation React Native sur les builds release](https://reactnative.dev/docs/debugging-release-builds) rappelle que la symbolication JS exige la source map exacte du build. Cette tranche ne revendique pas de nouveau parcours de capture/symbolication Hermes ; les dSYM existants et les rapports Apple restent des preuves séparées.

Le Mac accessible expose actuellement le SDK iPhoneOS 26.2. Il peut compiler le recorder Foundation et vérifier son interface Objective-C++, mais ne peut qualifier `MetricManager` iOS 27, Core AI, l'archive complète ou le comportement iPhone du nouveau code. Le préflight de livraison conserve l'exigence Xcode/SDK 27.1+ et Apple Silicon. Aucun contournement de ce contrôle n'est introduit.

## Vérification

Les commandes et résultats détaillés sont conservés dans `/home/ales27pm/.local/share/assist/advanced-diagnostics-20261021T000728Z` ; le contrat exact est dans `advanced-diagnostics-contract.md`. Les résultats finaux et empreintes sont consignés dans le manifeste de validation de ce répertoire.

Résultats finaux de cette tranche :

| Vérification | Résultat |
|---|---|
| Jest complet, après correction des scénarios de hooks EAS | 1 966 tests / 63 suites, tous passants |
| TypeScript, Codegen iOS | Passants |
| ESLint complet | Aucune erreur ; un avertissement préexistant dans WeatherForecastCard.test.tsx |
| Collecteur réel Swift 6 strict Linux et Mac | 175 contrôles passants, dont 40 classifications d'erreurs natives |
| Projecteur réel et recorder avec frontières de types isolées | 755 contrôles passants |
| En-tête Swift app-mode et consommateur Objective-C++ | Compilation passante sur le Mac ; appels non exécutés |
| Interop du vrai encodeur Swift vers TypeScript | 5 fixtures acceptées sans modification, dont deux archives et une purge |
| Câblage des nouveaux fichiers et contrôles natifs | 13 tests passants |
| Régressions du broker de transactions | 404 contrôles passants après ajout du relais |
| Validation ToT et métadonnées fermées | 141 contrôles passants |
| Moniteur natif existant | Harnais passant, y compris reprise après SIGKILL de son propre processus de test |

Le premier passage Jest a exposé l'absence des nouveaux contrôles dans les scénarios de hooks ; le passage complet final est vert. Une tentative dans l'image Swift minimale a aussi rencontré l'absence de Python ; le même contrôle a ensuite réussi avec le Python autonome déjà installé monté en lecture seule, sans installation ni réseau. Les journaux initiaux sont conservés.

Les contrôles portent sur les vrais acteurs Swift avec stockage temporaire injecté, le TTL, les modes, la rotation/corruption/symlinks, les quotas, la purge et ses événements tardifs, l'ordre des contrôles, les projections fermées, la validation TypeScript, l'interface et la compatibilité avec un ancien binaire. Les fixtures d'interop sont produites par l'encodeur Swift réel puis lues par le parseur TypeScript, sans réécriture de leurs valeurs.

Portes restantes du prochain binaire : compilation réelle de toutes les sources avec le SDK cible, archive signée et qualification iPhone (incident, relance, export, arrière-plan, purge, durée/énergie/mémoire du niveau détaillé). Aucun résultat de ces portes n'est déduit des tests locaux.
