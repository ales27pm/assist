# Assist — interface iPhone cohérente

Cette révision poursuit l’interface retenue dans la [référence partagée](shared-reference-refinement.md). Elle conserve le cercle fermé et la graine séparée, les trois thèmes et le moteur natif existant.

Les règles communes sont désormais rassemblées dans [DESIGN.md](../DESIGN.md) et [UX-CONTRACT.md](../UX-CONTRACT.md). Les couleurs restent définies dans `appearance.tsx` ; les dimensions et la typographie dans `uiGrammar.ts`. Ces documents reflètent les sources d’exécution.

## Changements visibles et fonctionnels

- **Accueil et conversation.** Les amorces indiquent qu’elles ajoutent du texte modifiable. L’entrée du mode vocal devient une commande compacte ; le champ de message reste le centre de l’activité.
- **Réglages.** La lecture vocale reprend la colonne d’icônes et l’axe de texte communs. Son interrupteur utilise la couleur fonctionnelle du thème. Les valeurs, les erreurs et la commande iOS Terminé sont conservées.
- **Modèle.** Un seul titre et une description adaptée à l’état. La prochaine action est explicite : conversation si prêt, chargement du dossier sélectionné, chargement du modèle intégré confirmé, sinon choix d’un dossier. Une restauration impossible propose immédiatement une nouvelle sélection. Les exigences de l’export restent repliables ; le changement de source reste disponible.
- **Diagnostics.** Les mêmes lignes ouvertes que le modèle, un seul titre de page et le retour dans la navigation commune. Les six fonctions sont directement sélectionnables, avec état coché, focus et touches fléchées/Home/End dans l’aperçu. La sélection ne lance aucun contrôle ; le bouton de test reste explicite.
- **Mode vocal.** Même titre de page et même symbole près de la réponse. Navigation compacte et commandes persistantes. Les deux actions de réponse se disposent côte à côte à 390 px et s’empilent à 320 px.

Les actions, lignes et surfaces partagent leurs dimensions : cibles de 44 pt, actions de 52 pt, lignes de 64/84 pt, intervalle icône/texte de 13 pt et rayon de surface de 20 pt. Les textes peuvent agrandir les composants. Le rapport φ reste une construction du signe ; aucune amélioration d’utilisabilité n’est déduite de cette proportion.

La portée est l’app iPhone React Native. Aucun groupe Vercel ou découpage du produit en applications web indépendantes n’a été ajouté.

## Captures navigateur

Les cinq vues ci-dessous montrent l’app réelle avec son moteur iOS indisponible, sur un aperçu construit et figé. Les captures du mode vocal utilisent le composant réel dans une présentation explicitement simulée, sans microphone ni moteur. Elles ne sont pas des captures d’iPhone.

| Vue | Natif clair | Graphite | Bleu profond |
| --- | --- | --- | --- |
| Accueil | [Capture](iphone-ui-system/entity-home-light.png) | [Capture](iphone-ui-system/entity-home-graphite.png) | [Capture](iphone-ui-system/entity-home-blue.png) |
| Exemple illustratif | [Capture](iphone-ui-system/entity-example-light.png) | [Capture](iphone-ui-system/entity-example-graphite.png) | [Capture](iphone-ui-system/entity-example-blue.png) |
| Réglages | [Capture](iphone-ui-system/entity-settings-light.png) | [Capture](iphone-ui-system/entity-settings-graphite.png) | [Capture](iphone-ui-system/entity-settings-blue.png) |
| Modèle | [Capture](iphone-ui-system/entity-model-light.png) | [Capture](iphone-ui-system/entity-model-graphite.png) | [Capture](iphone-ui-system/entity-model-blue.png) |
| Diagnostics | [Capture](iphone-ui-system/entity-diagnostics-light.png) | [Capture](iphone-ui-system/entity-diagnostics-graphite.png) | [Capture](iphone-ui-system/entity-diagnostics-blue.png) |
| Vocal — présentation simulée | [Capture](iphone-ui-system/voice-listening-light-390.png) | [Capture](iphone-ui-system/voice-listening-graphite-390.png) | [Capture](iphone-ui-system/voice-listening-blue-390.png) |

Les [commandes vocales à 320 px](iphone-ui-system/voice-speaking-light-320.png) illustrent l’empilement ; la [vue à 390 px](iphone-ui-system/voice-speaking-light-390.png) conserve deux colonnes.

## Vérification et limites

Les captures et observations de cette section décrivent la révision de l’interface antérieure à l’intégration native/vocale. Le registre généré sur cet ancien arbre de sources n’est pas livré comme preuve de la version intégrée. Relancer `npm run check` et `npm run preview:build` dans `mobile/` vérifie les sources et la compilation de l’aperçu ; les mesures navigateur doivent être refaites séparément. Les suites de composants utilisent une frontière native simulée et ne valident pas le comportement sur iPhone.

L’ancien audit statique Premium ciblé sur `mobile/` et le lint de DESIGN.md ne sont pas réexécutés par ces commandes. Aucun résultat de cet audit antérieur n’est présenté comme validation de la nouvelle release.

Cette révision ne reçoit pas de nouvelle note UX. Les anciens scores ne lui sont pas transférés. Compilation Apple complète, Dynamic Type, clavier logiciel, VoiceOver, chargement de modèle et acoustique restent à vérifier sur iPhone. Les contrôles locaux et le bundle JavaScript iOS ne prouvent pas ces comportements.
