---
version: alpha
name: Assist
description: "Assistant conversationnel iPhone local, cercle et graine dans une interface française sobre."
colors:
  primary: "#2455DC"
  onPrimary: "#FFFFFF"
  background: "#F8F9FC"
  surface: "#FFFFFF"
  text: "#18202E"
  muted: "#536078"
  danger: "#AB263B"
typography:
  sans: { fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", fontSize: "16px", lineHeight: "24px" }
  display: { fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", fontSize: "34px", lineHeight: "42px", fontWeight: 500 }
  caption: { fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif", fontSize: "12px", lineHeight: "18px" }
rounded: { control: "12px", bubble: "16px", surface: "20px", pill: "24px" }
spacing: { gutter: "24px", section: "34px", group: "21px", icon-gap: "13px", small: "8px" }
components:
  button: { backgroundColor: "{colors.primary}", textColor: "{colors.onPrimary}", height: "52px", rounded: "{rounded.control}" }
  settings-row: { textColor: "{colors.text}", height: "64px" }
  settings-row-stacked: { height: "84px" }
  composer: { backgroundColor: "{colors.surface}", textColor: "{colors.text}", height: "52px", rounded: "{rounded.pill}" }
  caption: { textColor: "{colors.muted}", typography: "{typography.caption}" }
  error: { textColor: "{colors.danger}" }
---

# Assist — contexte de conception

## Overview

Assist est un produit React Native pour les personnes qui veulent converser en français sur leur iPhone avec un moteur local. Son registre est celui d'un outil personnel : comprendre l'état, écrire, écouter et reprendre la main. Le français employé et la voix canadienne ne constituent pas une étude de marché ni une promesse de disponibilité géographique.

La référence acceptée est le **cercle fermé et la graine verticale séparée**, dans [la planche retenue](design/references/assist-share-final.png). La géométrie signe l'identité ; les actions gardent des formes familières. Accueil, conversation, réglages, modèle, diagnostics et mode vocal partagent la même grammaire.

**Propriété des tokens : Model B.** [appearance.tsx](mobile/src/appearance.tsx) possède les couleurs et `AppearanceProvider` fournit le thème ; [uiGrammar.ts](mobile/src/uiGrammar.ts) possède dimensions et échelle typographique. Ces sources alimentent [uiPrimitives.tsx](mobile/src/uiPrimitives.tsx), puis les écrans. Ce document reflète les valeurs acceptées sans générer de CSS ou de tokens. Les longueurs `px` du frontmatter décrivent les mêmes unités logiques que les nombres React Native ; elles ne remplacent pas les sources d'exécution. Toute évolution commune doit modifier le propriétaire, ses consommateurs et ce miroir ensemble.

## Colors

Les couleurs du frontmatter décrivent Natif clair ; le tableau donne les trois mappings d'exécution exacts. Les rôles gardent leur sens : l'accent indique action ou sélection ; `danger` indique erreur ou action destructive. Les réponses de l'assistant restent sur fond ouvert, même si un token historique `assistantBubble` existe.

| Rôle `theme.colors` | Natif clair | Graphite | Bleu profond |
| --- | --- | --- | --- |
| background | #F8F9FC | #101113 | #09172E |
| surface | #FFFFFF | #191B1F | #0E2140 |
| surfaceRaised | #F0F3F9 | #25282E | #172D50 |
| text | #18202E | #F5F5F2 | #F3F7FF |
| muted | #536078 | #B6BAC2 | #AFBFD8 |
| border | #7C869A | #767E8A | #7E96B8 |
| separator | #DCE2EC | #30353D | #243F64 |
| accent | #2455DC | #FFB52B | #83ADFF |
| onAccent | #FFFFFF | #1B160C | #09172E |
| userBubble | #E8EEFF | #333841 | #2861D7 |
| userText | #18202E | #F5F5F2 | #FFFFFF |
| assistantBubble | #EDF1F8 | #202328 | #102A4D |
| composer | #FFFFFF | #1D2025 | #0E2444 |
| placeholder | #627089 | #AFB6C0 | #B6C6DF |
| danger | #AB263B | #FF9EA7 | #FF9AA7 |
| dangerSurface | #FFF0F2 | #3C2028 | #3D2035 |
| chip | #EDF1F9 | #2D3036 | #183258 |
| activeSurface | #E9EFFF | #3A2F1B | #153869 |

## Typography

Police système native, sans téléchargement de fonte. Titres de page **34/42, graisse 500** ; titres de phase **24/32** ; sous-groupes **16/24, graisse 600** ; texte courant **16/24** ; valeurs **14/20** ; légendes **12/18**. Les titres peuvent revenir à la ligne. Dynamic Type, les accents et les textes longs doivent rester lisibles, sans réduire la police pour reproduire une image.

## Layout

Marge horizontale **24 pt**, axe commun à gauche, groupes espacés de **8, 13, 21 et 34 pt**. Les insets utiles de 16 pt restent possibles : la suite de Fibonacci n'est pas une règle imposée à chaque distance. Shell centré, largeur maximale 760 ; mise en page iPhone étroite conservant le défilement et les zones sûres. Cibles **44 pt minimum**, actions **52 pt minimum**, lignes **64/84 pt minimum**, intervalle icône/texte **13 pt**. Les `height` de composants du frontmatter décrivent ces minima, qui grandissent avec le contenu. La saisie peut atteindre **144 pt**, avec un contour de **1 pt**.

## Elevation & Depth

Surfaces tonales et séparateurs, sans ombre décorative. Le groupe de réglages et la préparation peuvent avoir une surface ; le contenu du modèle, ses lignes d'import et les diagnostics restent ouverts. Les détails techniques sont repliables. Le mode vocal conserve une navigation compacte et des commandes principales persistantes en bas.

## Shapes

Rayons : contrôle **12**, bulle **16**, surface **20**, saisie arrondie **24 pt**. Le signe existant `AssistantMark` mesure **48 pt** à l'accueil et **28 pt** près d'une réponse ; diamètre extérieur / hauteur de graine = **φ = (1 + √5) / 2**. Son contour reste fermé, sa graine verticale et distincte. Ce rapport est une construction graphique, sans preuve d'utilisabilité attachée.

## Components

`ScreenHeading`, `ActionButton`, `SettingsRow`, `Disclosure` et `SurfaceGroup` sont les propriétaires partagés. `InterfaceIcon` utilise des tracés de 24 pt à trait de 2 pt ; les contrôles portent le nom accessible. Le signe reste décoratif. Pression, sélection, focus et indisponibilité doivent rester distincts ; une erreur conserve du texte explicatif. Les indicateurs reflètent une opération réelle, sans animation ambiante ajoutée.

## Do's and Don'ts

- Conserver les trois thèmes, les mêmes axes, le brouillon et des libellés français décrivant l'action.
- Garder une action principale claire et un texte d'assistant ouvert, y compris en vocal.
- Éviter motifs de géométrie en fond, gradients décoratifs, silhouette de « Q », marques copiées et disponibilité native inventée.
- Vérifier le miroir des tokens, les états et les thèmes à chaque changement commun ; les anciennes notes d'audit ne qualifient pas une nouvelle révision. Le comportement est défini dans [UX-CONTRACT.md](UX-CONTRACT.md).
