# Enquête mémoire du mode vocal — build 25

## Éléments établis

Le rapport iPhone du 17 octobre 2026 à 20:24:56 (heure de Toronto), version
1.0.0 (25), indique `EXC_CRASH (SIGABRT)` sur le thread 2. La pile passe par
`hermes::vm::GCBase::oom`, `HadesGC::OldGen::allocSlow`, la collecte GC, puis
`JSObject::getOwnPropertyKeys` et `objectAssign`. La console capturée au même
essai contient :

```text
LLVM ERROR: OOM: error_code(value = 12, category = generic, message = Cannot allocate memory)
App terminated due to signal 6.
```

Cela établit un échec d’allocation système rencontré par Hermes, suivi d’un
abort. Cela ne prouve ni une fuite JavaScript, ni que `Object.assign` est la
source de la pression : il peut simplement être l’allocation victime. Le
thread 0 libère alors des tableaux Core ML et une session PocketTTS ; ce
n’est pas le thread qui a déclenché l’abort. Augmenter arbitrairement le heap
Hermes ou rétablir le seuil mémoire fixe ne serait pas un correctif démontré.

L’utilisateur a confirmé que les modèles avaient chargé et que l’app écoutait
avant sa fermeture. Les captures de préparation correspondent à une relance,
pas nécessairement à l’état ayant précédé ce crash. L’erreur PCM observée dans
un autre essai resté ouvert est un incident distinct, non corrigé ici.

Un export ultérieur enregistre une pression critique puis un avertissement,
mais son historique dépendait encore des lectures JavaScript : environ
25 secondes manquent autour de l’alerte. Le maximum échantillonné de 698 Mo,
l’empreinte ultérieure de 611 Mo et le budget restant de 2,93 Go ne décrivent
donc pas le pic du crash. `ready` décrit Core AI, pas l’inactivité vocale.

## Mécanismes corrigés et vérification

Les changements sont limités aux allocations et durées de vie évitables.
Les modèles, poids, précision, placement de calcul, contexte 32K et texte
prononcé doivent rester inchangés.

### Cache de conditionnement PocketTTS

Pour une voix pré-calculée comme Estelle, la session construit et conserve un
cache KV complet puis en fait une copie pour chaque segment. Un cache de
24 couches, K/V combinés, 512 positions, 16 têtes, 64 valeurs et Float32
représente `24 × 2 × 512 × 16 × 64 × 4 = 100 663 296` octets, soit **96 Mio**,
hors objets et compteurs de positions.

Le correctif conserve le conditionnement compact déjà fourni par le
pack, puis construit directement le cache mutable de travail par segment.
Les tests retrouvent exactement les mêmes valeurs, types, positions et zéros de
padding que l’ancien chemin « expansion puis copie ». Les voix clonées
nécessitant un vrai prefill gardent leur chemin existant. Le gain théorique est
une allocation KV complète conservée en moins, pas un modèle plus petit ; le
pic réel sur iPhone n’a pas été mesuré après correction.

### Fin d’une lecture et callbacks audio

La référence à une session PocketTTS terminée subsistait dans le runtime
d’écoute. Les callbacks de crédits audio pouvaient aussi la retenir. La
libération vise maintenant l’identité de la session terminée, sans annuler ou
créditer une session plus récente. L’annulation effective et l’attente de la
fin du producteur sont conservées. Les tests vérifient la fermeture du
producteur et la protection d’une nouvelle session pendant l’attente ; les
crédits de lecture ne retiennent plus les anciennes sessions par leurs seuls
callbacks.

### File de phrases JavaScript

La préparation immédiate d’une chaîne de promesses par phrase est reproduite :
1 800 phrases créaient 1 800 réactions alors que le démarrage natif de lecture
attendait encore et qu’aucune phrase n’avait été envoyée. Le correctif draine
progressivement le texte complet, dans l’ordre, avec une seule commande en
attente. Le test mesure zéro nouvelle réaction `.then` pendant le `push`
bloqué, puis vérifie que les 1 800 phrases sont toutes livrées après déblocage.
Aucun texte n’est supprimé pour tenir cette borne. L’arrêt libère le texte non
envoyé ; les cas d’interruption et les validations de préfixe restent couverts.

Les doubles `JSON.parse` des résultats et événements vocaux sont également
supprimés : une seule analyse conserve les mêmes validations, le rejet des
sessions périmées et les mêmes résultats publics. Les tests comptent un appel
au lieu de deux sur les mêmes données.

Vérification locale : 743 tests React Native, TypeScript, ESLint et génération
du pont passent. Les contrôles natifs passent avec 27 tests SDK, 14 contrôles
Fluid et 28 contrôles duplex. Le SDK compile pour ARM64 iOS 26 ; toutes les
sources `Voice/*.swift` passent aussi le contrôle de types Swift 6 strict
contre ce vrai module, sans faux module Core ML ou FluidAudio. Les deux
régressions natives ont été observées avant correction. Les tests de tenseurs
utilisent de vrais `MLMultiArray` synthétiques, pas les modèles importés.

## Limites et qualification

Ces mécanismes sont des candidats étayés, pas une attribution certaine du
crash iPhone. Leurs régressions locales sont vérifiées séparément des mesures
réelles du pic mémoire. Le [journal natif persistant](monitoring.md)
permettra de garder le dernier checkpoint sans dépendre du JavaScript et de
l’exporter après réouverture ; il peut encore manquer une pointe brève ou les
dernières secondes avant l’arrêt.

Aucune build EAS payante ni nouvelle installation sur l’iPhone n’est autorisée
par ce travail préparatoire. Une compilation locale ou un test de tenseurs
synthétiques ne qualifie ni le chargement des modèles réels, ni l’écoute et la
parole, ni l’exécution ANE.
