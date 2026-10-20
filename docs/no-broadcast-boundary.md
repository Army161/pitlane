# Inspection network boundary

The inspection process sends structured requests only to a separate RPC gateway. The gateway owns provider credentials and rejects every method except getGenesisHash, getAccountInfo, getSlot and getBlockTime. It ignores caller-provided URLs, headers and upstream identities. It has no signing keys and never fetches token metadata URIs.

This is a capability boundary between processes, not proof of a host network sandbox. Deployment must restrict the worker's egress to its scoped database connection, artifact API and RPC gateway; direct Internet, public RPC, TPU/QUIC, proxy tunnels and gateway-provider credential access must be denied. The gateway must also restrict egress to approved provider destinations and reject redirects.

Launch gate: from the deployed worker identity, demonstrate rejected direct public-RPC access and rejected gateway sendTransaction, simulateTransaction and requestAirdrop requests, with zero upstream calls. Do not perform a real transaction broadcast to test this. If the selected host cannot enforce egress, move the inspection process to infrastructure that can, or document that the hard no-broadcast requirement is unmet and keep production disabled. A source allowlist alone does not meet that requirement.

Local tests verify gateway dispatch rejection and separation of configuration. Hosted egress verification remains pending until owner-approved infrastructure exists.

The gateway now takes a database-locked dispatch snapshot and compares it with its own configured provider identity before upstream HTTP. Independently retained source records use that snapshot even if the profile changes during the call. Shared, versioned database circuits gate calls and hosted admission; every transient retry requires a separate persisted priced intent, bounded calls/cost, and sufficient remaining deadline. Permanent credential or schema failures do not cause repeated reads. Artifact publication independently matches account source bytes, subject and acquisition time, including a lost-response retry with identical bytes. These locally tested controls do not replace the deployed egress proof above.
