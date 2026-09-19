"""A streamer stand-in that speaks the stdin/stdout half of PROTOCOL.md section 6.

Launched as a real child process by test_swoop_wiring so the spawn, the kill
line and the exit code go through actual pipes rather than a mock. It reads the
bundle as stdin line 1 and never echoes it -- the bundle carries session keys,
and a test fixture that printed one would put it in a log file.
"""

import json
import sys


def main():
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    bundle = stdin.readline()
    if not bundle:
        return 10  # EXIT_BUNDLE_INVALID: the pipe closed before the bundle

    stdout.write(json.dumps({'type': 'ready'}).encode() + b'\n')
    stdout.flush()

    while True:
        line = stdin.readline()
        if not line:
            break  # the service is gone
        try:
            message = json.loads(line.decode('utf-8', 'replace'))
        except ValueError:
            continue
        if isinstance(message, dict) and message.get('type') == 'kill':
            stdout.write(json.dumps({'type': 'exiting'}).encode() + b'\n')
            stdout.flush()
            break

    return 0


if __name__ == '__main__':
    sys.exit(main())
