# Contrat du diagnostic avancé embarqué

Implémentation autorisée le 20 octobre 2026, complétée par la demande d'enrichir proactivement les catégories. Les changements locaux précédents sont préservés. Pas de nouvelle build, OTA, serveur ou action système autorisés par ce document.

Le journal avancé est un composant natif indépendant du verrou d'inférence, complémentaire au suivi de performances existant. Configuration locale : `off`, `standard`, `detailed`. Le niveau détaillé expire après 900 secondes monotones, même sans panneau ouvert ; il ne survit pas à une relance. Off désactive ce journal, pas le moniteur de performances historique, et reste réversible. Aucun prompt, réponse, transcription, argument, URL, chemin, secret, erreur libre, tenseur, logit ou jeton arbitraire n'est conservé.

## API native ajoutée

- `getDebugDiagnostics(): Promise<string>` : état versionné, aucune mutation d'inférence.
- `configureDebugDiagnostics(json): Promise<string>` : exactement `{schemaVersion:1,mode:"off"|"standard"|"detailed"}` ; retourne l'état effectif.
- `exportDebugDiagnostics(): Promise<string>` : bundle local courant et jusqu'à deux sessions précédentes validées ; aucun réseau ni probe.
- `clearDebugDiagnostics(): Promise<string>` : efface uniquement le journal avancé et ses archives, retourne son nouvel état. Le suivi de performances est distinct.

L'absence de ces méthodes signifie ancien binaire. Aucun fallback silencieux. Les données sont décodées et reconstruites avec une liste de champs fermée avant partage. Les réponses tardives après fermeture, arrière-plan ou purge sont ignorées.

## Schémas JSON (clés exactes)

`assistDebugStatus` : `schemaVersion:1`, `kind`, `sessionId` UUID, `revision` entier, `mode`, `detailExpiresAt` date ISO ou null, `recordCount`, `omittedRecords`, `rejectedRecords` entiers, `previousSessionCount` 0..2, `persistence` (`notAttempted|saved|unavailable`), `records` (30 derniers au maximum), `findings` (32 au maximum), `coverage` (catégories ci-dessous), `limits:{maxRecords:512,maxSessionBytes:262144,maxPreviousSessions:2,detailedSeconds:900}`, `privacy:{contentCaptured:false,automaticUpload:false}`.

`assistDebugSession` : `schemaVersion:1`, `kind`, `sessionId`, `nativeBuild`, `osVersion`, `startedAt`, `capturedAt`, `records` (512 maximum), `omittedRecords`, `rejectedRecords`. Identités locales de trace `t1`..`t2147483647`, sans identifiant utilisateur ou identifiant de requête original exporté.

`assistDebugBundle` : `schemaVersion:1`, `kind`, `exportedAt`, `status` (état), `current` (session), `previous` (0..2 sessions). Le bundle ne remplace pas le rapport historique des performances, exportable séparément.

Un `record` contient exactement : `sequence` entier, `elapsedMs` fini positif, `traceId` opaque ou null, `category`, `stage`, `outcome`, `reason` ou null, `field` ou null, `metrics` dictionnaire de nombres finis positifs à clés autorisées. Aucun champ libre.

Catégories : `engine`, `planning`, `context`, `tools`, `consent`, `voice`, `network`, `apple`, `documents`, `translation`, `alarms`, `storage`, `bridge`, `lifecycle`, `performance`, `system`.

Étapes : `admission`, `context`, `tokenization`, `roots`, `leaves`, `generation`, `validation`, `proposal`, `permission`, `confirmation`, `execution`, `receipt`, `presentation`, `cancellation`, `modelLoad`, `lifecycle`, `systemReport`, `configuration`.

Issues : `began`, `completed`, `rejected`, `failed`, `cancelled`, `unknown`, `stalled`.

Motifs : `context`, `prompt`, `budget`, `json`, `shape`, `branch`, `text`, `distinctness`, `unsupported`, `boundary`, `stop`, `length`, `deadline`, `engine`, `unknown`, `eos1`, `turn106`, `tool50`, `otherStop`, `noStop`, `typeMismatch`, `missingField`, `unexpectedKeys`, `integerRange`, `duplicateID`, `fieldTooLong`, `controlCharacter`, `reservedContent`, `permissionDenied`, `outcomeUnknown`, `imageUnavailable`, `connectionUnavailable`, `cancelRequested`, `notObserved`, `systemCrash`, `systemHang`, `systemCPU`, `systemDisk`, `systemMemory`, `systemAppLaunch`, `memoryWarning`, `thermalSerious`, `thermalCritical`.

Champs : `roots`, `leaves`, `id`, `root`, `mode`, `tool`, `intent`, `condition`, `fit`, `grounding`, `payload`, `protocol`, `output`.

Métriques : `durationMs`, `inputBytes`, `outputBytes`, `promptTokens`, `generatedTokens`, `budgetTokens`, `contextCapacity`, `messageCount`, `passIndex`, `branchIndex`, `fieldBytes`, `limitBytes`, `itemCount`, `pendingOperations`, `physicalFootprintBytes`, `availableMemoryBytes`, `cpuPercent`, `signal`, `exceptionType`, `reportCount`, `hangDurationMs`. Toutes >=0 et <=2^53-1 ; les durées/CPU peuvent être fractionnaires.

`coverage` : liste exacte des 16 catégories, chacune `{category,state:"instrumented"|"partial"|"unavailable"}`. Ce statut décrit les hooks réellement embarqués, jamais une qualification exhaustive.

`finding` : `{code,severity:"info"|"warning"|"critical",evidence:"observed"|"inferred"|"unmeasured",sequence:entier|null,traceId:opaque|null}`. Codes fermés : `preparationRejected`, `generationInterrupted`, `nativeFailure`, `permissionDenied`, `outcomeUnknown`, `cancellationObserved`, `collectionTruncated`, `persistenceUnavailable`, `systemCrashReport`, `systemHangReport`, `systemResourceReport`, `noCausalEvidence`, `operationStalled`. Une absence d'événement ne prouve ni absence d'action ni cause d'un crash.

## Interface Swift du recorder

`AssistDebugDiagnostics.shared` acteur, types imbriqués `Category`, `Stage`, `Outcome`, `Reason`, `Field`, `Metric` (`String, Codable, Sendable`). `record(category:stage:outcome:requestId:reason:field:metrics:) async` accepte des enums, une clé de corrélation RAM uniquement et `[Metric:Double]`. Défauts : requestId/reason/field nil, metrics vide. `record` ne lève pas d'erreur et ne peut modifier/exécuter/rejouer une action. `snapshotJSON()`, `configureJSON(_:)`, `exportJSON()`, `clearJSON()` retournent des chaînes JSON validées. Les détails de génération/validation sont filtrés par niveau ; les échecs et transitions principales restent en standard.

Stockage : trois fichiers fixes courant/précédent/antérieur, au plus 256 Kio chacun ; écriture atomique, protection iOS, exclusion des backups, limitation de fréquence. Rotation au premier démarrage, pas au premier export. Les fichiers invalides, symlinks, surdimensionnés ou incompatibles ne deviennent pas des preuves. La saturation est comptée. Pas de gestionnaire fatal bricolé, de debugger distant, de code dynamique ou de nouvelle permission.

## Validation attendue

Harnais Swift réel : configuration, expiration, Off, reprise, rotation/corruption/symlink, purge, bornes, suppression des contenus inconnus, corrélation et analyses sans causalité inventée. UI : ancien binaire, configuration/TTL, export explicite, purge et réponses tardives, aucun déclenchement d'outil/modèle/réseau. Interop Swift→TypeScript avec vraies fixtures encodées. Contrôles Codegen et câblage Xcode. L'archive SDK et l'iPhone resteront une porte distincte du prochain binaire.
