# Assist 1.0.0 (13) — correction des callbacks vocaux

État du 16 octobre 2026 : le compte EAS **ales27** est confirmé sur l'offre
**Starter**. La [compilation signée 13](https://expo.dev/accounts/ales27/projects/assist/builds/8a84b33f-6a07-4d0e-b1c9-2777594616cf),
profil `testflight`, est **`FINISHED`** et son journal confirme
**`ARCHIVE SUCCEEDED`**. Son contrôle préalable a exécuté avec succès les
**9 contrôles natifs**, les **128 tampons synchrones et ordonnés** et les
**2 contrôles négatifs**. L'IPA produite a été inspectée; ses métadonnées,
conteneurs de signature et droits de distribution correspondent aux contrôles
décrits ci-dessous. Une compilation native complète sans signature avait déjà
réussi avec le SDK iPhoneOS **27.1**, après **284 tests JavaScript**.

La [soumission de cette build précise](https://expo.dev/accounts/ales27/projects/assist/submissions/7d0fe28a-0cbf-47d4-8939-61268e0cbb5f)
a été effectuée une seule fois et est **`FINISHED`** depuis le
**16 octobre 2026 à 23:32:50.703 UTC**. App Store Connect confirme **1.0.0 (13)
`VALID`**, non expirée, avec l'état interne **`IN_BETA_TESTING`** : elle est
disponible en TestFlight interne. Les consignes de test `fr-CA` et `en-US` ont
été écrites puis relues à l'identique.

L'état externe reste **`READY_FOR_BETA_SUBMISSION`**; aucune revue externe,
invitation ou modification de groupe de test n'a été effectuée. La reprise
physique des permissions et du microphone doit encore confirmer la résolution
des deux crashs sur iPhone. Les échecs de quota, de CLI et d'archivage antérieurs
sont conservés ci-dessous comme historique.

## Deux crashs observés dans la build 12

Les deux rapports fournis par l'utilisateur concernent `org.27pm.assist`,
version **1.0.0 (12)**, sur `iPhone17,1` sous iOS **27.2 (24B5110a)**. Ils
terminent l'application au premier plan par `EXC_BREAKPOINT (SIGTRAP)` :

| Heure locale du rapport | Thread déclencheur | Frontière observée |
| --- | --- | --- |
| 16 octobre, 17:30:40 −04:00 | 6 | Callback d'autorisation Speech : `closure #1 in AssistVoice.startListening(_:completion:)`, appelé par TCC |
| 16 octobre, 17:32:02 −04:00 | 7 | Callback du microphone : `closure #3 in AssistVoice.beginCapture(_:)`, appelé par `AVAudioNodeTap::CheckEmitBuffer()` |

L'UUID Mach-O de l'IPA 12 contrôlée,
`BEAB5555-351A-3511-A70A-CAE6B7B8B54E`, correspond aux deux rapports. Le
diagnostic porte ainsi sur le binaire livré, et non sur une autre compilation
portant seulement le même numéro de version.

Les deux piles passent par `_dispatch_assert_queue_fail`,
`_swift_task_checkIsolatedSwift` et
`swift_task_isCurrentExecutorWithFlagsImpl`, immédiatement avant la closure
Assist. Elles établissent un échec du contrôle d'isolation de l'acteur à
l'entrée de callbacks invoqués sur une file système différente.

Les closures avaient été créées dans les méthodes `@MainActor` d'AssistVoice.
Leur contexte lexical pouvait donc leur faire hériter de cette isolation,
même lorsque leur corps ne lisait aucun état de l'acteur avant de créer une
`Task`. Un `Task { @MainActor … }` placé dans le callback ne corrige pas ce
problème : l'assertion peut interrompre le programme avant son exécution.
Cette frontière correspond au mécanisme décrit par
[SE-0423](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0423-dynamic-actor-isolation.md),
à la motivation de
[SE-0463](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0463-sendable-completion-handlers.md)
et au
[cas de compilation sans accès à l'état isolé](https://github.com/swiftlang/swift/issues/75856).

Dans le second rapport chronologique, le thread principal se trouve aussi
dans `AVSpeechSynthesisVoice.speechVoices()` pendant la construction d'un état.
Ce n'est pas le thread déclencheur : cette pile simultanée n'établit pas un
autre crash de synthèse vocale.

## Correctif préparé

Le nouveau fichier
[`AssistVoiceCallbacks.swift`](../mobile/ios/Assist/Voice/AssistVoiceCallbacks.swift)
construit quatre callbacks au moyen de fabriques explicitement
`nonisolated`, avec des types de retour `@Sendable` : autorisation Speech,
permission du microphone, résultat de reconnaissance et tap audio.

Les récepteurs de l'autorisation, de la permission et de la reconnaissance
restent explicitement `@MainActor @Sendable`. Les callbacks système convertissent
leurs résultats en valeurs avant de rejoindre l'acteur : booléen de permission,
texte, indicateur final et message d'erreur. Les objets de résultat Speech ne
sont pas transmis à la tâche de l'acteur.

Le tap conserve son traitement synchrone : il ajoute le tampon au même
récepteur audio, sur la file du callback, puis retourne. Il ne crée aucune
tâche par tampon et ne transfère pas de PCM vers MainActor ou JavaScript.
Le récepteur conserve son exception `@unchecked Sendable` étroite et documentée;
le propriétaire arrête le moteur et retire le tap avant de terminer ou libérer
la requête.

Le callback de notification est également construit dans une fonction
`nonisolated` avec un retour `@Sendable`. La livraison par
`NotificationCenter` reste configurée sur `OperationQueue.main`; l'accès
synchrone à l'état passe ensuite par `MainActor.assumeIsolated`. Cette
précondition repose sur la file explicitement demandée à l'API, et non sur
une supposition concernant les callbacks Speech ou audio. Les méthodes du
délégué de synthèse sont déjà `nonisolated`.

Les quatre sites d'appel d'
[`AssistVoice.swift`](../mobile/ios/Assist/Voice/AssistVoice.swift)
utilisent ces adaptateurs et le nouveau fichier est inscrit dans les sources
de la cible Xcode. Le correctif conserve les contrôles de session, d'annulation,
de permissions et de premier plan. Il ne change ni les exigences de
reconnaissance sur appareil, ni la locale stricte `fr-CA`, ni le parcours
half-duplex; aucun fournisseur ou chemin réseau n'est ajouté.

## Vérifications et livraison

| Frontière | État au présent relevé |
| --- | --- |
| Tests JavaScript | **284 réussis** |
| Contrats statiques de la voix | **8 réussis** |
| Banc natif de callbacks sur files de fond | **9 contrôles réussis**, avec **128 tampons audio synchrones et ordonnés**, dans le contrôle préalable de la build signée actuelle |
| Contrôles négatifs reproduisant l'héritage d'acteur | **2 réussis** dans ce même contrôle préalable : chaque ancien callback déclenche le piège d'isolation attendu, code de sortie **133** |
| Compilation native complète EAS sans signature | Profil `ios-compile`, **`FINISHED`**, SDK iPhoneOS **27.1**, Swift 6/arm64, `BUILD SUCCEEDED`; son profil personnalisé n'exécute pas le banc natif |
| Typecheck des deux fichiers vocaux corrigés | Réussi, Swift 6.2.4 / concurrence stricte / SDK iPhoneOS 26.2; vérification complémentaire, pas une archive complète |
| Signature App Store | Nouveau certificat Apple Distribution et profil associés par EAS, validation Apple réussie; aucune ressource existante révoquée ou supprimée |
| Compilation signée `testflight` 13 | [Terminée sur le projet payé](https://expo.dev/accounts/ales27/projects/assist/builds/8a84b33f-6a07-4d0e-b1c9-2777594616cf), **`FINISHED`**, **`ARCHIVE SUCCEEDED`** |
| IPA 13 et métadonnées embarquées | **12 296 563 octets**, métadonnées, conteneurs et droits inspectés; limites cryptographiques précisées ci-dessous |
| Soumission EAS de la build 13 | [Terminée](https://expo.dev/accounts/ales27/projects/assist/submissions/7d0fe28a-0cbf-47d4-8939-61268e0cbb5f), **`FINISHED`**, une seule soumission par identifiant exact, configuration automatique TestFlight désactivée |
| Réception et traitement App Store Connect 13 | **`VALID`**, version **1.0.0 (13)**, non expirée, `usesNonExemptEncryption = false` |
| Disponibilité TestFlight de la build 13 | **Interne : `IN_BETA_TESTING`**; externe : `READY_FOR_BETA_SUBMISSION` |
| Consignes « What to Test » | `fr-CA` et `en-US` écrites, relecture exacte confirmée pour chaque locale |
| Reprise physique des deux crashs | Permissions Speech et dictée microphone sur la build 13 encore à qualifier |

Le banc natif compile le fichier d'adaptation utilisé par l'application,
appelle ses callbacks depuis des files de fond et vérifie les récepteurs
sur MainActor. Le test du tap vérifie l'ajout de 128 tampons sur la file
d'origine, dans l'ordre et avant le retour du callback. Les deux contrôles
négatifs réintroduisent séparément l'ancien callback d'autorisation et l'ancien
tap : ils se terminent chacun par le piège d'isolation attendu, avec son
diagnostic. Le banc ne demande aucune permission et n'ouvre pas le microphone.
Il est intégré à la CI macOS et au contrôle préalable EAS; ce dernier a passé
dans un essai historique avant son échec de compilation Swift, puis **à nouveau
dans la build signée actuelle**. **Le profil personnalisé `ios-compile` ne
l'avait pas exécuté** : ses journaux ne contiennent
ni invocation du script, ni résultats des neuf contrôles ou des deux pièges
attendus. Les tests JavaScript du hook utilisent des doublures; ils ne
remplacent pas ce banc natif.

### Compilation complète sur le projet Starter

Le candidat de livraison est maintenant relié au projet EAS du compte Starter
par sa configuration d'application. La branche dédiée
[`codex/local-voice-build-13`](https://github.com/ales27pm/assist/tree/codex/local-voice-build-13)
porte le commit `232327c12ea623042ae0e018c7d1b3eab8de058d`; la contrainte de
CLI est désormais `>=24.14.0 <26`. Le projet Xcode du candidat reste en
**1.0.0 (13)**. Après la livraison, le workspace de travail est également porté
au numéro **13**, avec la configuration EAS du projet payé. Le commit source de
la build livrée reste celui indiqué ci-dessus.

La [compilation EAS](https://expo.dev/accounts/ales27/projects/assist/builds/fd89f176-1797-4ccf-b6a2-55a00a36c5c6), profil
`ios-compile`, est **`FINISHED`** sur ce commit. La relecture indépendante de
son journal confirme :

- `npm run check` : typecheck TypeScript, ESLint, **15 suites et 284 tests
  réussis**, puis génération du bridge iOS.
- Compilation de `AssistVoice.swift` et `AssistVoiceCallbacks.swift` pour la
  cible **Assist**, ainsi que de `AssistCoreAI.swift` et `RCTNativeAssist.mm`.
- Swift **6**, cible **arm64 / iOS 27.1**, SDK iPhoneOS **27.1**, puis
  `** BUILD SUCCEEDED **`.
- Signature désactivée explicitement par `CODE_SIGNING_ALLOWED=NO`.

Cette preuve dépasse le typecheck isolé sur SDK 26.2 : l'app native complète
compile avec le SDK requis. Elle ne démontre ni une archive signée, ni une IPA
distribuable, ni une installation ou un fonctionnement vocal sur iPhone.
Elle n'ajoute pas non plus une nouvelle exécution du banc natif de callbacks.

### Archive signée et inspection de l'IPA 13

La [build signée](https://expo.dev/accounts/ales27/projects/assist/builds/8a84b33f-6a07-4d0e-b1c9-2777594616cf),
profil `testflight`, est **`FINISHED`** sur le même commit
`232327c12ea623042ae0e018c7d1b3eab8de058d`. Son journal de contrôle préalable
contient les trois résultats explicites : neuf contrôles natifs réussis avec
récepteurs MainActor et 128 tampons synchrones ordonnés; ancien callback
d'autorisation piégé sur l'isolation de l'acteur, sortie 133; ancien tap audio
piégé pour le même motif, sortie 133. Le journal d'archivage termine par
**`ARCHIVE SUCCEEDED`**.

L'IPA téléchargée a une taille de **12 296 563 octets** et le SHA-256 :

```text
4b3f591a4b0ca4f6a0b1263f6ccd1cb5db6061349640f8cdd47301e1d77ffa01
```

Son exécutable arm64 porte l'UUID Mach-O
**`23C2F6C4-D6CD-3395-9DFE-E2EF3D245183`**. L'inspection retrouve
`org.27pm.assist`, **1.0.0 (13)**, minimum iOS **27.1**, les deux descriptions
d'utilisation microphone/Speech et `ITSAppUsesNonExemptEncryption = false`.
Elle ne trouve ni poids Gemma, ni `.mlpackage`, ni `.safetensors` dans l'IPA.

Les contrôles de structure passent : `LC_UUID`, `LC_CODE_SIGNATURE`, conteneur
de signature et `CodeResources` présents; droits `get-task-allow = false` et
`beta-reports-active = true` dans le binaire et le profil, avec identifiants
d'application cohérents et suffixe attendu. La signature CMS du profil a été
vérifiée par OpenSSL avec `-verify -noverify`, dans un répertoire temporaire
restreint, sans afficher les identifiants Apple ou le contenu du profil.

Ces contrôles **ne valident pas la chaîne de confiance des certificats Apple**.
La présence du conteneur Mach-O et ses droits ont été inspectés, mais les hashes
de signature du code exécutable n'ont pas été vérifiés cryptographiquement.
Cette inspection ne prouve ni installation, ni lancement, ni fonctionnement
audio ou hors réseau sur iPhone.

La [soumission EAS de cette build exacte](https://expo.dev/accounts/ales27/projects/assist/submissions/7d0fe28a-0cbf-47d4-8939-61268e0cbb5f)
a été lancée une seule fois, avec `--id` et `--no-auto-testflight-setup`. Elle a
terminé à **23:32:50.703 UTC**, état **`FINISHED`**. Le contrôle App Store
Connect avec gardes d'identité confirme la même application, la version
**1.0.0 (13)**, `processingState = VALID`,
`internalBuildState = IN_BETA_TESTING`,
`externalBuildState = READY_FOR_BETA_SUBMISSION`, `expired = false` et
`usesNonExemptEncryption = false`.

Les consignes « What to Test » ont été écrites pour les deux locales demandées,
puis leur texte relu exactement. Les empreintes SHA-256 de ces textes relus sont :

| Locale | Relecture exacte | SHA-256 |
| --- | --- | --- |
| `fr-CA` | `true` | `10f4e51a49d769c54b523525c98293076b967048af728edb3947a15f66cacf3d` |
| `en-US` | `true` | `ce574cfede25a2f50a5a61ae12e0b697a64e11d0a57e39df1db9475fd87b89fa` |

Aucune revue bêta externe n'a été demandée, aucun groupe de test modifié et
aucune invitation envoyée. La disponibilité interne ne prouve pas que la build
est installée sur l'iPhone, ni que les deux déclencheurs de crash ont été rejoués
avec succès.

### Historique des essais avant cette compilation

| Candidat et essai historiques | Preuve |
| --- | --- |
| Candidat corrigé de cette étape | `84adbd9d17ef2c5e1fce6d9ba44e0f323433f8cf` |
| Version visée | `1.0.0 (13)` |
| Essai d'archive avant correction de l'étiquette | [06731915-fd43-4b3d-9784-4f46f9fd3a48](https://expo.dev/accounts/27pm/projects/assist/builds/06731915-fd43-4b3d-9784-4f46f9fd3a48), état `ERRORED` |
| Commit de cet essai | `170b74f873b1eda49971848d8ef7f0f300e75535` |
| Preuve native de cet essai | Neuf contrôles positifs, 128 tampons et deux contrôles négatifs réussis |
| Nouvelle commande pour le candidat corrigé | Refusée par le quota; aucun identifiant de build créé |
| Numéro historique dans le workspace à cette étape | `12`; porté ensuite à `13` après la livraison confirmée |

Le seul diagnostic Swift de cet essai historique d'archive apparaît à
`AssistVoice.swift:179`, répété deux fois : l'appel à
`AVAudioApplication.requestRecordPermission` exige l'étiquette
`completionHandler:`. Elle est maintenant explicite dans le workspace et
l'instantané de livraison, au commit candidat indiqué ci-dessus. L'appel
d'autorisation Speech conserve sa signature sans étiquette. Les **huit
contrats statiques** ont repassé après cette correction. La compilation native
complète sur le projet Starter l'a ensuite compilée avec succès.

La commande de compilation suivante avait été refusée avant création d'une
build parce que le quota gratuit de compilations iOS était atteint. Le service
annonçait un renouvellement le **1er novembre 2026**. Il ne s'agissait ni d'une
compilation en file d'attente, ni d'une nouvelle erreur Xcode. La reprise de
livraison était alors en attente de la décision de l'utilisateur sur ce blocage. Ce constat
historique précède la confirmation du compte Starter décrite plus bas.

La création d'un second compte gratuit n'a pas été effectuée : les
[conditions Expo](https://expo.dev/terms) interdisent l'inscription par un agent
et plusieurs comptes sans paiement pour une même personne ou entité.
La machine macOS existante répond maintenant en SSH; le relevé actuel donne
`x86_64`, macOS 15.7.9, Xcode 26.3 et SDK iPhoneOS 26.2. Elle ne satisfait pas
les prérequis du projet. Aucune modification ou relance de cette VM n'a été faite.

Cet instantané initial est conservé hors du workspace, dans un dépôt Git autonome et
propre, avec les objets vérifiés par `git fsck` :

`/home/ales27pm/.local/share/assist-release-candidates/voice13-84adbd9d`

L'inspection de son archive source comptait 202 fichiers, dont les
adaptateurs et contrôles natifs, l'étiquette corrigée et le numéro 13.
Elle exclut les secrets, IPA, rapports de crash, dépendances générées et poids
Gemma. Elle ne constitue pas une archive binaire iOS.

La livraison est maintenant vérifiée jusqu'au traitement App Store Connect et
à la disponibilité TestFlight interne. Pour une prochaine compilation, repartir
du candidat propre relié au compte payé et de la branche dédiée au commit source
indiqué; l'instantané initial ci-dessus conserve sa valeur historique. La
prochaine qualification de cette livraison porte sur l'appareil physique.

### Historique de la reprise après abonnement annoncé

L'utilisateur avait annoncé l'activation de Starter et autorisé la reprise des
compilations. À ce stade, la vérification directe de l'abonnement renvoyait encore
`price_free` pour `27pm` (propriétaire du projet) et `ales27pm` (autre compte
accessible). La nouvelle commande EAS était de nouveau refusée par le quota,
sans identifiant de build ni IPA. L'état payant du compte cible restait alors à
établir; aucun second abonnement ou changement de facturation n'avait été lancé.
Le nom du compte portant Starter avait été demandé pour résoudre ce décalage.

Après la nouvelle demande explicite de compiler et soumettre sur EAS, une
nouvelle tentative sur le même candidat a encore été refusée avant création.
La commande officielle `eas account:usage` confirmait `27pm` en Free avec
**15/15 compilations iOS utilisées**; le compte personnel `ales27pm` était aussi
en Free avec 0/15. Aucun build 13 actif ou terminé n'était trouvé, et App Store
Connect ne voyait pas de build 13. La compilation et la soumission étaient alors
bloquées à la frontière de facturation du compte propriétaire `27pm`.

Une vérification complémentaire du candidat corrigé a réussi :
`AssistVoice.swift` et `AssistVoiceCallbacks.swift`, transférés avec empreintes
identiques, ont été vérifiés par `swiftc -typecheck -swift-version 6
-strict-concurrency=complete`, cible `arm64-apple-ios27.1`, sur la VM existante
avec Swift 6.2.4, Xcode 26.3 et SDK iPhoneOS 26.2. Sortie 0, aucun diagnostic.
Le seul répertoire temporaire créé pour les sources et caches a été supprimé.
Ce contrôle ne compile pas Core AI, ne produit aucune IPA et ne remplace ni
l'archive complète avec SDK 27.1, ni les essais sur iPhone.

Le [premier essai EAS](https://expo.dev/accounts/27pm/projects/assist/builds/baf4e4ed-ddfa-481d-9ce1-729e1b554b8d)
s'est arrêté avant l'archive : les neuf contrôles positifs passaient et le
contrôle négatif sortait avec 133, mais son stderr vide empêchait le script
d'identifier le motif du piège. Le correctif du banc signe ad hoc son seul
exécutable temporaire avec le droit de débogage nécessaire au backtracer macOS
et configure `SWIFT_BACKTRACE` uniquement pour les processus négatifs enfants.
Il ne change pas la signature ou les droits de distribution de l'app.

Une [relance sur l'ancien instantané](https://expo.dev/accounts/27pm/projects/assist/builds/e5898965-1040-4701-8ccd-897417c86e16)
a été annulée, état `CANCELED`, sans IPA. L'essai d'archive échoué et le candidat
corrigé alors non compilé sont distingués dans le tableau historique ci-dessus.
Aucune IPA de ces essais interrompus ou échoués n'a été soumise à Apple.

Les tests JavaScript utilisent une doublure du module natif. Les contrôles
statiques inspectent les contrats du code; ils n'exécutent pas Swift. Le
passage du banc natif ne démontre pas à lui seul le bon fonctionnement du
microphone, des autorisations système ou de la reconnaissance sur iPhone.

## Reprise sur appareil à qualifier

Installer la build **1.0.0 (13)** disponible en TestFlight interne, puis reprendre
les deux déclencheurs observés : l'autorisation Speech lorsqu'elle doit être demandée, puis une
dictée produisant plusieurs tampons audio. Ne pas effacer de données utilisateur
pour préparer l'essai. Si une permission déjà accordée empêche de rejouer le
premier cas, consigner cette limite ou utiliser un environnement de test prévu
à cet effet.

Vérifier ensuite les résultats partiels et finaux, l'arrêt pendant une
autorisation différée, l'arrière-plan, le verrouillage, les interruptions et
les changements de route. Une autorisation tardive ne doit pas rouvrir le
microphone après annulation. Le retour dans l'app ne doit pas reprendre une
ancienne dictée ou phrase. La lecture facultative et les essais hors réseau
restent dans le
[protocole physique](local-voice.md#qualification-physique-à-exécuter).

Consigner la build réellement installée, l'appareil, iOS, les permissions,
la voix et les observations. Sans cette reprise sur appareil, décrire la
correction comme validée au niveau des callbacks et de la compilation selon
les preuves obtenues, sans déclarer les deux crashs résolus en production.

### Reprise du build GitHub sur le compte Starter

La capture utilisateur du 16 octobre à 19:01 montre une compilation en file
prioritaire, profil `testflight`, environnement `production`, depuis `main` au
commit `43641a4`. Ce commit contient la version **1.0.0 (11)** et aucune couche
vocale : il ne livre pas le correctif 13. L'identité du projet de cette nouvelle
compilation et son état final ne sont pas établis par la session CLI actuelle.
L'utilisateur a été informé de l'annuler pour éviter une compilation inutile.

Le candidat corrigé a été publié sur la branche dédiée
[`codex/local-voice-build-13`](https://github.com/ales27pm/assist/tree/codex/local-voice-build-13).
La première lecture distante confirmait son SHA
`84adbd9d17ef2c5e1fce6d9ba44e0f323433f8cf` et confirmait que `main` restait à
`43641a4033044cce243cbe26dcb5d65ec04fd1b9`. La publication utilise un refspec
explicite vers cette seule branche. Le diff a été contrôlé sans contenu sensible,
artefact support privé ni poids modèle; `git diff --check`, `git fsck` et les
huit contrats statiques vocaux réussissent.

La session CLI était encore `ales27pm`, alors que la capture de l'abonnement
désignait `ales27` comme compte Starter. Une connexion officielle EAS par appareil
a ensuite permis de confirmer le compte payé. Aucun jeton n'a été copié,
exporté ou demandé. Pour une compilation GitHub, le sous-dossier de base reste
`mobile` et les profils de compilation et de soumission sont tous deux
`testflight`. La seule publication des sources ne constituait pas une
compilation ni une soumission supplémentaire.

L'essai GitHub `65d544e1-5548-4965-abe8-297fb64f35ec` a terminé
**`ERRORED` pendant la préparation** : la CLI choisie automatiquement était
**25.1.1**, alors que le profil imposait strictement **24.14.0**. Il n'a pas
compilé l'app ni produit une IPA. La plage `>=24.14.0 <26` du candidat actuel
admet cette CLI; le succès du profil `ios-compile` décrit plus haut est une
preuve distincte et ultérieure.

### Préparation de la signature sur le projet payé

Une première tentative du profil store a été refusée **avant création d'une
build**, car les ressources de signature n'étaient pas configurées pour ce
projet payé. La procédure normale EAS a associé au projet la clé App Store
Connect existante disposant du rôle Admin. Le client configuré a ensuite
vérifié l'identité de la même application Apple : build 12 `VALID` et
`IN_BETA_TESTING`, build 13 absente lors de ce contrôle. Aucune clé privée n'a
été affichée ou exportée.

Le certificat déjà enregistré dans EAS était encore dans sa période de
validité, mais n'apparaissait pas dans l'inventaire Apple consulté. Celui-ci
comptait cinq certificats de distribution : trois de l'ancien type iOS et deux
du type moderne. Une création par défaut dans l'ancien type a échoué sur sa
limite. Aucune révocation ou suppression n'a été effectuée pour contourner ce
refus. Une invite de révocation est aussi apparue dans le terminal utilisateur;
l'arrêt par **Ctrl+C** a été demandé, sans autorisation de révoquer les
certificats existants.

La création d'un **nouveau certificat Apple Distribution moderne a ensuite
réussi**. EAS a créé et associé le profil de provisionnement App Store pour
Assist; son contrôle de validité des ressources auprès d'Apple renvoie
**`true`**. Aucun certificat ou profil existant n'a été révoqué ou supprimé,
et aucune clé n'a été exportée.

La signature est donc **configurée et validée**. La compilation `testflight`
`8a84b33f-6a07-4d0e-b1c9-2777594616cf` a ensuite terminé sur `@ales27/assist`, au commit
`232327c12ea623042ae0e018c7d1b3eab8de058d`. Les ressources distantes ont été
validées avant l'envoi de l'archive source. L'état final est **`FINISHED`** et
l'IPA a été inspectée selon les limites décrites plus haut. La soumission de
cette seule build a terminé; Apple confirme `VALID` et la disponibilité en
TestFlight interne. Les consignes françaises et anglaises ont été relues
exactement. Les essais physiques de correction des crashs constituent une
étape séparée encore nécessaire.
