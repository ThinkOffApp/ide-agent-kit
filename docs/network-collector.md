# Connection inventory collector (review draft)

`node bin/iak-network.mjs /absolute/config.json` collects only, with no API write.
Add `publish` to PATCH the `network` field of an existing device slot. Configure
`baseUrl` as the approved API endpoint (localhost or literal tailnet address), `userId`, `deviceId`, absolute `keyFile`,
and `peers` as `{id: existingPeerSlot, address: literalIPv4}` entries.

Linux reports OS interfaces, canonical IPv4 subnets, readable negotiated link
speeds and `ip -j route get` evidence. Missing commands/speeds remain unknown.
Tailscale never acquires a NIC throughput ceiling. macOS interface kind stays
unknown until a platform-specific inventory is added; it is not guessed Ethernet.
Remote interface names are not inferred. No traffic benchmark or listener starts.
There are no fixture measurements, rates or historical timestamps in the collector.

Publishing first reads the existing slot, preserves measured-transfer fields and
other network metadata, then patches only network. It requires an existing slot;
it never registers an identity. This read/merge/write can race another network
publisher: use a single owner until server-side field merge/versioning exists.
Peer route records refreshed by this collector do not replace actual bandwidth
measurements. Ongoing scheduling, HTTP-memory benchmarking and fleet installation
remain separate. This draft has not published to production.

Review revision: host addresses are omitted from reports, Tailscale /32 prefixes
are omitted, and only canonical physical subnet prefixes remain. Route changes
invalidate old throughput and mark its old route; measurements are retained only
when route and local interface match. Links absent from the current complete
collection are removed. Linux Thunderbolt is identified by name; InfiniBand and
unrecognized interface kinds remain unknown. Every interface and link is timestamped.

Real-host preflight: asus1's SSH environment has no `node` executable on PATH,
so the remote dry run did not execute. No runtime was installed. Deployment needs
a verified runtime path or an alternate collector bridge before publication.


Current authorized target plan: Petrus approved host addresses on 22 Nov; the
collector now includes them. The configured base URL may target localhost or a
literal Tailscale IPv4, including local asus3, with an /api/v1 suffix. Redirects
are rejected to avoid credential forwarding. Fleet publication is intended for
the local installation; the room remains on groupmind.one. No write has occurred.
The local asus3 stack is on an older separate Groupmind.one checkout and lacks
today's FleetConnections source; API compatibility/update requires review before
using the collector against it.
