; Windows installer for the SD flasher (Inno Setup 6): build.ps1 compiles this after the exe is built and
; smoke-tested, producing dist\Projection5000-SD-Flasher-Setup.exe. The installer copies the single exe
; (with the OS image appended by build.ps1) into Program Files, adds a Start Menu entry and an
; uninstaller. Version comes from build.ps1 (/DAppVersion=...); the default matches version.txt.

#ifndef AppVersion
  #define AppVersion "0.7.0"
#endif

[Setup]
AppId={{7F1C1D6E-5B0A-4E0B-9C4A-2C1F5B8D0A11}
AppName=Projection5000 SD Flasher
AppVersion={#AppVersion}
AppVerName=Projection5000 SD Flasher {#AppVersion}
AppPublisher=Matt Brown
AppPublisherURL=https://projectors.photogen5000.com
DefaultDirName={autopf}\Projection5000 SD Flasher
DefaultGroupName=Projection5000
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\Projection5000-SD-Flasher.exe
OutputDir=dist
OutputBaseFilename=Projection5000-SD-Flasher-Setup
SetupIconFile=icon.ico
; the exe already carries an xz-compressed OS image: recompressing 500 MB gains nothing and takes minutes
Compression=none
SolidCompression=no
; writing a card needs administrator rights, so the installer asks once and installs for every user
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "dist\Projection5000-SD-Flasher.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Projection5000 SD Flasher"; Filename: "{app}\Projection5000-SD-Flasher.exe"
Name: "{autodesktop}\Projection5000 SD Flasher"; Filename: "{app}\Projection5000-SD-Flasher.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Put a shortcut on the desktop"; GroupDescription: "Shortcuts:"

[Run]
Filename: "{app}\Projection5000-SD-Flasher.exe"; Description: "Open the SD Flasher now"; Flags: nowait postinstall skipifsilent shellexec
