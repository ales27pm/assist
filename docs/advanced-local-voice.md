# Pile vocale locale avancée

Le mode vocal peut sélectionner **PocketTTS French 24L int8 + Parakeet Redux ou
Ultra + Silero**, avec le graphe duplex et l’annulation d’écho Apple VPIO du
parcours système. Les commandes RN et leurs identifiants restent communs aux
deux moteurs. Apple reste le choix initial; aucune voix québécoise ou autorisation
n’est fournie par le dépôt.

## Préparer les ressources

Les poids sont séparés de l’application et ne sont jamais téléchargés par une
commande de reconnaissance, synthèse ou chargement. Sur l’ordinateur :

```sh
# Affiche uniquement les versions et la taille, sans téléchargement.
python3 scripts/prepare-voice-pack.py --variant redux

# Téléchargement explicite des poids publics épinglés, SHA-256 de chaque fichier.
python3 scripts/prepare-voice-pack.py --variant redux \
  --output /chemin/local/assist-voice-pack --download

# Contrôle complet hors réseau du dossier prêt à transférer.
python3 scripts/prepare-voice-pack.py --variant redux \
  --output /chemin/local/assist-voice-pack --verify
```

Utiliser `ultra` ou `both` pour les autres variantes. Le dossier doit être neuf
ou posséder le marqueur créé par l’outil. Une reprise vérifie les fichiers déjà
présents; une variante partielle supplémentaire exige `--variant both` ou un
nouveau dossier. Aucun fichier utilisateur extérieur au pack n’est effacé.

| Sélection | Octets des fichiers du pack |
| --- | ---: |
| Pocket français int8, encodeur de référence inclus | 1 030 913 647 |
| Parakeet Redux | 220 304 193 |
| Parakeet Ultra | 632 162 964 |
| Silero | 1 063 425 |
| Pocket + Silero + Redux | **1 252 281 265** |
| Pocket + Silero + Ultra | **1 664 140 036** |
| Les deux variantes ASR | **1 884 444 229** |

Ces tailles décrivent les fichiers épinglés, sans mesure du RSS, caches Core ML,
compilation ou marge disque. La sélection Pocket garde une seule voix fournie,
`estelle`, et l’encodeur français local; les anciens totaux des 26 voix ne
décrivent pas ce pack. `estelle` ne remplace pas la référence autorisée lors
de l’activation de la pile avancée.

Transférer le dossier complet dans **Sur mon iPhone**, avec ses sous-dossiers
`pocket`, `silero` et `redux`/`ultra`. Dans Assist : **Réglages → Voix locale
avancée → Importer un pack de modèles**. Les fichiers doivent déjà être
matérialisés localement. L’import rejette liens symboliques et placeholders,
copie par blocs bornés et vérifie tailles et SHA-256 contre le manifeste inclus
dans l’app, indépendamment de tout manifeste fourni par le dossier sélectionné.
Il faut l’espace d’une nouvelle copie plus 256 Mo; l’ancien pack reste en place
jusqu’à validation du nouveau. Une erreur ou mise en arrière-plan annule l’import
et conserve la sélection précédente. Aucun microphone ne s’ouvre dans Réglages.

## Référence québécoise et consentement

L’utilisateur a choisi de fournir les fichiers ultérieurement. Dans le panneau :

1. Indiquer le nom de la personne et confirmer explicitement son autorisation
   de cloner et reproduire sa voix localement dans Assist.
2. Importer un **WAV mono/stéréo de 3 à 30 secondes**, 32 Mo maximum.
3. Choisir le document de consentement **PDF, texte ou JSON**, 5 Mo maximum.
4. Sélectionner FluidAudio avec la variante de Parakeet importée.

Audio, document et reçu (portée confirmée, date, empreintes SHA-256) restent
dans Application Support, exclus des sauvegardes. Les chemins et contenus ne
traversent pas le bridge. La première session crée localement le conditionnement
avec `french_24l/mimi_encoderv3.mlmodelc`, puis le réutilise. Le SDK conserve au
plus dix secondes/125 frames de conditionnement; la durée autorisée à l’import
ne promet pas l’utilisation intégrale des trente secondes. Aucune réprojection
approximative par un encodeur anglais ou voix de remplacement n’est autorisée.
La suppression remet le moteur sur Apple et doit retirer les fichiers avant
de confirmer sa réussite. Le choix Apple et le comparatif fr-CA restent disponibles.

L’accent et la fidélité ne sont pas garantis par une locale ou une référence :
les phrases québécoises du comparatif doivent être écoutées après import.

## Audio, streaming et interruption

L’entrée reste sur le graphe VPIO validé au build19 : format client identique
aux deux côtés I/O, micro ouvert pendant la lecture, un seul AEC. Le callback
audio copie vers un tampon préalloué borné; rééchantillonnage16 kHz, Silero et
Parakeet tournent hors du callback. Les débordements provoquent une erreur
explicite et un arrêt, jamais une perte silencieuse de parole.

Silero utilise des fenêtres4096 échantillons (256 ms à16 kHz), seuil0,85 et deux
fenêtres positives pour promouvoir une reprise de parole. Un pré-roll d’environ
une seconde conserve le début de l’intervention. Parakeet français transcrit
des instantanés cumulatifs, avec une seule inférence et un instantané de
remplacement au maximum, puis finalise la queue. La prise de parole est bornée
à45 secondes. Ce chemin évite le délai d’environ13secondes du streaming glissant
par défaut du SDK. Les partiels, délais de fin de tour et faux déclenchements
doivent être mesurés sur iPhone; deux fenêtres ne permettent pas de promettre
un barge-in inférieur à200 ms.

À la fin de la lecture, le même worker d’entrée passe de la surveillance à la
capture normale sans remettre à zéro l’audio, le rééchantillonneur ou la queue
VAD. Un mot bref comme « oui » peut ainsi produire un partiel même sans deux
fenêtres positives. L’écoute n’est annoncée qu’après cet acquittement; une
annulation ou un délai dépassé ne peut pas réactiver l’ancienne capture.

Une réponse crée **une seule session PocketTTS**. Chaque unité prosodique rejoint
`enqueue`; l’état Mimi persiste entre ces segments. Les frames24 kHz mono rejoignent
le lecteur48 kHz du graphe commun. En interruption : invalider l’identité, arrêter
le lecteur et purger les frames avant d’attendre `session.cancel()`. La sortie
audible n’attend donc pas la fin coopérative du calcul Core ML. La génération
LLM annulée ne peut pas réinjecter d’ancien audio. Les modèles restent chauds
entre tours automatiques; fermeture, erreur, arrière-plan et mutation de ressources
attendent leur nettoyage avant réemploi ou suppression d’une référence.

Les limites du SDK sont64 segments texte et192 frames de sortie (15,36secondes)
avec erreur explicite si le consommateur ne suit plus. Une limite supplémentaire
de150 frames suspend la production jusqu’aux confirmations de lecture effective;
elle évite de remplir la file pendant une longue réponse. Le chargement refuse
une réserve d’allocation par app inférieure à2 Go et un état thermique sérieux
ou critique; ce sont des garde-fous de prototype, pas une mesure du RSS requis.
L’échec du moteur avancé reste visible; l’application ne réessaie pas une réponse
avec une autre voix à l’insu de l’utilisateur.

## Versions, licences et preuves

Le [SDK local](../mobile/ios/AssistSpeech/README.md) contient FluidAudio
`2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042`, sous Apache-2.0, sans poids ni cible
binaire NeMo. Le manifeste Swift 6.2 ne garde que TTS, ASR et VAD. Le patch documenté
ajoute le chemin Pocket strictement local, borne les streams et retire le texte
des logs de session. Les appels ASR utilisent `AsrModels.loadLocal`; Silero reçoit
un `MLModel` déjà chargé depuis l’import.

Les sources officielles des poids et leurs révisions sont consignées dans
[le manifeste embarqué](../mobile/ios/Assist/AdvancedVoiceAssets.json) et
[les attributions](../mobile/ios/AssistSpeech/MODEL-SOURCES.md). La
[documentation PocketTTS épinglée](https://github.com/FluidInference/FluidAudio/blob/2d6c42ca5f3accc0faf9fee9e0fff5b9b2cf6042/Documentation/TTS/PocketTTS.md)
décrit la session Mimi et les placements mesurés : ce n’est pas une pile
entièrement ANE. L’exécution ANE de cette app reste non vérifiée.

Les tests sans modèles couvrent import/intégrité, contrats RN, files bornées,
annulation et chargement local manquant. Compilation Swift, archive signée,
acceptation Apple et qualification acoustique sont des preuves distinctes.
La compilation ne prouve pas l’inférence avec ces poids, la fidélité de la voix,
VPIO matériel, mémoire avec Gemma, thermique ou fonctionnement en mode Avion.
Ces contrôles restent à faire avec le pack et la référence réellement importés.
