# Assist 1.0.0 (31) — préparation de livraison TestFlight

Alexis a demandé « Proceed », puis explicitement « Use EAS » après la préparation du diagnostic avancé. Cette instruction autorise une seule nouvelle build groupée 31 via le profil EAS `testflight`, suivie de l'inspection des artefacts avant la soumission TestFlight de cette app existante. Aucun second lancement payant, modification de compte/signature, OTA ou publication App Store de production n'est inclus.

## Périmètre du candidat

- Diagnostic avancé local dans 16 catégories : niveaux standard/détaillé/désactivé, détail limité à 15 minutes, traces opaques, trois sessions bornées, export explicite et purge avec invalidation des callbacks en attente. Le suivi de performances existant reste distinct.
- Classification fermée des rejets ToT et erreurs natives ; distinction entre préparation refusée avant tout outil et action dont le reçu est absent. Les données privées du plan ne sont pas journalisées.
- Lecture vocale ouverte seulement après du texte public, conservation des reçus réels et annulation sans reprise automatique. Corrections de l'attribution météo et de ses états tardifs.
- Même Gemma complet 32K, moteur unique et préparation ToT privée bornée à deux passages. Aucun nouveau modèle de récompense, décodage contraint ou repli qui exécuterait un outil pendant la préparation.

Le nouveau journal doit aider à investiguer les prochains incidents sans devoir recompiler pour changer son niveau de détail. Ajouter une sonde native absente nécessitera toujours un nouveau binaire. Les essais sur la build 30 ont montré des rejets ToT ; ils ne démontrent pas que le candidat 31 réussit désormais ces demandes naturelles.

Les six configurations Debug/Release de l'app, Partage et Widget portent 31 ; la configuration Expo et les runtimes embarqués déclarent `1.0.0-native31`. Le profil `testflight` conserve l'import des modèles et packs signés : aucun poids complet, secret ou clé privée n'entre dans Git ou l'archive EAS.

## Vérifications et frontières

Les résultats sources du diagnostic sont consignés dans [son rapport](advanced-diagnostics-implementation.md) : 1 966 tests JavaScript, 175 contrôles du recorder, 755 des projections, 141 du ToT, 404 du broker et cinq fixtures Swift acceptées par TypeScript. Les nouveaux fichiers sont reliés à la cible App seulement et les quatre contrôles de diagnostic restent indépendants de l'admission d'inférence.

Après passage à 31, `npm run check` est relancé sur les valeurs réellement embarquées ; les contrôles d'archive/symboles et de préflight sont aussi rejoués. Les sorties finales sont conservées sous `/home/ales27pm/.local/share/assist/releases/1.0.0-31-preparation/`.

Le recorder, les relais et la classe d'intégration complète ont été compilés en Swift 6 strict sur le Mac, avec émission de l'en-tête Objective-C et consommation Objective-C++. Le point d'entrée système était isolé dans cette preuve de glue ; elle ne compile ni le vrai MetricManager iOS 27 ni Core AI. Le Mac accessible dispose d'Xcode 26.3/SDK 26.2. La compilation complète appartient au profil EAS normal sur son image Xcode 27.1, dont le préflight vérifie les versions et l'architecture réelles.

## Chaîne prévue

1. Commiter et pousser les seuls fichiers du candidat dans `feature/private-web-research`, en conservant le checkout principal indépendant.
2. Vérifier la copie réellement produite par le client EAS installé depuis ce commit propre : inventaire, empreintes, absence de secrets/poids/liens et taille de l'archive.
3. Lancer une seule build `testflight`, credentials distants gelés, sans auto-submit. Conserver son identifiant et sa révision ; observer son état sans relance automatique.
4. Après export, vérifier l'IPA exact, les trois produits/signatures/profils, runtime/canal/source, déclarations de confidentialité, ressources et trois dSYM liés aux exécutables et au hash de l'IPA exporté.
5. Soumettre ce même identifiant EAS après inspection, puis vérifier l'état Apple du numéro 31. Ne pas déduire la disponibilité TestFlight d'un seul reçu EAS.
6. Qualifier sur l'iPhone le nouveau diagnostic, la reprise après incident, l'annulation/arrière-plan, le moteur et les outils avec des demandes naturelles. Un inventaire d'appareil ou un lancement CoreDevice ne remplace pas ces essais.

Ce document décrit la préparation. Les reçus EAS, artefacts, résultats de soumission et constats appareil sont conservés séparément avec leurs dates et empreintes ; aucun résultat futur n'est présumé ici.
