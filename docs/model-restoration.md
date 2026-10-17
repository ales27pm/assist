# Retrouver le modèle après une relance

Après une sélection valide, Assist conserve un signet du dossier dans ses
préférences privées (`assist.modelDirectory.bookmark.v1`). Il conserve une
référence autorisée au même dossier, sans copier les poids. Aucun chemin local
ni contenu du signet n’est envoyé à JavaScript.
Le format et le cycle d’accès suivent la procédure Apple
[Providing access to directories](https://developer.apple.com/documentation/uikit/providing-access-to-directories).

Lors de la lecture de l’état natif après relance, Assist résout ce signet,
acquiert temporairement son accès et applique à nouveau la politique existante :
dossier local entièrement disponible, lisible, sans lien symbolique ni élément
iCloud ou File Provider non téléchargé. Un signet périmé peut être renouvelé
si le dossier reste valide. Une autorisation révoquée, un dossier absent ou un
signet corrompu imposent une nouvelle sélection et suppriment le signet inutilisable.

Cette restauration ne charge pas Gemma, n’ouvre pas le microphone et ne demande
aucune nouvelle permission. **Charger** reste une action explicite. Le chargement
revalide le dossier et conserve sa portée d’accès jusqu’au déchargement. Quitter
le module libère l’accès sans effacer le signet. Annuler une sélection ou choisir
un dossier invalide préserve le précédent modèle mémorisé.

Les dossiers propres à Assist dans Documents ou Library peuvent être accessibles
sans portée de sécurité supplémentaire. Cette exception est limitée aux racines
du conteneur fournies par iOS, avec contrôle de chaque dossier intermédiaire
contre les liens symboliques. Un refus d’accès à un dossier externe reste bloquant.

`getStatus()` ajoute les champs compatibles `selectedModelAvailable`,
`selectedModelName` (nom du dossier ou `null`) et `selectedModelError`
(instruction localisée ou `null`). La présence du dossier ne garantit ni son
identité cryptographique, ni sa compatibilité, ni la réussite du chargement.

Le banc Foundation s’exécute sans modèle ni appareil :

```sh
swiftc -swift-version 6 -strict-concurrency=complete \
  mobile/ios/Assist/ModelDirectoryBookmark.swift \
  scripts/check-model-directory-bookmark.swift -o /tmp/check-model-directory-bookmark
/tmp/check-model-directory-bookmark
```

Il utilise de vraies préférences privées jetables et des frontières de signet et
d’accès simulées. Il couvre relance, annulation, échec de sauvegarde, corruption,
révocation, dossier absent, renouvellement et courses déterministes. Il ne prouve
pas la persistance de l’autorisation iOS réelle. Sur iPhone, vérifier séparément
sélection → fermeture complète → relance → chargement explicite, puis révocation,
déplacement/suppression du dossier et nouvelle sélection, sans effacer les poids.
