# Assist 1.0.0 (12) — voix locale et TestFlight

> Mise à jour après essais : deux crashs réels ont été signalés dans les callbacks
> Speech et audio de cette build. Le diagnostic et le correctif sont suivis dans
> [le dossier du build 13](voice-testflight-13.md). Les preuves de compilation
> et de livraison ci-dessous restent celles de la build 12.

Livraison du 16 octobre 2026. Le parcours vocal Apple `fr-CA` et l'interface
présente dans le workspace ont été réunis dans une copie isolée de livraison.
Le répertoire de travail conserve ses autres modifications; aucun push ni
déploiement public n'a été effectué.

## Compilation et correction

La [première tentative](https://expo.dev/accounts/27pm/projects/assist/builds/4a7ba271-9c1d-47d5-a606-33fce18c4485)
a échoué pendant la compilation Objective-C++ de `RCTNativeAssist.mm` : le
header Swift généré expose `AVSpeechSynthesizerDelegate`, mais AVFoundation
n'était pas importé avant ce header. Les trois erreurs Clang provenaient de
cette déclaration. Les sources Swift avaient compilé. Aucune IPA de cette
tentative n'a été soumise.

L'import `AVFoundation/AVFoundation.h` précède désormais `Assist-Swift.h`.
Un contrôle de régression vérifie ce contrat d'inclusion.

La [compilation corrigée](https://expo.dev/accounts/27pm/projects/assist/builds/7e4e5b48-e865-4947-b14e-15a631c8a2c0)
du commit de livraison `13770c5da854b9cee74740573aba2e9d287d9bf6`
est terminée : **`ARCHIVE SUCCEEDED`**, Xcode/SDK iPhoneOS 27.1, Release ARM64,
profil EAS `testflight`, identifiant `org.27pm.assist`.
Ce commit est conservé dans la copie isolée; il n'a pas été ajouté à `main`
dans le workspace partagé.

## IPA et réception Apple

L'IPA vérifiée fait **12 295 585 octets**, SHA-256 :

```text
b6f1010f943275551574a3af00a7afc9815f7152d55045c5619267028529efa5
```

Son plist confirme version `1.0.0`, build `12`, minimum iOS `27.1`, les deux
descriptions d'accès micro/parole et `ITSAppUsesNonExemptEncryption = false`.
Le module vocal, la signature Mach-O, les ressources de signature et le profil
embarqué sont présents. Le profil indique `get-task-allow = false` et
`beta-reports-active = true`. Cette inspection Linux ne constitue pas une
validation complète de la signature de chaque composant par iOS.

Gemma n'est pas embarqué : son import local habituel reste nécessaire et son
chargeur exige toujours iOS 27.2+. Aucune nouvelle compatibilité SE2 n'est
revendiquée.

La [soumission exacte](https://expo.dev/accounts/27pm/projects/assist/submissions/0af69eb4-5e96-4d41-8f99-017a9c42ffe0)
est `FINISHED`. Une lecture indépendante d'App Store Connect confirme :

| État de la build 1.0.0 (12) | Résultat |
| --- | --- |
| Traitement Apple | `VALID` |
| TestFlight interne | `IN_BETA_TESTING` |
| Externe | `READY_FOR_BETA_SUBMISSION` |
| Expiration | Non expirée |
| Chiffrement non exempt | `false` |

Aucun groupe externe, invitation de testeur ni demande de Beta App Review
externe n'a été ajouté par cette livraison.

Les consignes **What to Test** ont été enregistrées pour `fr-CA` et `en-US`
sur cette seule build, puis relues à l'identique par l'API Apple. Elles couvrent
les permissions, le brouillon avant envoi, la lecture facultative, les arrêts,
le cycle de vie et l'essai en mode Avion. Empreintes SHA-256 du texte relu :

```text
fr-CA  1af872b35f92731295a5905e0afb03d8d33144a6dd540061b880c0bb4e7f3604
en-US  c3b8b5cece437db657ba5904876fc49ae014f34cf7089d9b11af440fa4a4ed64
```

## Vérifications et limites

La copie de livraison passe typecheck, ESLint, les **283 tests JavaScript** et
Codegen. Sept contrats statiques vocaux passent après le correctif d'import.
Les sources vocales et le compositeur du workspace ont été comparés à la copie
de livraison. Le numéro de build du workspace est maintenant 12.

`npm audit --omit=dev` reste en échec avec 20 entrées transitives high et
aucune critical, liées à l'avis préexistant `GHSA-vfj7-8cjw-p6xm` sur `braces`.
Les versions/résolutions de ces paquets et les dépendances de production sont
identiques à la base du lot; la voix n'ajoute aucune dépendance. Ce relevé
n'est donc pas un audit de sécurité vert.

La compilation et la disponibilité TestFlight ne démontrent pas encore le
fonctionnement du micro, l'accent, l'arrêt audible, la mémoire avec Gemma ou
l'absence de trafic réseau sur iPhone. Exécuter le
[protocole vocal physique](local-voice.md#qualification-physique-à-exécuter)
avec les ressources système installées et le modèle local chargé.
