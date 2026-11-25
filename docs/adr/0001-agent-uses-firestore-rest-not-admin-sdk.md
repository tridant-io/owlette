# The agent talks to Firestore over REST with its own token, never firebase_admin

Until 2.1 every machine carried a Firebase service-account key and used the Admin SDK, which bypasses security rules, so any one machine's credentials could read and write the whole database. In 2.1 the agent moved to its own Firestore REST client authenticated with a per-machine OAuth token, which keeps every agent read and write subject to `firestore.rules`, scoped to its own site and machine.

## Consequences

- Never import `firebase_admin` or ship a service-account file in the agent. The SDK-shaped surface of `firestore_rest_client.py` exists only to make the migration a drop-in.
- A change to `firestore.rules` can break fielded agents, because they are clients of the rules rather than exempt from them.
- Document listeners poll adaptively rather than stream, so commands reach a machine within seconds, not instantly.
