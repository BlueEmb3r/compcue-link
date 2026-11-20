// CompCue Link for Mac: the menu bar app.
//
// It is only the face of the helper. It starts `compcue-link` (the executable next to it in the app), keeps it
// running, and shows what the helper writes to status.json: waiting for League, connected, or a code to confirm.
// It never talks to the League client or to the site itself.
import AppKit

let supportDir: URL = {
    if let d = ProcessInfo.processInfo.environment["COMPCUE_DIR"] { return URL(fileURLWithPath: d) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/CompCue")
}()
let agentPlist = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.compcue.link.plist")

struct Status: Decodable {
    var state: String
    var code: String?
    var site: String?
    var version: String?
    var update: String?
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var helper: Process?
    var quitting = false
    var restarts = 0
    var status = Status(state: "starting", code: nil, site: nil, version: nil, update: nil)

    func applicationDidFinishLaunching(_ note: Notification) {
        menu.delegate = self
        item.menu = menu
        render()
        startHelper()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.readStatus() }
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        helper?.terminate()
    }

    // MARK: the helper

    func startHelper() {
        let exe = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/compcue-link")
        let p = Process()
        p.executableURL = exe
        p.arguments = []
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.helper = nil
                self.restarts += 1
                // a helper that keeps stopping is started again more and more slowly, at most once a minute
                let wait = min(60.0, 2.0 * Double(self.restarts))
                DispatchQueue.main.asyncAfter(deadline: .now() + wait) { if !self.quitting && self.helper == nil { self.startHelper() } }
            }
        }
        do { try p.run(); helper = p } catch { status.state = "broken"; render() }
    }

    func readStatus() {
        let url = supportDir.appendingPathComponent("status.json")
        guard let data = try? Data(contentsOf: url), let s = try? JSONDecoder().decode(Status.self, from: data) else { return }
        if s.state == "connected" { restarts = 0 }
        if s.state != status.state || s.code != status.code || s.update != status.update {
            status = s
            render()
        } else {
            status = s
        }
    }

    // MARK: what the player sees

    var line: String {
        switch status.state {
        case "connected": return "Connected to CompCue"
        case "connecting": return "League is open. Connecting…"
        case "waiting": return "Ready. Waiting for League to open"
        case "pairing": return status.code.map { "Confirm code \($0) in your browser" } ?? "Not connected to your account yet"
        case "offline": return "Can't reach CompCue. Trying again"
        case "update": return "This version is too old. Updating…"
        case "broken": return "CompCue Link could not start"
        default: return "Starting…"
        }
    }

    func render() {
        if let b = item.button {
            let name = status.state == "connected" ? "link.circle.fill" : (status.state == "pairing" || status.state == "offline" || status.state == "broken") ? "exclamationmark.circle" : "link.circle"
            let img = NSImage(systemSymbolName: name, accessibilityDescription: "CompCue Link")
            img?.isTemplate = true
            b.image = img
            if img == nil { b.title = "CC" }
            b.toolTip = "CompCue Link: \(line)"
        }
        rebuild()
    }

    func menuWillOpen(_ menu: NSMenu) { readStatus(); rebuild() }

    func rebuild() {
        menu.removeAllItems()
        let head = NSMenuItem(title: line, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(.separator())
        if status.state == "pairing" {
            menu.addItem(action("Connect this Mac…", #selector(openPair)))
        }
        menu.addItem(action("Open CompCue", #selector(openLive)))
        menu.addItem(.separator())
        let login = action("Start at login", #selector(toggleLogin))
        login.state = FileManager.default.fileExists(atPath: agentPlist.path) ? .on : .off
        menu.addItem(login)
        menu.addItem(action("Show log", #selector(showLog)))
        if let v = status.version {
            let ver = NSMenuItem(title: status.update.map { "Version \(v) (\($0) is coming)" } ?? "Version \(v)", action: nil, keyEquivalent: "")
            ver.isEnabled = false
            menu.addItem(ver)
        }
        menu.addItem(.separator())
        menu.addItem(action("Quit CompCue Link", #selector(quit), key: "q"))
    }

    func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        i.target = self
        return i
    }

    // The site address comes from the helper's own status (the site it was started with), https only.
    var siteURL: String {
        if let s = status.site, s.hasPrefix("https://") || s.hasPrefix("http://127.0.0.1") || s.hasPrefix("http://localhost") { return s }
        return "https://compcue.aflince.com"
    }
    func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }
    @objc func openLive() { open("\(siteURL)/#/live") }
    @objc func openPair() {
        let code = (status.code ?? "").filter { $0.isLetter || $0.isNumber || $0 == "-" }
        open(code.isEmpty ? "\(siteURL)/#/link" : "\(siteURL)/#/link?code=\(code)")
    }
    @objc func showLog() { NSWorkspace.shared.open(supportDir.appendingPathComponent("link.log")) }
    @objc func quit() { NSApp.terminate(nil) }

    @objc func toggleLogin() {
        let fm = FileManager.default
        if fm.fileExists(atPath: agentPlist.path) {
            try? fm.removeItem(at: agentPlist)
        } else {
            let exe = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/CompCueLink").path
            let plist: [String: Any] = ["Label": "com.compcue.link", "ProgramArguments": [exe], "RunAtLoad": true, "ProcessType": "Interactive", "LimitLoadToSessionType": "Aqua"]
            try? fm.createDirectory(at: agentPlist.deletingLastPathComponent(), withIntermediateDirectories: true)
            if let d = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) { try? d.write(to: agentPlist) }
        }
        rebuild()
    }
}

// One copy of the app per user: a second start just ends.
let mine = NSRunningApplication.current
if NSRunningApplication.runningApplications(withBundleIdentifier: "com.compcue.link").contains(where: { $0 != mine }) { exit(0) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
