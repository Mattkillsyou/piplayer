// /flasher: the SD flasher downloads and the first-time / every-time steps (any signed-in role).
// The downloads moved here from the public home page once the flasher started signing in with a
// console account: bump FLASHER_VERSION when a release is tagged and all three links follow.
import * as auth from "../auth.js";
import { layout } from "./layout.js";

export const FLASHER_VERSION = "0.7.3";
export const RELEASE = `https://github.com/Mattkillsyou/piplayer/releases/download/v${FLASHER_VERSION}`;

function flasherPage(ctx) {
  auth.requireUser(ctx);
  const content = `<div class="page-head">
  <h1>SD Flasher</h1>
  <span class="page-meta">version <strong>${FLASHER_VERSION}</strong></span>
</div>

<div class="panel">
  <h2>Download</h2>
  <div class="row">
    <a class="button primary" href="${RELEASE}/Projection5000-SD-Flasher-Setup.exe">Download for Windows</a>
    <a class="button primary" href="${RELEASE}/Projection5000-SD-Flasher-mac-arm64.dmg">Download for Mac (Apple Silicon)</a>
    <a class="button primary" href="${RELEASE}/Projection5000-SD-Flasher-mac-intel.dmg">Download for Mac (Intel)</a>
  </div>
  <p class="help">Which Mac do I have? Apple menu, <em>About This Mac</em>. <em>Chip: Apple M1</em> (or M2, M3, M4) means Apple Silicon, <em>Processor: Intel</em> means Intel.</p>
</div>

<div class="panel">
  <h2>First time on this computer</h2>
  <div class="cols">
    <div>
      <h3>Windows</h3>
      <ol>
        <li>Open <code>Projection5000-SD-Flasher-Setup.exe</code> and click <em>Install</em>.</li>
        <li>If Windows says "Windows protected your PC", click <em>More info</em>, then <em>Run anyway</em>.</li>
        <li>Click <em>Yes</em> on the Windows question.</li>
        <li>Open <em>Matt Brown Projection 5000</em> from the Start menu.</li>
      </ol>
    </div>
    <div>
      <h3>Mac</h3>
      <ol>
        <li>Open the <code>.dmg</code> and drag <em>Projection5000 SD Flasher</em> into <em>Applications</em>.</li>
        <li>In Applications, <em>right-click</em> the app, choose <em>Open</em>, then click <em>Open</em> again.
          On macOS 15 (Sequoia) and newer: double-click the app, click <em>Done</em>, open
          <em>System Settings</em>, <em>Privacy &amp; Security</em>, scroll down, click <em>Open Anyway</em>, type
          your Mac password, click <em>Open</em>.</li>
        <li>Type your Mac password when it asks, and click <em>Allow</em> for "access files on a removable volume".</li>
      </ol>
      <p class="help">If macOS says the app "is damaged and can't be opened", paste this line into Terminal
        once and open the app again:<br>
        <code>xattr -d com.apple.quarantine "/Applications/Projection5000 SD Flasher.app"</code></p>
    </div>
  </div>
</div>

<div class="panel">
  <h2>Then, every time</h2>
  <div class="cols">
    <div>
      <ol>
        <li>Open the flasher and sign in with your Projection5000 username and password.</li>
        <li>Put the card in the reader.</li>
        <li>Type a name for the projector, for example <em>Lobby Projector</em>.</li>
        <li>Pick the Raspberry Pi model.</li>
      </ol>
    </div>
    <div>
      <ol start="5">
        <li>Pick the Wi-Fi network and type its password (leave both empty for a wired projector).</li>
        <li>Pick the card, press <em>FLASH</em> and wait for "Done." The card ejects itself.</li>
        <li>Put the card in the projector's Pi and turn it on. It shows up under Devices within a few minutes.</li>
      </ol>
    </div>
  </div>
</div>`;
  return layout(ctx, { title: "SD Flasher", content });
}

export function register(router) {
  router.get("/flasher", flasherPage);
}
