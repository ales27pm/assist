# Assist 1.0.0 (16) — mode vocal automatique local

Rapport opérationnel local; ne pas copier automatiquement dans le dépôt public.

## Portée

Candidat isolé : `/home/ales27pm/.local/share/assist-release-candidates/voice16`.
Base livrée : `0559d7b1e38815d0e938be4fad0dfbd8f44045ad` (build15).
Branche : `codex/voice-mode-build-16`. Source finale et livraison à renseigner après contrôle.

L'écran Mode vocal remplace la dictée et le switch intégrés au chat. Boucle locale capture → texte final → génération → lecture progressive → nouvelle capture. Lecture ON par défaut, choix persistant UserDefaults dans Réglages. Brouillon clavier conservé; aucune lecture automatique du chat clavier. Arrêts et identités des sessions séparent les commandes différées; les interruptions système demandent une reprise explicite.

La détection de fin de tour est une heuristique de stabilité du texte et de faible niveau audio (900/1800/2200ms selon fin de phrase), avec repli textuel2200ms et absence de parole15s. Ce n'est ni un VAD neuronal ni une compréhension sémantique. L'interruption se fait par bouton; micro et TTS alternent, sans barge-in acoustique ni AEC qualifié. Aucun nouveau poids speech embarqué.

## Validation avant archive

- Premier contrôle complet : TypeScript, ESLint sans avertissement, 457 tests22suites et Codegen iOS PASS. Contrat statique8PASS.
- Course TTS idle avant ACK reproduite, corrigée et couverte; aucune réactivation après erreur/annulation/nouvelle capture.
- Revue indépendante : fermeture/Réglages masquaient l'erreur d'arrêt natif. Corrigé en attendant pause puis en naviguant uniquement si l'arrêt est confirmé; 4 régressions supplémentaires PASS. Le contrôle final du candidat exact passe **461tests22suites**, TypeScript, ESLint sans avertissement et codegen. Preuve : `/tmp/assist-speech16-candidate-check-final.log`.
- Quatre sources vocales : typecheck Swift6strict arm64-iOS avec SDK26.2 PASS (contrôle supplémentaire, pas une archive SDK27.1).
- Aperçu RN Web explicitement simulé :144combinaisons (320/375/430px ×568/750px ×3thèmes ×8phases), aucun débordement horizontal/bouton hors viewport. Texte long défilant, commandes fixes, callbacks simulés et agrandissement texte1,5× PASS; zéro erreur JS. Fixtures et serveur temporaire supprimés.
- Preuves : `/tmp/assist-speech16-layout-results.json`, `/tmp/assist-speech16-listening.png`, `/tmp/assist-speech16-speaking.png`, `/tmp/assist-speech16-paused.png`. La copie de lecture a ensuite été précisée pour nommer le bouton Interrompre.
- Aucun appareil disponible via agent-device/adb; xcrun indisponible sur l'hôte Linux. Aucune preuve native déduite des mocks ou de l'aperçu. Pas de modification/restart du téléphone ou de la VM.

## Livraison

EAS16 pas encore lancé à la création de ce rapport. Compte ales27 Starter confirmé; build15 FINISHED et Apple VALID/IN_BETA_TESTING; build16 absent avant lancement. Ne pas confondre ces états avec la livraison16.

## Qualification physique requise

Installer la version16 une fois disponible, charger le modèle local, ouvrir Mode vocal, faire trois tours sans Envoyer. Vérifier pauses/hésitations, transition lecture→écoute, bouton Interrompre, pause/reprise/fermeture, retour Réglages en pause, lecture ON par défaut puis choix OFF conservé après relance, autorisations, arrière-plan/verrouillage/routes, brouillon clavier préservé, hors réseau et30min de stabilité. Qualifier séparément VoiceOver, Dynamic Type et latences. iOS27.2 requis par le chargeur Gemma; aucun support SE2 ni qualité équivalente ChatGPT/Gemini annoncé.

## Lancement unique

- Source finale : `a4e6449224d70ff5d668817c93763b47a97a5272`, publiée sur la branche dédiée. Checkout candidat propre.
- Paquet EAS inspecté :220fichiers,4126330octets; quatre nouveaux modules présents et identiques. Aucun secret/profil/IPA/crash/log/rapport privé/node_modules/fixture de revue.
- [EAS16](https://expo.dev/accounts/ales27/projects/assist/builds/ab6b0fb2-2b90-4f84-8dad-0ca42a27a483), demande créée une seule fois sur ales27 Starter, profil testflight, numéro16. Compilation en attente/en cours; aucune soumission16 faite à cette étape.

## Pré-install natif EAS16

Contrôles frais Apple Silicon PASS :9callbacks natifs,128frames synchrones ordonnées,2pièges d’isolation attendus exit133,8cas de mesure PCM et9cas de file TTS. Aucun microphone ni synthèse réelle utilisé par ces harnesses. L’archive complète SDK27.1 reste distincte.

Audit indépendant du patch : aucun appel réseau, endpoint, analytics, téléchargement, asset/modèle ou dépendance ajouté. La reconnaissance locale obligatoire et le choixfr-CA sont conservés; UserDefaults est déjà déclaré CA92.1. Cette revue ne prouve pas l’absence de trafic réel.

## Archive signée16 vérifiée

- EAS FINISHED à2026-10-17T01:06:43.524Z; source exacte a4e6449224d70ff5d668817c93763b47a97a5272, marqueur ARCHIVE SUCCEEDED présent.
- IPA `/tmp/assist-voice-build16.ipa` : 12352464octets, SHA-256 `84c3230f25c57ecb1482fe76897da8da36f12d5b10e1bd88d245a3407e4a2e4f`.
- UUIDarm64 : `DCAF8D6E-428B-3B5B-A0A6-7493A7D0E7E5`.
- Info.plist : org.27pm.assist,1.0.0(16), minimum27.1, SDKiphoneos27.1/Xcode2710, descriptionsmicro/Speech, chiffrement non exemptfalse.
- CMSprofil, CodeResources, signatureMach-O présente et entitlementsdistribution concordants; get-task-allow=false, beta-reports-active=true. Aucun poidsGemma/paquetML/safetensors embarqué.
- Limites : chaîneApple et hashes complets du code non cryptographiquement vérifiés; aucune preuve d’installation/audio par cette inspection seule. Résultat `/tmp/assist-voice16-ipa-verification.json`.
- Soumission exacte16 demandée une fois; acceptationApple en attente à cette étape.

## Livraison finale confirmée

- Soumission `25f5e835-521c-42aa-a177-23a9bb15688f` FINISHED à2026-10-17T01:09:28.506Z, reliée exactement à EAS16.
- Apple1.0.0(16) VALID / IN_BETA_TESTING, non expirée, chiffrement non exemptfalse; externeREADY_FOR_BETA_SUBMISSION. Aucune invitation, groupe ou revue externe ajouté.
- Notesfr-CA/en-US écrites et relues exactement : `/tmp/assist-paid-build16-asc-final.json`.
- NuméroXcode original synchronisé de15à16 uniquement après cette disponibilité. Candidat propre et branche publiée au SHA exact a4e6449224d70ff5d668817c93763b47a97a5272. Changements préexistants du workspace préservés.
- Livraison via EAS et workflow Codex TestFlight Release. Validation physique micro/TTS/tours automatiques, VoiceOver, Dynamic Type, hors réseau et stabilité encore à réaliser sur iPhone; aucune équivalence ChatGPT/Gemini ni latence acoustique revendiquée.
