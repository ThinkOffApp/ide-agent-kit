// SPDX-License-Identifier: AGPL-3.0

import Foundation

/// Watch adapter for Apple Watch / Wear OS.
/// Publishes watch-specific signals (wrist raise, screen active, context)
/// and reads derived state for alert routing.
public class WatchAdapter {
    private let client: IntentClient
    private var publishTimer: Timer?

    public init(client: IntentClient) {
        self.client = client
    }

    /// Publish current watch state to intent API.
    public func publishState(
        context: String = "active",
        screenActive: Bool = true,
        wristRaise: Bool = false,
        custom: [String: Any]? = nil
    ) async throws {
        var fields: [String: Any] = [
            "context": context,
            "screen_active": screenActive,
            "wrist_raise": wristRaise,
        ]
        if let custom {
            fields["custom"] = custom
        }
        try await client.patchDevice(fields)
    }

    /// Check how an urgent alert should be delivered.
    public func alertMode() async throws -> AlertMode {
        let derived = try await client.getDerived()
        let urgency = derived["urgency_mode"] as? String ?? "normal"
        let suppressAudio = derived["suppress_audio"] as? Bool ?? false

        switch urgency {
        case "emergency-only":
            return .silent
        case "text-only":
            return .textOnly
        default:
            return suppressAudio ? .textOnly : .full
        }
    }

    /// Start periodic state publishing and heartbeat.
    public func start(interval: TimeInterval = 30.0) {
        stop()
        client.startHeartbeat(interval: interval)
        publishTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task {
                try? await self?.publishState()
            }
        }
    }

    public func stop() {
        publishTimer?.invalidate()
        publishTimer = nil
        client.stopHeartbeat()
    }
}

public enum AlertMode {
    /// Full alert: vibrate + text + optional audio
    case full
    /// Text only: vibrate + text card, no audio
    case textOnly
    /// Silent: no alert unless emergency
    case silent
}
