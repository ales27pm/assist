# Native29 — réception physique et signature

Cette checklist est un protocole de réception, **pas un rapport de tests appareil
réussis**. Aucun résultat historique de native28 ne qualifie native29.
Le catalogue source courant est `device-v3-31` (31 outils via Tool Host v2);
le pont v1 conserve les 13 historiques. `device-v2-16` est un jalon précédent.
Les implémentations et preuves courantes sont consignées dans
[le compte rendu du lot native29](native29-native-bundle-2026-10-19.md), sans
transformer une compilation partielle en résultat d’appareil.

## Avant une build payante

1. Rejouer `cd mobile && npm run check` et les harnais Swift du candidat figé.
   Vérifier la négociation exacte `device-v3-31`, le sous-ensemble figé des
   31 outils et le refus de catalogue incompatible; le pont v1 reste limité
   aux 13 outils historiques. Une capacité compilée n’accorde aucune permission.
2. Vérifier le host cible avec `bash scripts/preflight-ios.sh` : Apple Silicon,
   Xcode/SDK iPhoneOS 27.1 minimum. Le Mac de contrôle actuellement accessible
   est Intel avec SDK 26.2 : il peut typechecker les nouvelles API disponibles
   dans ce SDK, pas qualifier la compilation complète Core AI cible.
3. Obtenir les profils cohérents pour Assist/AssistShare/AssistWidget, App Group
   `group.org.27pm.assist` et WeatherKit **dans le profil et la signature principale**.
   Déclarer l’entitlement dans le dépôt ne configure pas le compte Apple.
   Ne pas révoquer/réparer automatiquement de certificat ou provisionnement.
4. Après production d’un vrai `Assist.app` signé, exécuter :

   ```sh
   node scripts/verify-ios-capabilities.mjs --app /chemin/vers/Assist.app
   ```

   Le contrôle lit les signatures/profils sans mutation. Il refuse une extension
   absente, profil expiré/debug/ad-hoc/entreprise, App ID/équipe/runtime différents,
   App Group manquant, WeatherKit non signé, ou métadonnées App Intents absentes.
   Ses tests à fixtures ne sont pas une preuve de signature réelle. Une réussite
   du contrôle n’est ni une acceptation Apple ni une preuve de fonctionnement iOS.
5. Vérifier séparément les symboles des trois produits, runtime `1.0.0-native29`,
   source, confidentialité et canal. Aucune OTA native29 vers native28.

## Appareil et identité

Consigner sans données personnelles : version/build installées, runtime, source
candidate, OS, date et mode de connexion réel. Le 19 octobre, l’inventaire du Mac
contenait un iPhone physique iOS 27.2 appairé, mais avec tunnel indisponible et
services DDI indisponibles. Une entrée « paired/available » en cache n’est donc
pas une connexion de test utilisable ni une preuve USB. Ne pas déclarer le
nouveau parcours qualifié sur cette seule base.

## Parcours à exécuter volontairement

| Parcours | Preuve attendue |
| --- | --- |
| Question sans outil | Aucun accès aux données privées, aucun appel réseau outil implicite. |
| Lieux | Demande explicite, aperçu exact du texte envoyé à Apple, refus puis accord; résultats bornés et attribution de fournisseur. Aucun GPS automatique. |
| Trajet | Origine/destination et mode vérifiés dans l’aperçu; estimation datée, aucun guidage automatique. |
| Météo | WeatherKit signé puis requête réelle; marque officielle claire/sombre, lien légal et texte d’attribution exacts, conditions datées distinctes de la consultation. |
| Attribution indisponible | Réponse et voix ne révèlent pas les prévisions; aucune marque inventée, recharge explicite seulement. |
| Outils vocaux | Tour finalisé seulement; toucher pour confirmer; JSON, marqueurs et identifiants jamais parlés; interruption sans nouvelle requête ou mutation. |
| Annulation | Interrompre à l’aperçu, pendant le réseau, pendant la génération et avant réponse; aucun ancien résultat dans un nouveau tour. |
| Admission retardée | Annuler immédiatement après envoi, avant admission native : aucun calcul après acquittement; aucune autre opération admise avant drainage. |
| Attribution tardive | Annuler pendant le chargement de la marque : ni températures de la carte ni réponse/TTS tardifs; reçu conservé sans nouvel accès réseau automatique. |
| Changement vocal | Apple fr-CA indisponible → pack FluidAudio prêt → retour au chat : capacités relues, bouton vocal utilisable, capture réelle. |
| Préférence interrompue | Sauvegarder une voix pendant inactive → active : choix natif relu sans rejouer un aperçu sonore. |
| Entrée excessive | Dépasser 4 Mio de JSON, 512 messages ou 1 Mio par message : rejet explicite sans troncature; contrôler séparément les vrais jetons jusqu’à 32K. |
| Cycle de vie | Inactive/arrière-plan, verrouillage et retour : anciennes admissions invalidées, pas de reprise automatique. |
| Alarmes/minuteurs Assist | Autorisation refusée puis accordée explicitement; aperçu figé, double tap et perte de reçu; état incertain sans retry; vérifier l’appartenance Assist avant arrêt/annulation. |
| Alerte réelle | Contrôler l’alarme sur l’iPhone, mode silencieux/Focus et durée. Un reçu de programmation ne prouve pas sa présentation. |
| Compte à rebours | Vrai `AlarmConfiguration.timer` et Live Activity AlarmKit du Widget : progression écran verrouillé/Dynamic Island, libellé générique « Minuteur Assist » et confidentialité système du décompte; titre personnalisé limité à la présentation d’alarme confirmée, pause/reprise, expiration/arrêt/annulation et relance. Aucun processus Gemma supposé actif en arrière-plan. |
| Traduction disponible | Vérifier une paire réellement installée puis traduire localement, aussi en mode Avion. Langue détectée incertaine ou paire indisponible : refus explicite, aucun faux texte ni fallback cloud. |
| Traduction à télécharger | Paire `supported` avec modèle absent : aucun téléchargement pour simple vérification ou `allow_download=false`; accord explicite puis préparation Apple au premier plan. Annuler/refuser ou passer en arrière-plan pendant préparation/traduction : aucun résultat tardif ni relance automatique; `supported` reste distinct d’`installed`. |
| Documents sélectionnés | Scanner VisionKit multipage avec caméra refusée/accordée, huit pages maximum, annulation et fermeture réelle. Importer un PDF protégé, un PDF sans texte et une image : états explicites, OCR borné et texte seulement à Gemma. Vérifier verrouillage, ID expiré, export PDF et aperçu Quick Look; aucune lecture générale de Fichiers/iCloud. |
| Composeur Apple | MessageUI absent/non configuré : refus sûr. Après aperçu destinataires/objet/texte/pièce jointe, modifier puis annuler le courriel ou SMS dans la feuille Apple; aucune expédition automatique. Tester séparément brouillon sauvegardé et envoi décidé volontairement par l’utilisateur; `queued_by_user` ne prouve ni livraison ni lecture. |
| Indexation choisie | Import seul : rien indexé. Après choix/confirmation, seul le titre et texte du document choisi deviennent recherchables dans l’index Assist protégé `.complete`. Verrouillage, recherche annulée, retrait et suppression du document : aucun résultat périmé ne rouvre son contenu. Vérifier expiration choisie (1–7 jours, plafonnée à l’inbox), purge et refus d’un ID Spotlight étranger ou expiré. |
| Siri/Raccourcis | Cinq actions réellement découvertes, ouverture au premier plan et authentification locale depuis appareil verrouillé. Leur exécution prépare seulement un brouillon, sans Gemma, caméra, traduction, téléchargement ni alarme automatiques. |
| Arrivée du brouillon | Déclencher un intent alors qu’Assist est déjà ouvert : arrivée signalée sans remplissage/envoi automatique. Charger volontairement, envoyer puis confirmer l’aperçu du broker; vérifier fermeture, absence de remplacement d’un brouillon en attente, expiration après cinq minutes et refus d’une demande Spotlight non autorisée. |
| Régressions | 13 outils historiques, OCR natif, STT/TTS, Share/Widget, import/export et rollback des reçus inconnus. |
| Ubuntu | Appairage natif secret, Tailscale, serveur absent/401/délai/annulation; source déployée identifiée. Pas de page lue prétendue sur le service v1. |

Pour chaque ligne, conserver `non exécuté / réussi / échoué`, l’identité exacte
du candidat et une observation expurgée. Ne pas enregistrer contacts, titres
privés, audio, coordonnées personnelles ou tokens dans un rapport versionné.
Ne pas transformer une alarme de test en engagement important sans vérification.

## Autorité de livraison

Cette préparation n’autorise aucun lancement EAS payant, publication OTA,
modification Developer Portal, renouvellement/révocation de certificat ou achat
de capacité. Diagnostiquer un échec avant toute relance. Le but reste une build
groupée, pas une série de tentatives payantes.

Sources : [attribution WeatherKit](https://developer.apple.com/documentation/weatherkit/weatherattribution),
[entitlement WeatherKit](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.weatherkit),
[autorisation AlarmKit](https://developer.apple.com/documentation/bundleresources/information-property-list/nsalarmkitusagedescription),
[exemple Apple alarmes et Live Activity](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit).
