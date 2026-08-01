import Cocoa
import WebKit
import UserNotifications

final class DragRegionView: NSView {
    override func mouseDown(with event: NSEvent) { window?.performDrag(with: event) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private lazy var stateURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("com.appledemac.study", isDirectory: true).appendingPathComponent("state.json")
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let indexURL = Bundle.main.url(forResource: "index", withExtension: "html") else {
            fatalError("找不到应用页面")
        }

        let controller = WKUserContentController()
        controller.add(self, name: "nativeStore")
        controller.add(self, name: "nativeReminders")
        controller.add(self, name: "nativeNotify")
        if let data = try? Data(contentsOf: stateURL), let json = String(data: data, encoding: .utf8) {
            controller.addUserScript(WKUserScript(source: "window.__nativeState = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.loadFileURL(indexURL, allowingReadAccessTo: indexURL.deletingLastPathComponent())

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Apple · 来学习"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.styleMask.insert(.fullSizeContentView)
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 760, height: 560)
        if !window.setFrameUsingName("StudyMainWindow") { window.center() }
        window.setFrameAutosaveName("StudyMainWindow")
        let content = NSView(frame: window.contentLayoutRect)
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        let dragRegion = DragRegionView(frame: NSRect(x: 80, y: content.bounds.height - 44, width: content.bounds.width - 80, height: 44))
        dragRegion.autoresizingMask = [.width, .minYMargin]
        content.addSubview(dragRegion)
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
        UNUserNotificationCenter.current().delegate = self
        NSApp.activate(ignoringOtherApps: true)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nativeStore", JSONSerialization.isValidJSONObject(message.body),
           let data = try? JSONSerialization.data(withJSONObject: message.body) {
            let directory = stateURL.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: stateURL, options: .atomic)
        } else if message.name == "nativeReminders", let reminders = message.body as? [[String: Any]] {
            schedule(reminders)
        } else if message.name == "nativeNotify", let note = message.body as? [String: String] {
            notify(title: note["title"] ?? "来学习", body: note["body"] ?? "")
        }
    }

    private func schedule(_ reminders: [[String: Any]]) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.removeAllPendingNotificationRequests()
            for reminder in reminders {
                guard let identifier = reminder["identifier"] as? String, let at = reminder["at"] as? Double,
                      let title = reminder["title"] as? String, let body = reminder["body"] as? String else { continue }
                let content = UNMutableNotificationContent(); content.title = title; content.body = body; content.sound = .default
                let trigger = UNCalendarNotificationTrigger(dateMatching: Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: Date(timeIntervalSince1970: at / 1000)), repeats: false)
                center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: trigger))
            }
        }
    }

    private func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent(); content.title = title; content.body = body; content.sound = .default
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
