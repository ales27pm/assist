# Assist — iPhone interface directions

**Current implementation:** see the [iPhone UI system refinement](iphone-ui-system-refinement.md), [DESIGN.md](../DESIGN.md) and [UX-CONTRACT.md](../UX-CONTRACT.md). Reference captures are collected under `iphone-ui-system/`; they predate the integrated native/voice release and do not prove its current device behavior. Stale generated verification reports from the earlier source revision are intentionally not included. Re-run `npm run check` and `npm run preview:build` from `mobile/` for source and preview-build validation; browser measurements require a separate fresh capture. The [shared-reference refinement](shared-reference-refinement.md), its [target image](references/assist-share-final.png) and the [whole-system redesign](whole-system-redesign.md) document preceding revisions.

## Archive of earlier directions and checks

The directions, captures, geometric construction and verification statements below describe earlier revisions. They remain as design history; they do not establish the appearance or verification state of the current sources.

`assist-iphone-directions.png` is a visual reference generated with the built-in Imagegen tool. The user selected all three directions: Natif clair, Graphite and Bleu profond. The app implements these as session appearance choices. The image is a design reference, not an app runtime asset or proof of native inference.

All conversation content in this board is illustrative and is labelled as an example. The app's optional example view stays separate from real conversation history, inference requests and qualification reports.

## Final generation prompt

Use case: ui-mockup
Asset type: high-fidelity visual direction board for Assist, a French iPhone conversational AI assistant. This must be actual carefully designed UI screens, not an isolated logo, clay sculpture, illustration, marketing landing page, infographic about AI, or code screenshot.
Primary request: create THREE structurally distinct, polished iPhone app UI proposals side by side on one clean neutral presentation board, large and legible, equal screen sizes. Use real iPhone portrait proportions with very slim device outlines, no perspective, no hands. Small editorial captions ABOVE the phones, verbatim: '01 — Natif clair', '02 — Graphite', '03 — Bleu profond'. Board title small: 'ASSIST / DIRECTIONS D’INTERFACE'.
Shared product scope: a personal on-device chat assistant called Assist. No fake performance metrics, cloud claims, client logos, or fabricated history. These are concept screens; place small 'Maquettes · contenu d’exemple' caption on the board. Native engine not configured: a compact understated chip on each screen says 'Modèle à configurer'. Do not show a loaded model, internet search, microphone, attachment or tools that are not implemented.
All three screens: authentic iPhone safe areas and readable status bar; top bar with Assist and a small new-chat compose icon; main conversation surface; user message bubble exactly 'Aide-moi à clarifier cette idée.'; assistant response exactly 'Bien sûr. Quel résultat aimerais-tu obtenir ?'; a subtle 'Exemple' label attached to the sample exchange; persistent composer near the bottom with exact placeholder 'Écris ton message…', a clearly named send affordance, and discreet response options. One small button 'Modèle' opens configuration. No permanent three-tab dashboard on these concept screens. Emphasize the actual conversation, not an onboarding headline.
Proposal01: native-feeling crisp off-white iOS interface, refined compact system sans-serif, precise dark ink type, restrained ultramarine action accent, flat surfaces, outstanding spacing and clear conversational hierarchy. Message bubble light neutral, assistant response elegantly typeset, very minimal chrome. No decorative hero.
Proposal02: confident graphite-black interface, premium utilitarian approach, larger editorial sans-serif type, generous but useful negative space, white assistant text, smoke-gray user bubble, one restrained warm amber send action. Composition distinctly different: model chip in a slim top toolbar, conversation as a strong left-aligned column, dark floating composer.
Proposal03: deep ink navy interface with subtle electric-cobalt structural panels, original precise geometric brand signature, fine high-contrast typography and purposeful blue action color. Modern personal assistant with conversation framed in a soft inset area and compact controls. Distinct layout from02, no glowing orb, no gradients that impede contrast, no sci-fi dashboard.
Art direction: exceptional mobile product design, clean visual rhythm, readable French text, disciplined alignment, realistic typography and consistent icons within each route. All controls comfortably touchable and plausible to implement in React Native. Large screenshot-style UI details dominate the image. No 3D rendered ornaments, no notebook metaphor, no serif headline, no lime-green palette, no beige terracotta palette, no generic SaaS cards. Deliver a single wide high-resolution comparison board with all three UI screens fully visible and sufficient room for each screen's text.

## Implemented UI captures

`assist-light.png`, `assist-graphite.png` and `assist-blue.png` are unmodified browser captures of the React Native UI at 390 × 844. The example is explicitly illustrative; no native model inference was available. These captures do not establish an iPhone build or device behavior.

## Infographic Artist rules and this iteration's UI contract

The rules below were checked against the local canonical Infographic Artist implementation. Its [repository README](/home/ales27pm/infographic-artist/README.md:3) identifies the Python package and Hatchable export as distinct implementations. These source rules are design guidance; reading the source does not establish the live plugin's deployment state.

The explicit rules used for this iteration are:

- Define measurable invariants for the grid, module, angle, density and rest zone before making variations; use functional typography as a stable anchor ([core.py](/home/ales27pm/infographic-artist/python/core.py:378)).
- Build a clear reading order and deliberate rest zone, and test the first point of attention at thumbnail size ([hierarchy exercise](/home/ales27pm/infographic-artist/python/core.py:1488), [composition criterion](/home/ales27pm/infographic-artist/python/core.py:1569)).
- Begin in monochrome, add a functional color tied to the promise, then check contrast and reproduction ([palette rule](/home/ales27pm/infographic-artist/python/core.py:486)). Keep the idea legible through monochrome, reduction and blur ([evaluation focus](/home/ales27pm/infographic-artist/python/core.py:448)).
- Construct a compact mark with one primary mass and useful counterform; avoid decorative details that collapse at 24 px and test it at 12, 24 and 48 px ([symbol rules](/home/ales27pm/infographic-artist/python/core.py:360)). These sizes concern graphic marks, not body text or touch targets.
- Derive the work from the brief. Transfer methods without borrowing a reference's silhouette, letter construction, color combination, negative-space device or composition ([anti-copy rule](/home/ales27pm/infographic-artist/python/core.py:499), [server instructions](/home/ales27pm/infographic-artist/python/contract.py:9)).
- Defend decisions with observable reading order, reduction and production behavior, rather than adjectives ([evidence rule](/home/ales27pm/infographic-artist/python/core.py:1590)).

The following numbers and component choices are **our UI adaptations**, not dimensions prescribed by Infographic Artist. They form a measurable implementation contract for this iteration; they are not a claim that all device checks have passed. The shared type contract covers the main `App.tsx` UI, `ConversationIntro.tsx` and `AppearancePicker.tsx`; it does not claim that every diagnostic panel has been migrated to the scale.

| Area | Assist implementation contract | Verification |
| --- | --- | --- |
| Spacing | Use a 4 pt spacing grid and common 24 pt horizontal gutters for the header, conversation and composer. The intro-only geometric composition below has explicit Fibonacci spacing exceptions. | Compare corresponding alignment edges and component spacing in source and current captures. |
| Typography | One functional scale: caption 12/18, label 14/20, body 16/24, title 28/36 and compact header 24/32; values are font size/line height in pt. | Check the component tokens and wrapping at the target viewport. |
| Icons | Repeat a coherent 20–24 px icon grammar with a uniform 2 px stroke at a 24 px design size. | Compare optical sizes and strokes; distinguish icon size from the interactive target. |
| Assistant mark | Use the same simple mark across themes, retaining its recognizable core at 12/24/48 px in monochrome and inverted forms. | Inspect the browser-rendered reduction artifact and each theme; this provides browser evidence, not native-device rendering or recognition by human participants. |
| Color | Reserve the accent for primary actions and selected states; use neutral treatments for secondary controls. | Inspect semantic color roles, monochrome hierarchy and contrast in all three themes. |
| Supporting controls | Give suggestion chips 12 pt corners; distinguish them from the 16 pt message bubbles and 24 pt composer corners. Use the separate `separator` color for the decorative example divider. | Compare the current example view across themes. The divider is decorative; it is not a substitute for the required visible label or a control boundary. |
| Model setup | Use a neutral rounded container and an explicit visible **Modèle** label, followed by the real engine state. Preserve readable wrapping at narrow widths. | Exercise the route into configuration and verify that unavailable-engine text remains truthful. |
| Composer proportion | Set the empty message input's minimum height to 52 pt alongside a 52 × 52 pt send control; let the input grow with content up to its 144 pt maximum. | Measure the empty and multiline states. The browser preview uses `field-sizing: content` on the message textarea to emulate intrinsic native layout; the native result remains unverified. |
| Hierarchy | Make conversation and composition the main activity; keep model configuration, appearance and supporting controls quieter and identifiable. | Inspect reading order in full-size and thumbnail captures, then exercise the controls separately. |
| Theme consistency | Preserve Natif clair, Graphite and Bleu profond with shared spacing, typography, icon geometry and control behavior. | Compare the same UI state in all three themes. |

Infographic Artist's numeric image critique is based on deterministic pixel measurements, including balance, saliency, edge density, contrast and reduction stability ([scoring implementation](/home/ales27pm/infographic-artist/python/core.py:1464)). Its own [method note](/home/ales27pm/infographic-artist/python/core.py:1503) says these measurements do not replace human judgment or user testing. A pixel critique score is therefore not an Assist usability score, accessibility certification or native-device validation.

The separate [contrast evidence](/tmp/assist-infographic-contrast.json) calculates 57 requested opaque token pairs from `appearance.tsx`, with a source hash recorded in the JSON. It checks normal text at 4.5:1 and the requested non-text border combinations at 3:1. The decorative `separator` is excluded from those boundary checks. Disabled and pressed opacity, native rendering and whole-app WCAG conformance are outside this calculation.

The previous **8.4/10 provisional agent UX audit predates this iteration**. It must not be presented as a score for the revised interface. No new UX score has been established for this iteration yet.

### Geometric introduction: a finite construction

The latest introduction uses a small decorative seal inspired by sacred geometry. Its frame is 144 pt wide and `144 / φ` pt high, where `φ = (1 + √5) / 2`. Three centered pairs of outlined circles repeat the same construction: each next diameter is the previous diameter divided by φ, and the two centers in each pair are separated by that pair's diameter divided by φ. The resulting diameters are approximately 89, 55 and 34 pt; the corresponding center separations are approximately 55, 34 and 21 pt. The 34 pt Assist mark remains the foreground anchor.

This is a **finite self-similar pattern** with three levels. It is not an infinite fractal, an exact vesica piscis or a mathematical golden spiral. In particular, a vesica piscis requires the distance between equal-circle centers to equal their radius; this construction instead uses diameter divided by φ. Fibonacci ratios approach φ, but the dimensions here are calculated from φ rather than described as exact Fibonacci integers.

The introduction's top spacing is 34 pt, followed by 21 pt from seal to title, 13 pt from title to supporting text, 21 pt to the suggestion chips, and an 8 pt chip gap. These are deliberate exceptions to the general 4 pt grid; ordinary controls, chat layout, readable type and touch targets keep their functional dimensions. The seal appears only in the empty conversation introduction and uses the same geometry in Natif clair, Graphite and Bleu profond. It is decorative, has no touch action, and supplies no accessibility label.

These proportions express an artistic direction requested by the user. They do not establish intuitive use, readability, accessibility or a measurable usability advantage. Those properties require the separate layout and interaction checks described below.

The refreshed `verification.json` includes this seal's source hash and current browser measurements: the frame and successive diameters match φ within subpixel rounding, all six rings remain contained, and the same geometry fits 320/390 px views in all three themes. The draft actions still work; the ornament disappears for the illustrative exchange and returns with the introduction. Earlier composer and keyboard checks are retained separately with their preceding-revision scope.

### Current verification

The current geometric introduction captures are [Natif clair](assist-intro-light.png), [Graphite](assist-intro-graphite.png) and [Bleu profond](assist-intro-blue.png); `assist-intro.png` repeats the light introduction. The refreshed example captures are `assist-light.png`, `assist-graphite.png` and `assist-blue.png`. `assist-appearance.png` shows the unchanged appearance sheet from the preceding revision. `assist-symbol-reduction.png` is a browser test sheet constructed from the actual mark geometry, not an app screen or native-device capture.

The [verification record](verification.json) includes source hashes, the 57 checked opaque color pairs, keyboard theme navigation and 320/390 px layout checks. The browser measured the empty composer and send button at the same 52 px height and y-coordinate; three input lines grew the composer to 96 px, long content stopped at 144 px, and clearing restored 52 px. Local checks passed 255 tests, TypeScript, ESLint, web compilation and the iOS JavaScript Metro bundle. Native compilation and physical-iPhone behavior remain unverified.
