# Nothing that runs unattended may raise a UAC prompt

In 3.2.0 the desktop app saw the service stop during a self-update, tried to restart it and fell back to an elevated command, which put a Windows consent prompt over whatever every machine in the fleet was showing; the same prompt came back on every 3.2.0 to 3.3.x upgrade. We decided that elevation is only ever the answer to a deliberate click. The service, silent installs, desktop auto-start and scheduled tasks never `runas` or ShellExecute-elevate, even when elevating would fix the problem in front of them.

## Consequences

- An automatic path that lacks a right fails, logs and leaves recovery to the service's own watchdogs. Since 3.2.3 the desktop app stands down entirely while an update is in progress.
- This holds for anything new that runs on a managed machine: these screens face an audience, not an operator, and the product promise is that nothing on the machine waits for a person.
