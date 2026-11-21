// gate g0, the windows half: measures owlette swoop's webview2 over cdp, which
// only a debug build of desktop/viewer opens (127.0.0.1:9222). start one on an
// owlette.app page, then from web/:
//   node ../dev/active/swoop-viewer/spike/measure-webview2.mjs --phase pre
//   node ../dev/active/swoop-viewer/spike/measure-webview2.mjs --phase post
// pre (signed out, on /login): engine capabilities, codec probes, visibility
// when minimised or covered, window.open, f5 / ctrl+r / f12 as real keys, the
// passkey autofill and the google button. post (a swoop window with a live
// session): fullscreen, keyboard and pointer lock, the stats overlay, what the
// peer connection negotiated, and visibility while minimised. prints a markdown
// table; screenshots go to %TEMP%\owlette-g0. windows only (user32 via powershell).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// playwright lives in web/node_modules: resolve it there whatever the cwd
const { chromium } = createRequire(new URL('../../../../web/package.json', import.meta.url))('playwright');

const phase = process.argv[process.argv.indexOf('--phase') + 1];
if (!['pre', 'post'].includes(phase)) {
  console.error('usage: node measure-webview2.mjs --phase pre|post');
  process.exit(2);
}
const CDP = 'http://127.0.0.1:9222';
const PLAYOUT_DELAY = 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay';
const OUT = join(tmpdir(), 'owlette-g0');
const LOG = join(process.env.LOCALAPPDATA ?? '', 'app.owlette.swoop-viewer', 'logs', 'owlette-swoop-viewer.log');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const rows = [];
const row = (item, result, evidence = '') => rows.push(`| ${cell(item)} | ${cell(result)} | ${cell(evidence)} |`);

// the native half: find the viewer's windows, minimise, restore, raise, send
// keys, capture the screen. the raise is a click on the title bar: the
// foreground lock refuses SetForegroundWindow from here, and the alt-tap trick
// puts the viewer in system-menu mode, which stalls webview2 (the lone-alt row)
const USER32 = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace G0 -Name U -MemberDefinition @'
public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct GUI { public int cb; public uint flags; public IntPtr a, f, c, m, s, k; public RECT r; }
[DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint t, ref GUI g);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
[void][G0.U]::SetProcessDPIAware()
function Thread($h) { $p = [uint32]0; [G0.U]::GetWindowThreadProcessId($h, [ref]$p) }
function Front($h) {
  if ([G0.U]::GetForegroundWindow() -ne $h) {
    $r = New-Object G0.U+RECT; [void][G0.U]::GetWindowRect($h, [ref]$r); $was = [System.Windows.Forms.Cursor]::Position
    [void][G0.U]::SetCursorPos($r.L + 300, $r.T + 20); [G0.U]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [G0.U]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400; [void][G0.U]::SetCursorPos($was.X, $was.Y)
  }
  [G0.U]::GetForegroundWindow() -eq $h
}
function MenuMode($h) { $g = New-Object G0.U+GUI; $g.cb = [Runtime.InteropServices.Marshal]::SizeOf($g); [void][G0.U]::GetGUIThreadInfo((Thread $h), [ref]$g); ($g.flags -band 0xC) -ne 0 }
function Tap($vk) { [G0.U]::keybd_event($vk, 0, 0, [UIntPtr]::Zero); [G0.U]::keybd_event($vk, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 600 }
function Shot($h) { $r = New-Object G0.U+RECT; [void][G0.U]::GetWindowRect($h, [ref]$r); $b = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T); [System.Drawing.Graphics]::FromImage($b).CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b }
function Hash($h) { $m = New-Object IO.MemoryStream; (Shot $h).Save($m, [System.Drawing.Imaging.ImageFormat]::Bmp); [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash($m.ToArray())) }
`;
const encode = (body) => Buffer.from(USER32 + body, 'utf16le').toString('base64');
const ps = (body) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(body)], { encoding: 'utf8' }).trim();
const titles = () => ps(`Get-Process | Where-Object MainWindowTitle | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" }`).split(/\r?\n/);
const changed = (before) => titles().filter((title) => !before.includes(title)).join('; ') || 'none';
const targets = async () => (await fetch(`${CDP}/json/list`)).json();
const logMark = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0);
const logSince = (mark) => (existsSync(LOG) ? readFileSync(LOG, 'utf8').slice(mark).trim().split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\[[^\]]+\]/, '')).join(' / ') : '') || 'nothing';

// the viewer window showing `page`: the visible top-level window whose rect is
// closest to where the page says it is (main and swoop windows share a title)
async function windowFor(page) {
  const at = await page.evaluate(() => [screenX, screenY, outerWidth, outerHeight].map((v) => v * devicePixelRatio));
  const found = ps(`$out = New-Object System.Collections.ArrayList; $ids = @(Get-Process owlette-swoop-viewer).Id
[void][G0.U]::EnumWindows([G0.U+EnumProc]{ param($h, $l) $p = [uint32]0; [void][G0.U]::GetWindowThreadProcessId($h, [ref]$p)
  if ($ids -contains $p -and [G0.U]::IsWindowVisible($h)) { $r = New-Object G0.U+RECT; [void][G0.U]::GetWindowRect($h, [ref]$r); [void]$out.Add("$h,$($r.L),$($r.T),$($r.R - $r.L),$($r.B - $r.T)") }; $true }, [IntPtr]::Zero)
$out -join ';'`);
  const score = ([, ...rect]) => rect.reduce((sum, value, i) => sum + Math.abs(value - at[i]), 0);
  const windows = found.split(';').filter(Boolean).map((entry) => entry.split(',').map(Number));
  if (!windows.length) throw new Error('no visible owlette swoop window');
  return windows.sort((a, b) => score(a) - score(b))[0][0];
}

async function visibility(page, hwnd, minimisedMs) {
  const state = () => page.evaluate(() => `${document.visibilityState}, hasFocus ${document.hasFocus()}`);
  await page.evaluate(() => {
    window.__g0vis = [];
    document.addEventListener('visibilitychange', () => window.__g0vis.push(document.visibilityState));
  });
  ps(`[void](Front ([IntPtr]${hwnd}))`);
  row('visibilityState, window in front', await state());
  ps(`[void][G0.U]::ShowWindow([IntPtr]${hwnd}, 6)`);
  await sleep(minimisedMs);
  const iconic = ps(`[G0.U]::IsIconic([IntPtr]${hwnd})`);
  row(`visibilityState, minimised ${minimisedMs / 1000} s`, await state(), `ShowWindow(hwnd, 6); IsIconic: ${iconic}; read over cdp`);
  ps(`[void][G0.U]::ShowWindow([IntPtr]${hwnd}, 9); [void](Front ([IntPtr]${hwnd}))`);
  await sleep(1000);
  row('visibilityState, restored', await state(), 'ShowWindow(hwnd, 9)');
  // a borderless topmost form over every screen for 3 s
  const cover = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', encode(`$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$f.Show(); 'shown'; $w = [Diagnostics.Stopwatch]::StartNew(); while ($w.ElapsedMilliseconds -lt 3000) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }; $f.Close()`)]);
  await new Promise((resolve) => cover.stdout.once('data', resolve));
  await sleep(2000);
  row('visibilityState, covered by a topmost window', await state(), 'borderless topmost form over the virtual screen');
  await new Promise((resolve) => cover.once('exit', resolve));
  row('visibilitychange events seen', (await page.evaluate(() => window.__g0vis.join(' → '))) || 'none');
}

async function realKey(page, hwnd, name, keys) {
  const before = new Set((await targets()).map((target) => target.id));
  const mark = logMark();
  await page.evaluate(() => (window.__g0key = true));
  const front = ps(`$ok = Front ([IntPtr]${hwnd}); [System.Windows.Forms.SendKeys]::SendWait('${keys}'); $ok`);
  await sleep(2500);
  await page.waitForLoadState('load').catch(() => {});
  const after = await page
    .evaluate(() => ({ reloaded: window.__g0key !== true, nav: performance.getEntriesByType('navigation')[0]?.type }))
    .catch((error) => ({ reloaded: '?', nav: error.message }));
  const added = (await targets()).filter((target) => !before.has(target.id)).map((target) => `${target.type} ${target.url}`);
  const devtools = ps(`(Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Where-Object MainWindowTitle -like 'DevTools*' | ForEach-Object { $t = $_.MainWindowTitle; [void]$_.CloseMainWindow(); $t }) -join '; '`);
  row(`${name} sent as a real key`, `reloaded: ${after.reloaded}; devtools window: ${devtools || 'none'}`,
    `foreground: ${front}; navigation type after: ${after.nav}; new cdp targets: ${added.join(', ') || 'none'}; viewer log: ${logSince(mark)}`);
}

// a lone alt that the page does not take reaches the host's DefWindowProc:
// system-menu mode, and webview2's browser thread stops answering until it ends
async function loneAlt(page, hwnd) {
  const cdpAnswers = () => fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(3000) }).then(() => 'answers', () => 'no answer in 3 s');
  // a counter repainted every frame: screen captures 1 s apart tell whether the
  // page still paints while the browser thread is stuck
  await page.evaluate(() => {
    window.__g0alt = [];
    addEventListener('keydown', (event) => window.__g0alt.push(event.key), true);
    const tick = Object.assign(document.createElement('div'), { id: 'g0tick' });
    tick.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;font:32px monospace;background:#000;color:#fff';
    document.body.append(tick);
    const loop = () => {
      if (!tick.isConnected) return;
      tick.textContent = String(Math.round(performance.now()));
      requestAnimationFrame(loop);
    };
    loop();
  });
  const [control, menu, painting] = ps(`$h = [IntPtr]${hwnd}; [void](Front $h); $a = Hash $h; Start-Sleep 1; $b = Hash $h
Tap 0x12; $c = Hash $h; Start-Sleep 1; $d = Hash $h; "$($a -ne $b) $(MenuMode $h) $($c -ne $d)"`).split(' ');
  const during = await cdpAnswers();
  const after = ps(`Tap 0x1B; MenuMode ([IntPtr]${hwnd})`);
  const back = await cdpAnswers();
  const seen = await page.evaluate(() => {
    document.getElementById('g0tick')?.remove();
    return `${window.__g0alt.join(', ') || 'nothing'}, hasFocus ${document.hasFocus()}`;
  });
  row('lone Alt tap (keybd_event), viewer in front', `host in system-menu mode: ${menu}; cdp meanwhile: ${during}; page kept painting: ${painting}`,
    `paint check control (no menu mode): ${control}; after an Esc tap: menu mode ${after}, cdp ${back}; keydowns the page saw: ${seen}`);
}

async function pre(page, origin) {
  const caps = await page.evaluate(async () => {
    const probe = { width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60 };
    const settle = (promise) => promise.then((value) => String(value), (error) => `rejected ${error.name}`);
    const decode = async (contentType) => {
      try {
        const { supported, smooth, powerEfficient } = await navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', video: { contentType, ...probe } });
        return { supported, smooth, powerEfficient };
      } catch (error) {
        return { error: error.name };
      }
    };
    const types = ['video/H264;codecs=avc1.64002A', 'video/H265;codecs=hev1.1.6.L123.B0', 'video/H264', 'video/H265', 'video/VP9', 'video/AV1'];
    const receiver = RTCRtpReceiver.getCapabilities('video');
    const permission = (name) => navigator.permissions.query({ name }).then((status) => status.state, (error) => `threw ${error.name}`);
    const webCodecsHevc = typeof VideoDecoder === 'undefined' ? 'no VideoDecoder'
      : await settle(VideoDecoder.isConfigSupported({ codec: 'hev1.1.6.L123.B0', hardwareAcceleration: 'prefer-hardware' }).then((s) => s.supported));
    return {
      ua: navigator.userAgent,
      brands: (navigator.userAgentData?.brands ?? []).map((brand) => `${brand.brand} ${brand.version}`).join(', '),
      keyboard: `'keyboard' in navigator: ${'keyboard' in navigator}; typeof lock: ${typeof navigator.keyboard?.lock}`,
      fullscreen: document.fullscreenEnabled,
      pointerLock: 'requestPointerLock' in Element.prototype,
      clipboard: ['readText', 'writeText', 'read', 'write'].map((m) => `${m} ${typeof navigator.clipboard?.[m]}`).join(', '),
      clipboardPermissions: `read ${await permission('clipboard-read')}, write ${await permission('clipboard-write')}`,
      webauthn: typeof window.PublicKeyCredential,
      uvpa: window.PublicKeyCredential ? await settle(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()) : 'n/a',
      conditional: window.PublicKeyCredential?.isConditionalMediationAvailable ? await settle(PublicKeyCredential.isConditionalMediationAvailable()) : 'n/a',
      decode: Object.fromEntries(await Promise.all(types.map(async (type) => [type, await decode(type)]))),
      mimeTypes: [...new Set(receiver.codecs.map((codec) => codec.mimeType))],
      extensions: receiver.headerExtensions.map((extension) => extension.uri),
      webCodecsHevc,
      tauri: typeof window.__TAURI_INTERNALS__,
    };
  });
  const brief = (d) => (d.error ? `threw ${d.error}` : `supported ${d.supported} / smooth ${d.smooth} / powerEfficient ${d.powerEfficient}`);
  row('user agent', caps.ua, `brands: ${caps.brands}`);
  row('app token in UA', /owlette-swoop-viewer\/\S+$/.test(caps.ua), 'what web/lib/swoop/viewerApp.ts matches');
  row('keyboard lock api', caps.keyboard);
  row('document.fullscreenEnabled', caps.fullscreen);
  row("'requestPointerLock' in Element.prototype", caps.pointerLock);
  row('navigator.clipboard', caps.clipboard, `permissions.query: ${caps.clipboardPermissions}`);
  row('PublicKeyCredential', caps.webauthn, `isUserVerifyingPlatformAuthenticatorAvailable: ${caps.uvpa}; isConditionalMediationAvailable: ${caps.conditional}`);
  for (const [type, result] of Object.entries(caps.decode)) row(`decodingInfo webrtc ${type} 1080p60 8 Mbps`, brief(result));
  // the same decision probeClientCaps makes (web/lib/swoop/clientCaps.ts)
  const hevc = caps.decode['video/H265;codecs=hev1.1.6.L123.B0'];
  const ladder = caps.mimeTypes.some((m) => m.toLowerCase() === 'video/h265') && hevc.supported && hevc.powerEfficient ? 'hevc, h264' : 'h264';
  row('codec ladder the app would offer', ladder, `receiver mimeTypes: ${caps.mimeTypes.join(', ')}; webcodecs hevc (diagnostic): ${caps.webCodecsHevc}`);
  row('receiver offers playout-delay', caps.extensions.includes(PLAYOUT_DELAY), `headerExtensions: ${caps.extensions.join(', ')}`);
  row('window.__TAURI_INTERNALS__ on the remote page', caps.tauri);

  const hwnd = await windowFor(page);
  const onLogin = new URL(page.url()).pathname === '/login';
  if (onLogin) {
    // conditional ui lists passkeys in the email field's autofill dropdown,
    // which is browser ui: the native capture sees it, the cdp one does not
    ps(`[void](Front ([IntPtr]${hwnd}))`);
    await page.locator('#email').click();
    await sleep(1500);
    await page.screenshot({ path: join(OUT, 'passkey-cdp.png') });
    ps(`(Shot ([IntPtr]${hwnd})).Save('${join(OUT, 'passkey-native.png')}')`);
    const started = await page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/api/passkeys/authenticate/options')));
    row('passkey conditional ui (email field focused by a real click)', `conditional ceremony started: ${started}`, `screenshots: ${OUT}\\passkey-cdp.png, passkey-native.png`);
  }

  const before = new Set((await targets()).map((target) => target.id));
  let shown = titles();
  let mark = logMark();
  // the browser's retitle is the evidence, so it is masked when that page is
  // already its active tab
  const docs = `${origin}/docs/dashboard/swoop`;
  const opened = await page.evaluate((url) => (window.open(url, '_blank') === null ? 'null' : 'a window'), docs);
  await sleep(3000);
  const added = (await targets()).filter((target) => !before.has(target.id)).map((target) => target.url);
  row(`window.open('${docs}', '_blank')`, `returned ${opened}; new cdp targets: ${added.join(', ') || 'none'}`, `windows retitled: ${changed(shown)}; viewer log: ${logSince(mark)}`);

  await visibility(page, hwnd, 1000);
  await realKey(page, hwnd, 'F5', '{F5}');
  await realKey(page, hwnd, 'Ctrl+R', '^r');
  await realKey(page, hwnd, 'F12', '{F12}');
  await loneAlt(page, hwnd);

  if (onLogin) {
    shown = titles();
    mark = logMark();
    // a refused popup earlier in this page's life swaps the button for a notice
    await page.getByRole('button', { name: /continue with google|try google anyway/i }).click();
    await sleep(4000);
    await page.screenshot({ path: join(OUT, 'google.png') });
    const lines = await page.evaluate(() => document.body.innerText.split('\n').filter((line) => /google|popup|blocked|browser/i.test(line)).slice(0, 6).join(' / '));
    row('continue with google (real click)', lines || 'no google text on the page', `windows retitled: ${changed(shown)}; viewer log: ${logSince(mark)}; screenshot ${OUT}\\google.png`);
    await page.goto(`${origin}/swoop`);
  } else {
    row('sign-in page items', `not measured: the viewer is signed in (${page.url()})`);
  }
}

async function post(page) {
  const badge = () => page.locator('[data-testid="session-badge"]').textContent().catch(() => 'no badge');
  const show = page.getByRole('button', { name: 'show latency stats' });
  if (await show.count()) await show.click();
  await sleep(2000);
  row('session badge', await badge());
  row('stats overlay', await page.locator('[aria-label="latency breakdown"]').innerText().catch(() => 'not found'));
  row('sessionStorage codec choice', await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('owlette.swoop.codec/')).map((k) => `${k}=${sessionStorage.getItem(k)}`).join(', ') || 'none (auto)'));

  // the page keeps its RTCPeerConnection private: find it on the heap
  const cdp = await page.context().newCDPSession(page);
  const { result: proto } = await cdp.send('Runtime.evaluate', { expression: 'RTCPeerConnection.prototype' });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.objectId });
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId, awaitPromise: true, returnByValue: true,
    functionDeclaration: `async function () {
      const out = [];
      for (const pc of this) {
        if (pc.connectionState === 'closed') continue;
        const stats = [...(await pc.getStats()).values()];
        const byId = new Map(stats.map((s) => [s.id, s]));
        const video = stats.find((s) => s.type === 'inbound-rtp' && s.kind === 'video') ?? {};
        const pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
        const remote = pair ? byId.get(pair.remoteCandidateId) : undefined;
        const extensions = pc.getReceivers().filter((r) => r.track.kind === 'video').flatMap((r) => r.getParameters().headerExtensions.map((h) => h.uri));
        out.push({ state: pc.connectionState, codec: byId.get(video.codecId)?.mimeType, size: video.frameWidth + 'x' + video.frameHeight,
          fps: video.framesPerSecond, decoder: video.decoderImplementation, powerEfficient: video.powerEfficientDecoder,
          jitterMs: video.jitterBufferEmittedCount ? Math.round((1000 * video.jitterBufferDelay) / video.jitterBufferEmittedCount) : null,
          playoutDelay: extensions.includes('${PLAYOUT_DELAY}'), route: remote ? remote.candidateType + '/' + remote.protocol : null });
      }
      return out;
    }`,
  });
  for (const pc of result.value ?? []) {
    row('negotiated (RTCPeerConnection.getStats)', `${pc.codec} ${pc.size} @ ${pc.fps} fps, playout-delay negotiated: ${pc.playoutDelay}`, JSON.stringify(pc));
  }
  if (!result.value?.length) row('negotiated (RTCPeerConnection.getStats)', 'no open peer connection found on the heap');

  await page.getByRole('button', { name: 'fullscreen with keyboard and mouse capture' }).click();
  await sleep(1500);
  const full = await page.evaluate(async () => {
    const element = document.fullscreenElement;
    const lock = navigator.keyboard?.lock ? await navigator.keyboard.lock().then(() => 'resolved', (e) => `rejected ${e.name}: ${e.message}`) : 'no api';
    return {
      element: element ? `${element.tagName.toLowerCase()} tabindex=${element.getAttribute('tabindex')}` : 'null',
      size: `window ${outerWidth}x${outerHeight} at ${screenX},${screenY}; screen ${screen.width}x${screen.height}`,
      pointer: document.pointerLockElement ? document.pointerLockElement.tagName.toLowerCase() : 'null',
      lock,
      bar: document.querySelector('[data-testid="session-bar"]')?.innerText,
    };
  });
  row('document.fullscreenElement after the toolbar button', full.element, full.size);
  row('navigator.keyboard.lock() in fullscreen', full.lock);
  row('pointer lock after the toolbar button', full.pointer, `toolbar text: ${full.bar}`);
  await page.evaluate(() => {
    navigator.keyboard?.unlock();
    document.exitPointerLock();
    return document.fullscreenElement ? document.exitFullscreen() : undefined;
  });
  await sleep(1000);

  const hwnd = await windowFor(page);
  // alt and esc reach the machine too: the page forwards what it takes
  await loneAlt(page, hwnd);
  await visibility(page, hwnd, 10000);
  row('session badge after 10 s minimised', await badge(), 'did the freeze watchdog spend a reconnect?');
}

const browser = await chromium.connectOverCDP(CDP);
const pages = browser.contexts().flatMap((context) => context.pages());
const owlette = pages.filter((p) => /^https:\/\/(dev\.)?owlette\.app\//.test(p.url()));
const isSession = (p) => /^\/swoop\/[^/]+\/[^/]+$/.test(new URL(p.url()).pathname);
const page = phase === 'post' ? owlette.find(isSession) : owlette.find((p) => !isSession(p)) ?? owlette[0];
if (!page) {
  console.error(phase === 'post' ? 'no swoop window with a session: open one from the picker first' : 'no owlette.app page in the viewer');
  process.exit(1);
}
const origin = new URL(page.url()).origin;
let failure = null;
await (phase === 'pre' ? pre(page, origin) : post(page)).catch((error) => (failure = error));
if (failure) row('script stopped here', failure.message.split('\n')[0]);
console.log(`### ${phase} — ${new Date().toISOString()} — ${page.url()}\n\n| item | result | evidence |\n| --- | --- | --- |\n${rows.join('\n')}`);
// drop the cdp socket without closing anything in the viewer
process.exit(failure ? 1 : 0);
