import Cocoa
import Foundation

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var refreshTimer: Timer?
    let plistLabel = "com.pmpro.cd-sync-watcher"

    var isPaused: Bool {
        get { UserDefaults.standard.bool(forKey: "cdSyncPaused") }
        set { UserDefaults.standard.set(newValue, forKey: "cdSyncPaused") }
    }

    var repoDir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/glyne_repo/PMProSmartPosProto"
    }

    var logPath: String { "\(repoDir)/.cd-sync.log" }

    var versionString: String {
        let paths = [
            "\(repoDir)/tools/version.json",
            Bundle.main.bundlePath + "/../../../version.json"
        ]
        for versionPath in paths {
            if let data = FileManager.default.contents(atPath: versionPath),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let version = json["version"] as? String {
                return version
            }
        }
        return "?.?.?"
    }

    var gitEmail: String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        task.arguments = ["config", "user.email"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "unknown"
        } catch {
            return "unknown"
        }
    }

    // --- Supabase config ---
    let supabaseURL = "https://kjmcpvecywgjhvihrert.supabase.co"
    let supabaseAnonKey = "sb_publishable_ltt47EBgS0L6RsMPuJxLgQ_gyuiMMQF"
    var cachedTeamActivity: [(email: String, activity: String, time: String)] = []

    // MARK: - App Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.image = makeIcon(active: true)
        }

        updateMenu()
        fetchTeamActivity()

        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.updateMenu()
        }
        Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            self?.fetchTeamActivity()
        }
    }

    // MARK: - Icon

    func makeIcon(active: Bool, paused: Bool = false) -> NSImage {
        let symbolName = active ? "eye.circle.fill" : "eye.slash.circle"
        let color: NSColor
        if paused {
            color = NSColor(red: 0.7, green: 0.55, blue: 0.0, alpha: 1.0)
        } else if active {
            color = NSColor(red: 0.0, green: 0.55, blue: 0.0, alpha: 1.0)
        } else {
            color = NSColor.gray
        }

        let size = NSSize(width: 22, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            if let symbol = NSImage(systemSymbolName: symbolName,
                                    accessibilityDescription: "CD Sync Watcher")?
                .withSymbolConfiguration(.init(pointSize: 16, weight: .medium)) {
                let tinted = symbol.copy() as! NSImage
                tinted.lockFocus()
                color.set()
                let imageRect = NSRect(origin: .zero, size: tinted.size)
                imageRect.fill(using: .sourceAtop)
                tinted.unlockFocus()

                let symSize = NSSize(width: 18, height: 18)
                let origin = NSPoint(x: (rect.width - symSize.width) / 2,
                                     y: (rect.height - symSize.height) / 2)
                tinted.draw(in: NSRect(origin: origin, size: symSize))
            }
            return true
        }
        image.isTemplate = false
        return image
    }

    // MARK: - Styled Menu Items

    func makeColoredMenuItem(text: String, color: NSColor, font: NSFont, indent: CGFloat = 0) -> NSMenuItem {
        let item = NSMenuItem()
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 20))
        let label = NSTextField(labelWithString: text)
        label.font = font
        label.textColor = color
        label.frame = NSRect(x: 14 + indent, y: 1, width: 500 - indent, height: 18)
        label.backgroundColor = .clear
        label.isBezeled = false
        label.isEditable = false
        view.addSubview(label)
        item.view = view
        return item
    }

    // MARK: - Menu

    func updateMenu() {
        let menu = NSMenu()
        let processRunning = isWatcherRunning()

        // Update icon
        if let button = statusItem.button {
            if isPaused {
                button.image = makeIcon(active: false, paused: true)
            } else {
                button.image = makeIcon(active: processRunning)
            }
        }

        // Status line
        let statusText: String
        let statusColor: NSColor
        if isPaused {
            statusText = "◐  Watcher Paused"
            statusColor = NSColor(red: 0.6, green: 0.45, blue: 0.0, alpha: 1.0)
        } else if !processRunning {
            statusText = "○  Watcher Stopped"
            statusColor = NSColor(red: 0.5, green: 0.0, blue: 0.1, alpha: 1.0)
        } else {
            statusText = "●  Watcher Running"
            statusColor = NSColor(red: 0.0, green: 0.4, blue: 0.0, alpha: 1.0)
        }

        menu.addItem(makeColoredMenuItem(
            text: statusText,
            color: statusColor,
            font: NSFont.boldSystemFont(ofSize: 13)
        ))

        // Version line
        menu.addItem(makeColoredMenuItem(
            text: "Ver. \(versionString)",
            color: NSColor.secondaryLabelColor,
            font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
            indent: 18
        ))

        menu.addItem(NSMenuItem.separator())

        // Recent local activity
        menu.addItem(makeColoredMenuItem(
            text: "Recent Activity",
            color: NSColor(white: 0.35, alpha: 1.0),
            font: NSFont.boldSystemFont(ofSize: 11)
        ))

        let lines = readRecentLog()
        if lines.isEmpty {
            menu.addItem(makeColoredMenuItem(
                text: "No recent activity",
                color: NSColor(white: 0.4, alpha: 1.0),
                font: NSFont.systemFont(ofSize: 12),
                indent: 6
            ))
        } else {
            for line in lines {
                menu.addItem(makeColoredMenuItem(
                    text: line,
                    color: NSColor(white: 0.08, alpha: 1.0),
                    font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium),
                    indent: 6
                ))
            }
        }

        menu.addItem(NSMenuItem.separator())

        // Team activity (from Supabase)
        if !cachedTeamActivity.isEmpty {
            menu.addItem(makeColoredMenuItem(
                text: "Team Activity",
                color: NSColor(white: 0.35, alpha: 1.0),
                font: NSFont.boldSystemFont(ofSize: 11)
            ))

            for entry in cachedTeamActivity.prefix(5) {
                let shortEmail = entry.email.components(separatedBy: "@").first ?? entry.email
                menu.addItem(makeColoredMenuItem(
                    text: "\(entry.time)  \(shortEmail): \(entry.activity)",
                    color: NSColor(white: 0.2, alpha: 1.0),
                    font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
                    indent: 6
                ))
            }

            menu.addItem(NSMenuItem.separator())
        }

        // Actions
        if isPaused {
            let item = NSMenuItem(title: "Resume Watcher", action: #selector(resumeWatcher), keyEquivalent: "r")
            item.target = self
            menu.addItem(item)
        } else if processRunning {
            let item = NSMenuItem(title: "Pause Watcher", action: #selector(pauseWatcher), keyEquivalent: "p")
            item.target = self
            menu.addItem(item)
        } else {
            let item = NSMenuItem(title: "Start Watcher", action: #selector(startWatcher), keyEquivalent: "s")
            item.target = self
            menu.addItem(item)
        }

        let logItem = NSMenuItem(title: "Open Log File", action: #selector(openLog), keyEquivalent: "l")
        logItem.target = self
        menu.addItem(logItem)

        let repoItem = NSMenuItem(title: "Open Repo in Finder", action: #selector(openRepo), keyEquivalent: "r")
        repoItem.target = self
        menu.addItem(repoItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit CD Sync Menu", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Watcher Status

    func isWatcherRunning() -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", "launchctl list 2>/dev/null | grep -q \(plistLabel)"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }

    // MARK: - Local Log

    func readRecentLog() -> [String] {
        guard FileManager.default.fileExists(atPath: logPath),
              let content = try? String(contentsOfFile: logPath, encoding: .utf8) else {
            return []
        }

        let allLines = content.components(separatedBy: .newlines)
            .filter { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                return !trimmed.isEmpty
                    && trimmed.hasPrefix("[")
                    && !trimmed.contains("Press Ctrl+C")
                    && !trimmed.contains("Watching both")
                    && !trimmed.contains("Recognized patterns")
            }

        let recent = Array(allLines.suffix(8).reversed())

        let isoFormatter = DateFormatter()
        isoFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        isoFormatter.timeZone = TimeZone(identifier: "UTC")

        let displayFormatter = DateFormatter()
        displayFormatter.dateFormat = "M/d h:mm:ss a"
        displayFormatter.timeZone = TimeZone.current
        displayFormatter.amSymbol = "AM"
        displayFormatter.pmSymbol = "PM"

        return recent.map { line in
            if let range = line.range(of: #"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]"#, options: .regularExpression) {
                let bracket = String(line[range])
                let dateStr = String(bracket.dropFirst().dropLast())
                if let date = isoFormatter.date(from: dateStr) {
                    let local = displayFormatter.string(from: date)
                    let rest = String(line[range.upperBound...]).trimmingCharacters(in: .whitespaces)
                    return "\(local)  \(rest)"
                }
            }
            return line
        }
    }

    // MARK: - Supabase Activity

    func fetchTeamActivity() {
        let urlStr = "\(supabaseURL)/rest/v1/watcher_activity?order=created_at.desc&limit=10&select=git_email,activity,activity_type,created_at"
        guard let url = URL(string: urlStr) else { return }

        var request = URLRequest(url: url)
        request.setValue(supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5

        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            guard let data = data, error == nil else { return }
            guard let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }

            let displayFmt = DateFormatter()
            displayFmt.dateFormat = "M/d h:mm a"
            displayFmt.timeZone = TimeZone.current

            let isoFmt = ISO8601DateFormatter()
            isoFmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

            let entries = rows.compactMap { row -> (email: String, activity: String, time: String)? in
                guard let email = row["git_email"] as? String,
                      let activity = row["activity"] as? String,
                      let createdAt = row["created_at"] as? String else { return nil }

                let timeStr: String
                if let date = isoFmt.date(from: createdAt) {
                    timeStr = displayFmt.string(from: date)
                } else {
                    timeStr = String(createdAt.prefix(10))
                }
                return (email: email, activity: activity, time: timeStr)
            }

            DispatchQueue.main.async {
                self?.cachedTeamActivity = entries
            }
        }.resume()
    }

    // MARK: - Actions

    @objc func pauseWatcher() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", "launchctl unload ~/Library/LaunchAgents/\(plistLabel).plist 2>/dev/null"]
        try? task.run()
        task.waitUntilExit()
        isPaused = true
        updateMenu()
    }

    @objc func resumeWatcher() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", "launchctl load ~/Library/LaunchAgents/\(plistLabel).plist 2>/dev/null"]
        try? task.run()
        task.waitUntilExit()
        isPaused = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.updateMenu()
        }
    }

    @objc func startWatcher() {
        resumeWatcher()
    }

    @objc func openLog() {
        NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
    }

    @objc func openRepo() {
        NSWorkspace.shared.open(URL(fileURLWithPath: repoDir))
    }

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
