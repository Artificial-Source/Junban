# Use remote access from the desktop app

Use this when you want to open your packaged desktop Junban session from another device on the same trusted network or over Tailscale.

## Before you start

- Use a **packaged desktop build**.
- Keep access on a **trusted/private network** such as your LAN or Tailscale.
- Do **not** expose the built-in remote-access port directly to the public internet.

## Start remote access

1. Open `Settings -> Data -> Remote Access` in the desktop app.
2. Choose a port.
3. Optional: enable **Protect remote access with a password** and set the password.
4. Optional: enable auto-start if you want the endpoint available whenever the app opens.
5. Click **Start remote access**.

If the desktop app shows a local URL, open that URL from another device on the same network. For Tailscale, open your desktop machine's Tailscale IP with the same port.

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

### The desktop app will not let me import or quick-capture

That is expected while remote access is running. Stop remote access first, then retry the local action.
