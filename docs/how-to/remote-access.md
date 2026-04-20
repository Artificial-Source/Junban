# Use remote access from the desktop app

Use this when you want to open your packaged desktop Junban session from another device on the same trusted network or over Tailscale.

## Before you start

- Use a **packaged desktop build**.
- Keep access on a **trusted/private network** such as your LAN or Tailscale.
- Do **not** expose the built-in remote-access port directly to the public internet.

## Start remote access

1. Open `Settings -> Data -> Remote Access` in the desktop app.
2. Choose a port.
3. Enable **Protect remote access with a password** and set the password if you want another
   device on your LAN or Tailscale network to connect.
4. Optional: enable auto-start if you want the endpoint available whenever the app opens.
5. Click **Start remote access**.

The local URL is always host-only. Without a password, access stays limited to the desktop machine
over localhost/loopback. For another device, enable password protection and then open your desktop
machine's LAN or Tailscale IP with the same port. Password-protected mode listens on both IPv4 and
IPv6 when the desktop host supports IPv6, so remote devices can use either address family.

## What to expect while it is running

- The desktop window shows a lock banner and keeps the **Stop remote access** control available.
- Local desktop write actions are blocked while the remote browser is active, including quick capture and Settings import.
- Only one remote browser session can hold access at a time.

## Stop or switch devices

1. Go back to the desktop app.
2. Click **Stop remote access** from the banner or `Settings -> Data -> Remote Access`.
3. Start remote access again if you want to reconnect from a different browser/device.

## Troubleshooting

### Another browser already has access

Stop remote access from the desktop app, then start it again and reconnect from the browser you want to use.

### Password prompt keeps appearing

Make sure you are reconnecting from the same browser session. The authorization is kept in a local browser cookie after a successful login.

### Another device cannot connect while passwordless mode is enabled

That is expected. Passwordless remote access is intentionally limited to localhost/loopback. Enable
password protection to expose the session to LAN or Tailscale devices.

### An IPv6 LAN or Tailscale address still does not connect

Password-protected mode will also listen on IPv6 when the desktop host has IPv6 available. If it
still fails, verify the desktop device actually has a reachable IPv6 address on that network and
that local firewall rules allow the chosen port.

### The desktop app will not let me import or quick-capture

That is expected while remote access is running. Stop remote access first, then retry the local action.
