# third-party notices

The Owlette agent redistributes the following third-party components in binary
form. This file provides the notices, license identification, and source
offers those licenses require. Full license texts are installed alongside the
agent as noted below.

## temperature monitoring stack

**Notice: this product uses LibreHardwareMonitor, which is covered by the
Mozilla Public License 2.0, and PawnIO sensor modules, which are covered by
the GNU Lesser General Public License 2.1.**

| component | version | license | source |
|---|---|---|---|
| HardwareMonitor (PyHardwareMonitor) | 1.2.1 | BSD-3-Clause | https://github.com/snip3rnick/PyHardwareMonitor |
| LibreHardwareMonitorLib | 0.9.6 | MPL-2.0 | https://github.com/LibreHardwareMonitor/LibreHardwareMonitor |
| PawnIO modules (embedded `*.bin` resources) | 2.2 | LGPL-2.1 | https://github.com/namazso/PawnIO.Modules |
| PawnIO driver + installer | 2.2.0 | GPL-2.0-or-later with IOCTL interface exception (driver); freeware (installer) | https://github.com/namazso/PawnIO — https://pawnio.eu/ |
| DiskInfoToolkit | (bundled with LibreHardwareMonitorLib) | MPL-2.0 | https://github.com/LibreHardwareMonitor |
| RAMSPDToolkit-NDD | (bundled with LibreHardwareMonitorLib) | MPL-2.0 | https://github.com/LibreHardwareMonitor |
| HidSharp | (bundled with LibreHardwareMonitorLib) | Apache-2.0 | https://www.zer7.com/software/hidsharp |
| pythonnet | 3.2.1 | MIT | https://github.com/pythonnet/pythonnet |

License texts installed with the agent:

- MPL-2.0: `python\Lib\site-packages\HardwareMonitor\lib\LICENSE`
- BSD-3-Clause (PyHardwareMonitor): `python\Lib\site-packages\hardwaremonitor-1.2.1.dist-info\licenses\LICENSE`
- LGPL-2.1: `LGPL-2.1.txt` (next to this file)

**Source offer (MPL-2.0 §3.2 / LGPL-2.1 §6):** the components above are used
unmodified; complete corresponding source for each is available from the
source URLs listed, at the versions stated. If a listed URL becomes
unavailable, write to hey@tridant.io and we will provide the source for any
covered component we ship.

The PawnIO kernel driver is GPL-2.0-or-later with an explicit exception
permitting independent programs to communicate with it solely through its
device I/O control interface, which is how this product uses it. The PawnIO
installer binary is redistributed as provided by its author.

## other bundled components

The embedded CPython runtime and the remaining Python packages the agent
bundles each carry their own licenses (PSF-2.0 and assorted permissive
licenses); their texts ship in the corresponding `*.dist-info` directories
under `python\Lib\site-packages\`.
