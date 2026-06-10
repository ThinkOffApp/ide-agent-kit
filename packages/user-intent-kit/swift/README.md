# UserIntentKit (Swift)

Swift package for Apple Watch, iOS, and macOS. Publishes device signals to the User Intent API and reads derived state for alert routing.

## Add to your project

In Xcode, add this package dependency:

```
https://github.com/ThinkOffApp/user-intent-kit.git
```

Path: `swift/`

Or in `Package.swift`:

```swift
.package(url: "https://github.com/ThinkOffApp/user-intent-kit.git", from: "0.1.0")
```

## Usage

### Apple Watch

```swift
import UserIntentKit

let client = IntentClient(
    baseUrl: "https://antfarm.world/api/v1",
    apiKey: "xfb_your_key",
    userId: "petrus",
    deviceId: "apple-watch"
)

let watch = WatchAdapter(client: client)

// Start publishing state + heartbeat
watch.start()

// Publish specific state
try await watch.publishState(
    context: "active",
    screenActive: true,
    wristRaise: true
)

// Check alert mode before showing notification
let mode = try await watch.alertMode()
switch mode {
case .full:
    // Vibrate + text + audio
case .textOnly:
    // Vibrate + text card only (user in meeting)
case .silent:
    // DND mode, skip unless emergency
}
```

### Read intent state directly

```swift
let intent = try await client.getIntent()
let derived = intent["derived"] as? [String: Any]

let inMeeting = try await client.isInMeeting()
let suppressAudio = try await client.shouldSuppressAudio()
```
