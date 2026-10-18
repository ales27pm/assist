# Assist — contrat UX

Ce contrat décrit les conséquences visibles des comportements existants de l'app iPhone en français. Les frontières produit et techniques restent dans [README.md](README.md), [architecture.md](docs/architecture.md), [native-completion.md](docs/native-completion.md) et [model-restoration.md](docs/model-restoration.md). Il n'ajoute ni politique de permission ni mécanisme de conservation.

La référence visuelle est [DESIGN.md](DESIGN.md). Les tokens d'exécution restent canoniques dans `mobile/src/appearance.tsx` et `mobile/src/uiGrammar.ts` (Model B). Réutiliser les propriétaires partagés avant d'ajouter une variante locale.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Form | `App.tsx`, `SettingsScreen`, `protocol.outputBudget` | `mobile/src/protocol.ts`, `docs/native-completion.md` | Message multiligne ; limite numérique facultative avec aide et erreur associées | `App.test.tsx`, `SettingsAccessibility.test.tsx` ; clavier iPhone et brouillon |
| Select/Listbox | `AppearancePicker`, `ModelLoadProbePanel` | `mobile/src/AppearancePicker.tsx`, `mobile/src/ModelLoadProbePanel.tsx` | Groupes radio accessibles ; présentation RN, clavier web flèches/Home/End ; aucun menu natif masqué | `App.test.tsx`, `ModelLoadProbePanel.test.tsx` ; ouverture, sélection et focus navigateur |
| Scrollbar | RN `ScrollView` ; style global de l'aperçu | `mobile/preview/index.html`, propriétaires `ScrollView` de l'app | Indicateurs natifs iOS ; CSS du document d'aperçu, défilement interne des pages et feuilles | Navigateur étroit, longs contenus et styles calculés ; défilement et zones sûres iPhone |
| Navigation | `App.tsx`, `focusAccessibility` | `mobile/App.tsx`, `docs/native-completion.md` | État de session conservé au changement d'écran ; feuille Apparence ; conversation illustrative distincte | `App.test.tsx`, `SettingsAccessibility.test.tsx` ; titre de destination et restitution du focus |
| Feedback | État natif validé, textes inline et `uiPrimitives` | `mobile/src/protocol.ts`, `docs/architecture.md` | État modèle, erreurs associées, phases vocales ; confirmation iOS par RN `Alert` | `VoiceConversationAccessibility.test.tsx`, `VoiceApp.test.tsx` ; annonces réelles sur iPhone |
| Essais des outils | `SettingsScreen`, `DeviceToolsPanel` | `mobile/src/deviceCapabilities.ts`, `docs/device-tools-testing.md` | Essais manuels sans Gemma ; statut sans prompt ; consentement par capacité et confirmation iOS avant création | `DeviceToolsPanel.test.tsx`, `DeviceToolsSafety.test.tsx` ; permissions et résultats réels sur iPhone |

Les chemins de suites ci-dessus sont relatifs à `mobile/__tests__/`. La géométrie des contrôles natifs, du sélecteur de dossier, des autorisations et de la confirmation RN `Alert` appartient à iOS : c'est une variante native explicite. L'aperçu ne doit pas remplacer ces frontières par une prétendue réussite. Aucun toast, tableau ou flux CRUD distinct n'est défini par ce contrat.

## Parcours et récupération

- **Préparer le modèle :** proposer la conversation si le modèle est prêt, sinon le chargement explicite du dossier retrouvé, sinon le modèle intégré confirmé, sinon le choix direct d'un dossier. Les exigences d'import restent repliables. Un chargement en cours conserve son état réel et évite les commandes concurrentes. Le succès rend la conversation accessible ; l'échec garde une explication et une action de reprise.
- **Retrouver un dossier :** afficher son nom, sans exposer son chemin. Restaurer un signet ne charge pas le moteur et n'ouvre pas le micro. Dossier absent ou accès révoqué : demander une nouvelle sélection avec l'erreur visible. Annuler une nouvelle sélection conserve l'ancienne lorsqu'elle reste valide.
- **Écrire et naviguer :** conserver le brouillon entre les écrans, l'exemple et les réglages. Une amorce ajoute du texte modifiable sans envoyer. La limite vide reste facultative ; une valeur invalide doit pouvoir être corrigée. La commande iOS Terminé ferme le pavé numérique. Nouvelle conversation suit la confirmation d'effacement existante lorsque du contenu est présent.
- **Choisir sans exécuter :** les radios de fonction de diagnostic sélectionnent seulement ; `Tester ce graphe` déclenche le test. Les touches fléchées/Home/End changent la sélection et le focus, sans lancer d'opération native. Les radios Apparence changent seulement le thème de session.
- **Utiliser la voix :** afficher les phases existantes de préparation, écoute, stabilisation, réponse, pause, arrêt et erreur. Pause et fermeture restent explicites ; Reprendre réessaie. Interrompre apparaît pendant la préparation ou la lecture d'une réponse. Proposer l'interruption par la parole uniquement après l'armement natif réel ; le niveau audio ne remplace pas cette preuve. Aucun démarrage implicite à la navigation.
- **Comprendre les états :** conserver la réponse interrompue comme telle. Annoncer les changements de phase et les erreurs, sans annoncer chaque jeton ou mesure du micro ; éviter une seconde annonce automatique pendant la lecture de l'app. Les détails techniques restent accessibles à la demande.
- **Tester les outils :** ouvrir le panneau ne déclenche aucun appel natif. Les lectures sont explicites et bornées ; aucun résultat privé n’est ajouté à la conversation ou à un rapport. Avant une création réelle, présenter le contenu et les dates puis consommer une seule confirmation. Annulation, fermeture et arrière-plan invalident une confirmation non utilisée, mais n’annulent pas une action native déjà acceptée. Aucune relance automatique après un résultat incertain. Les outils restent indisponibles dans le navigateur.

## Accessibilité et vérification

La cible d'accessibilité est WCAG 2.2 AA avec les conventions iOS : noms accessibles en français, valeurs courantes, erreurs associées, contraste, commandes au clavier et cibles atteignables. Le changement d'écran place le focus sur son titre ; fermer l'exemple ou Apparence le rend au contrôle d'origine. Les pages longues défilent sans masquer leur action ni le champ actif.

Vérifier les six surfaces dans les trois thèmes à 320 et 390 pt, textes longs, clavier, focus, états d'attente/erreur et retour arrière. Le navigateur garde `NativeAssist` indisponible ; les suites simulant une frontière native ne prouvent ni inférence, ni autorisation persistante, ni acoustique, ni VoiceOver sur appareil. Le protocole d'essai réel reste [native-completion.md](docs/native-completion.md).

Contrôles : `cd mobile && npm run check` et `npm run preview:build`, lint de `DESIGN.md`, comparaison du miroir avec les deux sources de tokens, puis parcours navigateur et essais iPhone appropriés. Ce contrat ne rapporte aucun résultat de validation, score UX ou état de livraison.
