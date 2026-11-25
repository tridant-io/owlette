type Db = FirebaseFirestore.Firestore;

// uid to email, else display name, in one read; a uid with neither is left out
export async function loadUserLabels(db: Db, uids: Iterable<string>): Promise<Record<string, string>> {
  const ids = [...new Set(uids)];
  if (ids.length === 0) return {};
  const snaps = await db.getAll(...ids.map((uid) => db.doc(`users/${uid}`)));
  const labels: Record<string, string> = {};
  for (const snap of snaps) {
    const name = snap.get('email') || snap.get('displayName');
    if (snap.exists && typeof name === 'string' && name) labels[snap.id] = name;
  }
  return labels;
}
