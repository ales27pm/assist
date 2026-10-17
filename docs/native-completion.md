# Compléments natifs après le candidat 17

La version de travail conserve le moteur Core AI, la génération progressive et
le mode vocal existants. Les ajouts ci-dessous ne modifient pas le numéro de
build et ne représentent pas une nouvelle livraison TestFlight.

## Dossier du modèle

Le [signet privé](model-restoration.md) retrouve le dossier après une relance,
sans copier les poids, lancer le modèle ou ouvrir le micro. L’interface affiche
son nom et propose directement **Charger le modèle**. Une restauration
impossible indique comment sélectionner à nouveau le dossier. Les réponses
d’anciennes versions du pont restent acceptées.

## Clavier et accessibilité

Le pavé numérique iOS de la limite de réponse possède une commande **Terminé**.
La navigation ferme le clavier et dirige le focus vers le titre du nouvel
écran. Fermer l’exemple rend le focus à son bouton ; le panneau Apparence le
rend après sa fermeture effective.

Les valeurs de modèle, de réponse et d’apparence sont associées à leurs
contrôles. Les erreurs du champ sont associées à la saisie. Les changements
d’état du modèle et du mode vocal disposent d’annonces iOS bornées : les jetons
et les mesures du micro ne déclenchent pas une annonce à chaque mise à jour.
Une réponse déjà lue par l’app ne reçoit pas une seconde annonce automatique.

## Vérification à effectuer sur iPhone

1. Choisir un dossier local valide, fermer complètement l’app, relancer et
   charger explicitement le dossier retrouvé. La présence d’un signet ne
   constitue pas une preuve de compatibilité du modèle.
2. Déplacer ou supprimer ce dossier : la restauration doit proposer une
   nouvelle sélection, sans chargement automatique ni perte du brouillon.
3. Décharger puis recharger ; annuler une nouvelle sélection et conserver
   l’ancienne. Vérifier aussi le dossier Documents propre à l’app.
4. Avec VoiceOver, parcourir les états courants, les erreurs et les retours
   d’écran. Pendant le vocal, vérifier les annonces de phase et les commandes
   de pause/interruption sans superposition avec la lecture.
5. Ouvrir le pavé numérique, toucher Terminé, puis parcourir les écrans avec le
   brouillon conservé. Vérifier le clavier logiciel, les zones sûres et Dynamic Type.

Les tests de protocole, de restauration et d’accessibilité utilisent des
frontières simulées lorsqu’un appareil ou une autorisation réelle est nécessaire.
Ils ne remplacent pas ces essais ni une compilation complète avec le SDK Core AI
requis par l’application.
