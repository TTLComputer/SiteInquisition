# Trusting and removing the SiteInquisition CA

SiteInquisition decrypts HTTPS for in-scope hosts by signing certificates with
its own root CA. A device only accepts those certificates if it trusts the CA.

Trusting the CA lets **anyone who has its private key** impersonate any website
to that device. The key is kept in `~/.config/siteinquisition/ca` (on Windows,
`%APPDATA%\SiteInquisition\ca`), encrypted with a key from your OS keyring
(Secret Service on Linux, DPAPI on Windows) when there is one. Install the CA only on devices
you test with, and remove it when you are done.

Find the certificate and its fingerprint with:

```sh
siq ca            # path, SHA-256 fingerprint, expiry, how the key is protected
siq ca --pem > siteinquisition-ca.pem
```

Check the fingerprint on the device after you install it. The app's built-in
browser already trusts the CA for intercepted hosts only, so it needs none of this.

## Linux (system store: curl, wget, most command line tools)

Debian and Ubuntu:

```sh
sudo cp siteinquisition-ca.pem /usr/local/share/ca-certificates/siteinquisition-ca.crt
sudo update-ca-certificates
# remove
sudo rm /usr/local/share/ca-certificates/siteinquisition-ca.crt
sudo update-ca-certificates --fresh
```

Fedora, RHEL and Arch (p11-kit):

```sh
sudo trust anchor --store siteinquisition-ca.pem
# remove
sudo trust anchor --remove siteinquisition-ca.pem
```

Node.js ignores the system store by default; use `NODE_EXTRA_CA_CERTS=siteinquisition-ca.pem`
for one run instead of installing anything. Python `requests` uses `REQUESTS_CA_BUNDLE`.

## Windows (Edge, Chrome, curl.exe and most Windows programs)

Install it for your user only, which needs no administrator rights. Windows
shows the fingerprint and asks you to confirm.

```bat
certutil -user -addstore Root siteinquisition-ca.pem
```

To remove it, in PowerShell (this removes every SiteInquisition CA you trusted,
old ones included):

```powershell
Get-ChildItem Cert:\CurrentUser\Root | Where-Object Subject -like '*O=SiteInquisition*' | Remove-Item
```

Or open `certmgr.msc`, go to Trusted Root Certification Authorities,
Certificates, and use All Tasks, Import (or Delete to remove). Firefox keeps
its own store; see below. Node.js and Python behave as on Linux.

## Chrome and Chromium on Linux

Chrome uses the NSS database in `~/.pki/nssdb`:

```sh
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "SiteInquisition CA" -i siteinquisition-ca.pem
# remove
certutil -d sql:$HOME/.pki/nssdb -D -n "SiteInquisition CA"
```

(`certutil` is in `libnss3-tools`.) Or use Settings, Privacy and security,
Security, Manage certificates, Authorities.

## Firefox

Firefox keeps its own store. Settings, Privacy & Security, Certificates, View
Certificates, Authorities, Import, then tick "Trust this CA to identify
websites". To remove it, select "SiteInquisition CA" in the same list and choose
Delete or Distrust.

## Android

1. Copy `siteinquisition-ca.pem` to the device (rename it `.crt` if the picker hides it).
2. Settings, Security (or Security & privacy), More security settings,
   Encryption & credentials, Install a certificate, CA certificate.
3. Remove it under Encryption & credentials, Trusted credentials, User.

Since Android 7, apps trust user-installed CAs only if their network security
config allows it. Browsers such as Chrome do; most apps built for release do
not, so their HTTPS cannot be decrypted without changing the app.

Point the device at the proxy (Wi-Fi network, Proxy, Manual, your computer's
LAN address and the proxy port), start SiteInquisition with `--lan`, and allow
the device when it shows up in the title bar.

## iOS and iPadOS

Open the certificate on the device (AirDrop, mail, or a web link), then
Settings, General, VPN & Device Management to install the profile, and turn on
full trust under Settings, General, About, Certificate Trust Settings. Remove
the profile in VPN & Device Management.

## IoT devices

Devices that let you add a root CA usually take a PEM file, often in a web
admin page or a provisioning config. Many devices pin certificates or ship a
fixed CA list; those cannot be decrypted, and SiteInquisition lists their
failed handshakes in Project settings, Capture scope under "seen but not in scope" with a pinning warning.

## Rotating or removing the CA

```sh
siq ca rotate    # new CA; install it again on your devices, and restart a running proxy
siq ca remove    # delete the certificate and key from this computer
```

Rotating does not remove the old CA from devices. Remove it from each device
using the steps above first. A CA lasts two years from when it was made; the
expiry date is in `siq ca` and in Settings, Proxy and TLS.

## Uninstalling SiteInquisition

Your projects and the CA stay behind when you remove the app. Remove the CA
from every device that trusts it first (the steps above), then:

1. Run `siq ca remove`.
2. Remove the app: `sudo apt remove siteinquisition` for the .deb, or delete
   the unpacked folder (the .tar.gz and the Windows zip).
3. Delete the data folder (`~/.config/siteinquisition` on Linux,
   `%APPDATA%\SiteInquisition` on Windows) and your project folders.
