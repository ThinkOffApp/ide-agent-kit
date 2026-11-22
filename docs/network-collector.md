# Connection inventory collector (review draft)

`node bin/iak-network.mjs /absolute/config.json` collects only, with no API write.
Add `publish` to PATCH the `network` field of an existing device slot. Configure
`baseUrl` as https://groupmind.one/api/v1, `userId`, `deviceId`, absolute `keyFile`,
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
