import AppKit
import UserNotifications

// A real app bundle gives Notification Center a stable identity, icon and click handler.
final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func application(_ application: NSApplication, openFiles filenames: [String]) {
        for filename in filenames {
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: filename)),
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { continue }
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                guard granted else {
                    self.ack(filename, error?.localizedDescription ?? "Allow TurboBrocolli notifications in System Settings → Notifications")
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = "TurboBrocolli"
                content.subtitle = payload["title"] ?? ""
                content.body = payload["body"] ?? ""
                content.userInfo = ["url": payload["url"] ?? ""]
                center.add(UNNotificationRequest(identifier: payload["id"] ?? UUID().uuidString, content: content, trigger: nil)) { error in
                    self.ack(filename, error?.localizedDescription ?? "sent")
                }
            }
        }
        application.reply(toOpenOrPrint: .success)
    }

    func ack(_ filename: String, _ result: String) {
        try? result.write(toFile: filename + ".result", atomically: true, encoding: .utf8)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let value = response.notification.request.content.userInfo["url"] as? String,
           let url = URL(string: value), ["http", "https"].contains(url.scheme ?? "") {
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }
        completionHandler()
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--icon" {
    let directory = CommandLine.arguments[2]
    for size in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let pixels = size * scale
            let image = NSImage(size: NSSize(width: pixels, height: pixels))
            image.lockFocus()
            let text = "🥦" as NSString
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont(name: "Apple Color Emoji", size: CGFloat(pixels) * 0.85)!]
            let bounds = text.size(withAttributes: attributes)
            text.draw(at: NSPoint(x: (CGFloat(pixels) - bounds.width) / 2, y: (CGFloat(pixels) - bounds.height) / 2), withAttributes: attributes)
            image.unlockFocus()
            let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
            let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name))
        }
    }
} else {
    let app = NSApplication.shared
    let delegate = Delegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
