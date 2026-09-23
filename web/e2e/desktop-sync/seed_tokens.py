"""Write an agent credential bundle into a sandbox `.tokens.enc`.

Invoked by `e2e/desktop-sync/agentToken.ts` with PROGRAMDATA pointed at the
scratch tree FOR THIS INVOCATION ONLY. Uses the agent's own SecureStorage so the
file is written exactly the way the agent will read it — the Fernet key derives
from the machine binding (MachineGuid here), not from the directory, so a sandbox
on this machine decrypts fine while the bundle stays useless anywhere else.

Reads one JSON object on stdin (never argv — argv is world-readable in the
process table) with keys: access_token, expiry, site_id, refresh_token.
Prints one JSON line: {"tokenFile": ..., "dataRoot": ...}.
"""

import json
import os
import sys


def main() -> int:
    payload = json.load(sys.stdin)

    src = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))),
        'agent', 'src',
    )
    sys.path.insert(0, src)

    import shared_utils
    from secure_storage import SecureStorage

    data_root = shared_utils.get_data_path()

    # Never write credentials next to real ones. The caller checks this too; the
    # duplicate is deliberate, because this is the process holding the key.
    if os.path.normcase(os.path.normpath(data_root)) == os.path.normcase(
            os.path.normpath(os.path.join('C:\\', 'ProgramData', 'Owlette'))):
        print('refusing to seed tokens into the live install', file=sys.stderr)
        return 2

    storage = SecureStorage()
    ok = (
        storage.save_refresh_token(payload['refresh_token'])
        and storage.save_access_token(payload['access_token'], float(payload['expiry']))
        and storage.save_site_id(payload['site_id'])
    )
    if not ok:
        print('SecureStorage refused one of the writes', file=sys.stderr)
        return 1

    # Read back through the same class the agent uses: a bundle that cannot be
    # decrypted here would show up as an unauthenticated agent 30 seconds later,
    # with nothing in the log pointing back to this step.
    if not storage.is_configured():
        print('tokens written but SecureStorage.is_configured() is False', file=sys.stderr)
        return 1

    print(json.dumps({'tokenFile': str(storage.token_file), 'dataRoot': data_root}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
