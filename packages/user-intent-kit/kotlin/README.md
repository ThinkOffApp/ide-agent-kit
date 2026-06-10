# UserIntentKit (Kotlin)

Kotlin library for Wear OS smartwatches and Android apps. Publishes device signals to the User Intent API and reads derived state for alert routing.

Works with any Wear OS watch (Samsung Galaxy Watch, Google Pixel Watch, Mobvoi TicWatch, etc.).

## Usage

### Wear OS

```kotlin
import com.thinkoff.userintent.IntentClient
import com.thinkoff.userintent.WatchAdapter
import kotlinx.coroutines.*

val client = IntentClient(
    baseUrl = "https://antfarm.world/api/v1",
    apiKey = "xfb_your_key",
    userId = "petrus",
    deviceId = "wear-os-watch"
)

val watch = WatchAdapter(client, CoroutineScope(Dispatchers.IO))

// Start publishing state + heartbeat
watch.start()

// Publish specific state
watch.publishState(
    context = "active",
    screenActive = true,
    wristRaise = true
)

// Check alert mode before showing notification
when (watch.alertMode()) {
    AlertMode.FULL -> // vibrate + text + audio
    AlertMode.TEXT_ONLY -> // vibrate + text card only
    AlertMode.SILENT -> // DND, skip unless emergency
}
```

### Read intent state directly

```kotlin
val intent = client.getIntent()
val inMeeting = client.isInMeeting()
val suppressAudio = client.shouldSuppressAudio()
```
