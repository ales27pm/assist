# Assist — revue approfondie des outils, seconde passe

20 octobre 2026, worktree `assist-private-web-research`, base
`60d54a28f743ddd5ae1df47cf97b7bab49cf5b53`. Cette tranche prolonge
[la première revue du contexte](device-tool-context-review-2026-10-20.md).
Les sources précédentes et les preuves historiques sont préservées.
Les correctifs ne sont pas livrés ; aucune build EAS, OTA, soumission,
installation ou modification de service Apple n’est lancée ici.

## Défauts supplémentaires reproduits et corrigés

| Frontière | Défaillance observée dans un test ciblé | Comportement corrigé |
| --- | --- | --- |
| Stop et cycle de vie | Un EOS, une progression ou une erreur ordinaires tardifs pouvaient réapparaître après Stop ou interruption, puis alimenter les références | L’identité de génération couvre toutes les routes ; les résultats et erreurs périmés sont écartés, les erreurs courantes restent visibles |
| Feuille iOS | Un résultat reçu pendant `inactive`, avant le retour `active`, était perdu | Attente du retour au premier plan pour une interaction possédée ; Stop, arrière-plan et démontage invalident cette attente sans retry |
| Présentation vocale | Après création réussie puis second accès annulé, le reçu existait mais restait invisible en voix | Cartes du tour et texte natif interrompu visibles ; aucune synthèse ou réutilisation comme tour réussi |
| JSON ambigu | Des clés dupliquées pouvaient être interprétées avant l’affichage ou la négociation | Rejet explicite des doublons avant ces décisions |
| Courtier natif | Un second `perform` pouvait entrer pendant une suspension de permission, malgré MainActor | Propriétaire exclusif maintenu avant le premier `await` jusqu’à la sortie |
| Annulation tardive | Un callback d’annulation sans identité pouvait viser la confirmation suivante | Annulation liée à l’UUID original ; une ancienne identité ne ferme pas la nouvelle confirmation |
| Résultats composés | Une permission manquante ou une annulation ultérieure effaçait l’acquittement d’une écriture réussie | Reçus antérieurs conservés, sans prétendre annuler l’effet déjà confirmé ; issue inconnue et annulation gardent leur statut |
| Document relu | Une lecture plus récente sans texte ou protégée pouvait laisser l’ancien texte autoriser une réponse après aperçu | La dernière lecture native du même document remplace sa provenance antérieure |
| Conversion entière | `9223372036854775808` passait `<= Double(Int.max)` puis faisait trapper `Int(...)` | Borne supérieure stricte avant conversion ; reproduction dans un processus Swift de test, pas sur iPhone |
| Booléens natifs | Foundation acceptait certains nombres `0/1` comme booléens | Exigence de vrais CFBoolean pour les champs concernés ; un reçu invalide après soumission d’écriture reste incertain |

La réentrance et les terminaux composés sont exercés avec suspensions et
callbacks déterministes. La protection d’UUID tardif est testée au point
d’entrée du callback ; aucune inversion de scheduler n’est revendiquée sur
appareil. Les doubles remplacent les frameworks propriétaires, jamais les
validations et décisions de production visées par ces tests.

L’intégration complète a révélé une régression du nouveau filtre : le
préfixe partiel d’un Stop volontaire était également écarté. Le test
historique a été conservé. Seul le résultat `cancelled` de ce Stop explicite,
lié à la requête et à son époque, peut maintenant rester visible comme
texte interrompu. Un EOS tardif, un autre ID, un JSON ambigu ou trop gros,
l’arrière-plan, le démontage et l’interruption vocale ne bénéficient pas de
cette exception. Aucun texte partiel ne devient un tour complet, une
référence de contexte ou une lecture vocale.

## Vérification finale intégrée

| Contrôle frais | Résultat | Ce qu’il ne prouve pas |
| --- | --- | --- |
| `npm run check` | 1835 tests / 61 suites ; typage, lint, Codegen et contrôles de câblage/capacités passent | Modules natifs doublés ; une alerte ESLint préexistante |
| Grader | 31 tests passent | Aucun score du vrai modèle |
| Swift Mac strict | 31 schémas, 156 contrôles de boucle et 139 Host2/3 passent | Modèle et outils scriptés |
| Courtier Swift Mac strict | 404 contrôles passent | Frameworks OS remplacés par des doubles ; aucune action iPhone |
| Préparation Host3 sur Mac | 59 entrées préparées, contrat identique au corpus | Aucun modèle, outil ou permission exécuté |

Le premier contrôle intégré échoué et le contrôle final réussi sont
conservés séparément. `App.test.tsx`, contenant le test historique qui a
détecté la régression, reste inchangé. Les empreintes des sources compilées
et des sources finales sont comparées avant clôture ; les changements
indépendants préexistants restent préservés.

## Évaluation et sources primaires

Le grader précédent pouvait accepter un faux catalogue de 31 noms et ne
vérifiait pas les arguments avec le registre natif. Un JSON valide et une
sélection attendue ne suffisaient donc pas à soutenir son score. La seconde
passe raccorde les vérifications au contrat et à la validation compilés de
production. Les observations et les oracles restent séparés.

Le corpus compte maintenant **59 cas**, dont une traduction naturelle sans
indication de moteur. Le pipeline filtre les références avec le vrai module
TypeScript, construit les messages via Host3 et demande au registre Swift de
valider les appels observés. Trente et un tests du grader passent. Le Mac a
préparé les 59 entrées avec le contrat attendu, sans modèle ni outil exécuté.
Sans rapport natif correspondant aux appels, les arguments restent non
validés ; sans trajectoire complète et revue qualitative liée au texte,
les dimensions concernées restent inconnues. Les empreintes lient les
artefacts, sans authentifier leur auteur ou leur runtime.

RAGOps a aussi évalué deux **anciennes réponses réellement capturées** sur un
PDF synthétique : lecture exacte et hallucination après aperçu. Le contrôle
lexical donne respectivement 1,0 et 0,0, puis `BLOCK` historique au seuil 0,6
fixé avant exécution. Cela ne mesure ni la sémantique générale ni le candidat
actuel ; aucune comparaison avec un baseline accepté n’est inventée.

Exa a été utilisé sur trois angles : protocole Gemma, continuation/cache,
et intégration WeatherKit, avec 15 résultats demandés. Les sources retenues
sont primaires. Le [template officiel E2B](https://huggingface.co/google/gemma-4-E2B-it/raw/main/chat_template.jinja)
relu a exactement le SHA-256 déjà épinglé :
`0a2c8073c878ab1da004bee933a998606537bbb62016310352c7285c3f01c5b5`,
révision `3e22461f65e89153144f8adb70e3b8c2cc9845a7`.
Aucun remplacement du tokenizer ou du template n’est justifié par cette
vérification. Le format assistant avec appels et résultats correspond au
[protocole documenté](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4).
La [configuration WeatherKit d’Apple](https://developer.apple.com/help/account/services/weatherkit/)
confirme la distinction App Services / Capabilities ; elle ne remplace pas
un résultat météo réel sur l’iPhone.

Les skills utilisés apportent des vérifications différentes : LLM Agent
Builder pour les responsabilités du modèle et de l’hôte ; Swift Concurrency
pour les suspensions et la réentrance ; React Native pour le cycle de vie et
la présentation ; RAGOps pour les limites des décisions d’évaluation ;
Code Work pour les reproductions, l’intégration et la vérification indépendante.

## Accès et limites réels

Le Mac existant reste accessible par SSH IPv6 et compile les contrôles Swift
ciblés. Il n’apporte pas le SDK cible 27.1 ni une archive complète CoreAI.
Le plugin `xcode-mac` retourne `UNAVAILABLE` avec HTTP 429 ; Desktop Commander
annonce son appareil hors ligne ; XcodeBuildMCP n’a aucun projet ou simulateur
configuré. Aucune reconfiguration n’est tentée pour changer ces observations.

L’iPhone est annoncé en ligne par Tailscale, sans transport actif observé.
La requête CoreDevice ciblée échoue encore avec 1011. Aucun nouvel essai
fonctionnel iPhone, effet natif, OCR, Face ID ou alerte physique n’est donc
revendiqué dans cette passe.

Poids complets, contexte 32768, moteur unique et limites quatre appels/une
écriture restent conservés. L’adaptateur et son prompt ne changent pas dans
cette seconde passe ; les comparaisons de préfixe de la première revue ne
deviennent pas une preuve de cache CoreAI ou de gain de vitesse.

## Contrôle CPU du vrai dérivé : résultat non concluant

Un essai local a chargé le staging FP16 approuvé, vérifié les 275 palettes et
le PLE réels, puis appliqué le même calcul RMSNorm composite. Les trois
demandes prévues étaient météo 0/0, traduction sans indication de moteur et
aperçu documentaire. Leurs entrées Host3 sont identiques sur Mac et Linux.
Aucun oracle ni résultat de service n’est fourni au modèle.

Le processus est borné à deux CPU, 8 Gio, 7 Gio de seuil haut, zéro swap et
600 secondes, sans sockets Internet. Le journal systemd confirme l’arrêt
pour délai ; le coordinateur termine après 602,11 secondes. **Zéro des trois
sorties complètes n’a été recueilli.** Ce résultat ne prouve ni une mauvaise
sélection ni une réussite de Gemma. Les checkpoints montrent le chargement,
mais le pilote n’observe pas les phases internes de `generate` : préfill,
premier jeton et décodage partiel restent indiscernables.

L’inspection indépendante confirme `logits_to_keep=1`, déjà appliqué par
Transformers ; aucun calcul évitable de tous les logits n’est établi.
SDPA est un écart explicite avec l’ancien contrôle eager, sans preuve du
noyau CPU effectivement dispatché. Les prompts de 5500 jetons environ ne
sont pas comparables aux anciens cas de 33–56 jetons. Aucun diagnostic de
blocage, gain de vitesse ou régression numérique n’est déduit de ce délai.
Le contrôle n’est pas relancé à l’identique. Un prochain essai CPU devrait
d’abord observer les phases et conserver les jetons partiels ; la réception
du graphe CoreAI exige toujours son environnement et l’iPhone.

Preuves privées de cette tranche :
`/home/ales27pm/.local/share/assist/context-deeper-20261020/`.
Les résultats courants de vérification et du contrôle CPU sont consignés
dans les artefacts liés à cette tranche, séparément des essais historiques.
