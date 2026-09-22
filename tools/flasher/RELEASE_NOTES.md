# Release notes for the SD Flasher

## v0.7.0

The flasher signs in with your console username and password, in its own window: no browser, no code to
approve. Every projector you flash belongs to your account.

- The first time you press FLASH the flasher asks for your console username and password (the same as on the
  website) right under the form. After that it remembers the sign-in on this computer; Sign out is under
  Advanced (sign out and sign in again to switch user).
- Each projector is registered in your account when the card is made and appears under Devices there. The card
  no longer carries the console's enrollment key: it carries only that projector's own token. Flashing a card
  again for the same name re-registers the same projector with a fresh token.
- A name that another account already uses is refused in plain words under Device name; pick another name.
- A view-only account cannot flash: the flasher says so and asks you to have an admin make it an editor.
- The flasher downloads moved behind the console sign-in (the Download page in the top bar). The public home
  page now only offers Sign in and Create an account.

Template for the GitHub release body follows.

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

If macOS instead says the app "is damaged and can't be opened", paste this line into Terminal once and open the
app again: `xattr -d com.apple.quarantine "/Applications/Projection5000 SD Flasher.app"`.

After that it opens normally. macOS asks for your Mac password once per flash (the standard prompt) when the
card is written, asks once to "access files on a removable volume" (click **Allow**), and may put up the
keychain prompt (your Mac user name and password, then **Allow**) when the flasher reads a saved Wi-Fi
password; Cancel just leaves the password field for you to type.

(The extra first-open step goes away once releases are notarized, which needs an Apple Developer account,
US$99 a year: a Developer ID certificate in the build, then `notarytool submit` and `stapler`. Everything
else in `build_mac.sh` stays the same.)

`selfcheck.txt` (Windows) and `selfcheck-mac-arm64.txt` / `selfcheck-mac-intel.txt` (Mac) are the build
self-checks: the bundled image and its sha256, the console the build talks to, the generated first-boot
scripts.
