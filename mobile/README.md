Ce dossier contient le prototype Assist. Les [instructions spécifiques iOS/Core AI](../docs/ios-build.md) et l’[état de vérification](../docs/verification.md) priment sur les instructions génériques du template ci-dessous. L’app cible Xcode/SDK 27.1+, mais son chargeur Gemma exige iOS 27.2+ à l’exécution ; Android n’a pas encore de moteur d’inférence.

## Aperçu de l’interface dans un navigateur

Depuis ce dossier, exécuter `npm install`, puis `npm run preview` et ouvrir
<http://127.0.0.1:5173>. Si ce port est occupé, choisir explicitement un autre
port, par exemple `npm run preview -- --port 5174`.
Cet aperçu de développement rend le même `App.tsx`
avec React Native for Web. Le moteur natif est explicitement absent : aucun
modèle, résultat ou état d’inférence n’est simulé. Les commandes nécessitant
Core AI restent indisponibles.

Le bouton **Réglages** regroupe le modèle, la limite de réponse et l’apparence.
La ligne **Apparence** propose **Natif clair**, **Graphite** et **Bleu profond**
pour toute l’app. Ces choix sont conservés pendant la session.
**Voir un exemple** affiche un échange explicitement illustratif : il reste
séparé de l’historique réel, des requêtes au moteur et des rapports partagés.
**Préparer mon assistant** ouvre le parcours du modèle. L’import d’un export
compatible et ses exigences se trouvent sous **Importer un modèle** ; les
diagnostics sont accessibles depuis cet écran. Les panneaux techniques sont
initialisés à la demande puis conservés en mémoire pendant cette session,
y compris leurs rapports détaillés. Le suivi visuel se suspend lorsqu’on
quitte les diagnostics.

La [direction d’ensemble et les captures vérifiées](../design/whole-system-redesign.md)
documentent les parcours et les limites de validation native.

Sur iOS, **Dicter** remplit le brouillon avec Apple Speech en mode local
obligatoire `fr-CA`. **Envoyer** reste explicite. L’option **Lire les réponses**
active la voix système canadienne après une réponse Gemma terminée; la lecture
peut être arrêtée. Le micro est fermé pendant la lecture. Les capacités et
permissions sont vérifiées à l’exécution, sans repli distant. Voir le
[parcours et les essais physiques à effectuer](../docs/local-voice.md).
L’aperçu web ne fournit pas de micro ni de voix simulée.
L’[affinage depuis la référence partagée](../design/shared-reference-refinement.md) décrit la révision actuelle, son identité cercle et graine et les différences nécessaires avec la planche.

`npm run preview:build` vérifie la compilation web et écrit dans
`build/preview/`, un dossier ignoré par Git. La configuration est isolée dans
`preview/` et ne modifie pas Metro ni les builds iOS/Android. Un contrôle dans
ce navigateur vérifie le rendu et les interactions locales ; le clavier,
les safe areas et l’inférence sur appareil iOS demandent une validation native.

This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

Une build Android Release exige un keystore privé fourni par la CI et les
variables `ASSIST_RELEASE_STORE_FILE`, `ASSIST_RELEASE_STORE_PASSWORD`,
`ASSIST_RELEASE_KEY_ALIAS` et `ASSIST_RELEASE_KEY_PASSWORD`. Utiliser un chemin
absolu pour le fichier secret ; une configuration absente ou le keystore de
débogage du dépôt fait échouer la build Release. Les builds Debug se lancent
sans ces variables.

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

`Gemfile.lock` fixe les versions des gems. Le mettre à jour et le
versionner avec tout changement volontaire du bundle.

Then, and every time you update your native dependencies, run:

```sh
(cd ios && bundle exec pod install)
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
