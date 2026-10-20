internal import Expo
import UIKit

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    for activity in connectionOptions.userActivities {
      _ = AssistIntentInbox.handleSpotlight(activity)
    }
  }

  override func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    if !AssistIntentInbox.handleSpotlight(userActivity) {
      super.scene(scene, continue: userActivity)
    }
  }
}
