# Architecture du prototype

## Frontières

| Couche | Responsabilité | Ce qu’elle ne prouve pas |
| --- | --- | --- |
| React Native 0.88.0 / TypeScript | Écran de qualification, requêtes et affichage des résultats | Réussite de l’inférence native |
| TurboModule iOS généré par Codegen | Contrat typé entre JavaScript et le moteur Swift | Compatibilité d’un export arbitraire |
| Swift / Core AI | Chargement local, génération, annulation, déchargement et mesures | Exécution intégrale sur l’ANE |
| Ressources Gemma importées | Graphe `.aimodel`, tokenizer, métadonnées, embeddings PLE | Provenance des poids par leur seul nom |

Le backend Swift s’appuie sur `apple/coreai-models`, révision
`9db747612f972001279f02adb04d3ef982310d0e`, produit Swift `CoreAILM`, module
`CoreAILanguageModels`. Il s’agit de Core AI, pas de l’ancien chargeur ANEMLL
Core ML. Un paquet `.mlpackage` ou `.mlmodelc` ne devient pas compatible en
changeant son extension.

Source : [paquet Swift Apple épinglé](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/Package.swift).

## Invariants à conserver

- Aucune bascule silencieuse vers une API cloud ou vers le modèle système Apple.
- Une seule opération d’inférence active. Les commandes et l’état doivent rester
  cohérents lors d’une annulation, d’un échec ou d’un retour au premier plan.
- Une réponse incomplète ou un chargement échoué n’est pas déclaré réussi.
- Le budget de sortie doit rester positif et tenir dans le contexte restant.
  Aucun plafond fixe de 32 jetons ; aucun discours sur des jetons « illimités ».
- Le contexte long est une capacité du graphe exporté, non un champ UI capable
  d’agrandir le modèle. Un export 8K n’est pas un export 32K.
- Le cache KV est un état d’inférence temporaire, pas une mémoire personnelle
  durable. Celle-ci devra être conçue séparément, sur l’appareil.
- L’arrière-plan n’est pas un service permanent d’exécution. Vérifier annulation
  et libération effective avec le protocole de qualification.

## Périmètre volontairement limité

Ce premier lot ne constitue pas encore un assistant avancé : pas d’exécution de
code arbitraire, pas d’agent autonome, pas de moteur Android, pas de migration de
monGARS. Les interfaces partagées permettent une implémentation Android future,
mais Core AI reste spécifique à Apple.

Les outils futurs devront utiliser les capacités autorisées par iOS et demander
confirmation avant les actions externes importantes. La recherche Internet peut
partir de l’iPhone ; elle ne fonctionne pas sans réseau. L’accès à Internet
n’autorise pas à envoyer les conversations à un fournisseur d’inférence.

La tranche [calendrier agentique en lecture seule](gemma-calendar-agent.md)
reste disponible. L’extension [13 outils conversationnels et OCR local](device-tool-agent.md)
réutilise le même moteur et les capacités PR2 : option explicite, aperçu natif
et accord tactile pour chaque accès, journal pour les écritures et résultat
incertain sans retry. L’OCR Apple transmet seulement du texte extrait, sans
vision générale de Gemma. Une transcription partielle ne déclenche rien.
MCP, web et l’exécution de code restent hors périmètre. Les modifications de
bridge exigent une nouvelle build native, non une OTA native27.

## Limite de la preuve matérielle

Une configuration d’accélération, un graphe compatible ou une génération réussie
ne prouvent pas l’usage de l’ANE. L’export Gemma applique notamment une opération
de soft-capping des logits côté CPU. La revendication pertinente est une charge
mesurée et attribuée aux unités réellement utilisées, pas « 100 % ANE ».

Source : [export Gemma Apple](https://github.com/apple/coreai-models/blob/9db747612f972001279f02adb04d3ef982310d0e/models/gemma4/export.py).
