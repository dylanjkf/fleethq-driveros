import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    // Privacy cover shown over the WebView whenever the app leaves the
    // foreground, so the delivery photo / signature / customer address on screen
    // never leaks into the iOS app-switcher snapshot. This is the iOS mirror of
    // Android's FLAG_SECURE (MainActivity.java) — iOS has no true FLAG_SECURE, so
    // a blur overlay added on resign-active and removed on become-active is the
    // standard equivalent.
    private var privacyCover: UIView?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Cover the screen BEFORE the system captures the app-switcher snapshot
        // (which happens as the app resigns active).
        showPrivacyCover()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Belt-and-suspenders: ensure the cover is present in the background too.
        showPrivacyCover()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Back in the foreground for the real user — reveal the WebView.
        hidePrivacyCover()
    }

    private func showPrivacyCover() {
        guard privacyCover == nil, let rootView = window?.rootViewController?.view else { return }
        let effect = UIBlurEffect(style: .systemMaterial)
        let cover = UIVisualEffectView(effect: effect)
        cover.frame = rootView.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        rootView.addSubview(cover)
        privacyCover = cover
    }

    private func hidePrivacyCover() {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
