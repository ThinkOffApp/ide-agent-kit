// SPDX-License-Identifier: AGPL-3.0

import Foundation

/// REST client for the User Intent API.
/// Talks to an Ant Farm instance hosting profile + intent endpoints.
public class IntentClient {
    private let baseUrl: String
    private let apiKey: String
    private let userId: String
    private let deviceId: String?
    private let timeoutInterval: TimeInterval
    private var heartbeatTimer: Timer?

    public init(
        baseUrl: String,
        apiKey: String,
        userId: String,
        deviceId: String? = nil,
        timeoutInterval: TimeInterval = 10.0
    ) {
        self.baseUrl = baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.apiKey = apiKey
        self.userId = userId
        self.deviceId = deviceId
        self.timeoutInterval = timeoutInterval
    }

    // MARK: - Profile

    public func getProfile() async throws -> [String: Any] {
        return try await request(method: "GET", path: "/profile/\(userId)")
    }

    // MARK: - Intent

    public func getIntent() async throws -> [String: Any] {
        return try await request(method: "GET", path: "/intent/\(userId)")
    }

    public func patchDevice(_ fields: [String: Any]) async throws {
        guard let deviceId else { throw IntentError.noDeviceId }
        let _ = try await request(method: "PATCH", path: "/intent/\(userId)/\(deviceId)", body: fields)
    }

    public func patchAgent(name: String, fields: [String: Any]) async throws {
        let _ = try await request(method: "PATCH", path: "/intent/\(userId)/agents/\(name)", body: fields)
    }

    public func removeDevice(_ id: String? = nil) async throws {
        let target = id ?? deviceId
        guard let target else { throw IntentError.noDeviceId }
        let _ = try await request(method: "DELETE", path: "/intent/\(userId)/\(target)")
    }

    // MARK: - Derived state helpers

    public func getDerived() async throws -> [String: Any] {
        let intent = try await getIntent()
        return intent["derived"] as? [String: Any] ?? [:]
    }

    public func isInMeeting() async throws -> Bool {
        let derived = try await getDerived()
        return (derived["urgency_mode"] as? String) == "text-only"
    }

    public func shouldSuppressAudio() async throws -> Bool {
        let derived = try await getDerived()
        return (derived["suppress_audio"] as? Bool) ?? false
    }

    public func preferredDevice() async throws -> String? {
        let derived = try await getDerived()
        return derived["preferred_device"] as? String
    }

    // MARK: - Heartbeat

    public func heartbeat() async throws {
        guard let deviceId else { throw IntentError.noDeviceId }
        let _ = try await request(method: "PATCH", path: "/intent/\(userId)/\(deviceId)", body: ["heartbeat": true])
    }

    public func startHeartbeat(interval: TimeInterval = 30.0) {
        stopHeartbeat()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: max(interval, 10.0), repeats: true) { [weak self] _ in
            Task {
                try? await self?.heartbeat()
            }
        }
    }

    public func stopHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
    }

    // MARK: - Internal

    private func request(method: String, path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: "\(baseUrl)\(path)") else {
            throw IntentError.invalidUrl
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = timeoutInterval
        req.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let body, method != "GET", method != "DELETE" {
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: req)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw IntentError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let bodyText = String(data: data, encoding: .utf8) ?? ""
            throw IntentError.httpError(statusCode: httpResponse.statusCode, body: bodyText)
        }

        if data.isEmpty { return [:] }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }

        return json
    }
}

public enum IntentError: Error {
    case noDeviceId
    case invalidUrl
    case invalidResponse
    case httpError(statusCode: Int, body: String)
}
