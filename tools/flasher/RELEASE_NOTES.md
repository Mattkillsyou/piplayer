# Release notes template for the SD Flasher

Copy the block below into the GitHub release body (`gh release create` is done by hand; the macOS workflow
`.github/workflows/flasher-mac.yml` attaches the two DMGs when a release is published, the Windows exe is
uploaded by hand after `build.ps1`). Fill in the bracketed parts; keep the download lines as they are, the
Mac first-open steps included, until the app is notarized.

---

## Matt Brown's Projection5000 SD Flasher v[X.Y.Z]

[One line: what changed for the person flashing cards.]

- [Change, in plain words.]
- [Change.]

Bundled image: [2026-09-15-raspios-trixie-arm64-lite.img.xz] (sha256 [first 8 hex]...). Built from [commit].

**Windows:** download `Projection5000-SD-Flasher.exe`, run it (accept the "Run anyway" on SmartScreen and the
administrator prompt), name the Pi, pick the model, pick the card, press FLASH.

**Mac:** download `Projection5000-SD-Flasher-mac-arm64.dmg` (Apple Silicon: M1, M2, M3, M4) or
`Projection5000-SD-Flasher-mac-intel.dmg` (an Intel Mac), open it and drag **Projection5000 SD Flasher** to
Applications. The app is signed but not notarized, so the very first open needs one extra step:

- macOS 14 and earlier: in Applications, **right-click** the app, choose **Open**, then click **Open** again.
- macOS 15 (Sequoia) and newer: double-click the app and click **Done**, then open **System Settings**,
  **Privacy & Security**, scroll down to the line saying the app was blocked, click **Open Anyway**, enter
  your Mac password and click **Open**.

After that it opens normally. macOS asks for your Mac password once per flash (the standard prompt) when the
card is written, and may ask **Allow** when the flasher reads a saved Wi-Fi password from your keychain.

(The extra first-open step goes away once releases are notarized, which needs an Apple Developer account,
US$99 a year: a Developer ID certificate in the build, then `notarytool submit` and `stapler`. Everything
else in `build_mac.sh` stays the same.)

`selfcheck.txt` (Windows) and `selfcheck-mac-arm64.txt` / `selfcheck-mac-intel.txt` (Mac) are the build
self-checks: the bundled image and its sha256, the console the build talks to, the generated first-boot
scripts.
