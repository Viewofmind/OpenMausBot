# Desktop-to-desktop companion mode

Every OpenMausBot desktop build can play either role:

- **Host mode** is the normal app. It owns the agents, conversations, credentials, routines, and computers.
- **Client mode** controls a paired host through the same authenticated, default-deny companion API used by the phone app.

The roles are platform-independent. A Windows, macOS, or Ubuntu build can host, and any other desktop build can be its client. One app installation uses one role at a time; disconnecting a client returns that installation to host mode without deleting its local host data.

## Pair over Tailscale

1. Install Tailscale on both computers, sign into the same tailnet, and leave MagicDNS enabled.
2. On the host, open **Settings → Phone**, turn on phone access, and open **Pair over Tailscale** to display a six-digit code.
3. On the client, open **Settings → Remote computer**.
4. Enter the host's full `.ts.net` MagicDNS name and the six-digit code.
5. Choose **Pair and switch to client mode**. The client restarts and opens the host's bot UI.

To switch that installation back, open **Settings → Remote computer** and choose **Disconnect and use this computer**.

The host must be running and awake. The client accepts only an HTTP `.ts.net` hostname because that cleartext-looking connection is encrypted inside Tailscale's WireGuard tunnel; raw IP addresses, LAN hostnames, paths, credentials in URLs, and HTTPS addresses are rejected by this transport.

## Security model

Pairing creates an independent device identity on the host. The resulting bearer token is:

- stored only in Electron's OS-encrypted credential document on the client;
- never returned through the preload bridge, inserted into the page, placed in a URL, or written to browser storage;
- injected by a loopback-only Electron relay after browser `Origin` headers are removed;
- sent only to the exact saved `.ts.net` origin; absolute-form request targets cannot redirect it elsewhere.

The host companion remains the authorization boundary. Its route list defaults to deny, strips sensitive response fields, and can revoke the desktop client from **Settings → Phone** like any other paired device. Client mode does not expose host-only settings, local browser surfaces, local VM controls, plugins, or the event inspector.

The first desktop slice intentionally matches the companion feature surface: chats, rooms, streamed responses, approvals, search, routines, attachments, and any cloud-desktop join the host explicitly grants to that paired device. Expanding the desktop client must be done by explicitly reviewing and adding companion routes; it must not bypass the companion API or proxy the full harness.

## Runtime shape

```text
desktop renderer
      │ same-origin HTTP/SSE, no bearer
      ▼
Electron relay 127.0.0.1:8798 (fallbacks: 18798, 28798)
      │ bearer injection over Tailscale/WireGuard
      ▼
host companion :8810
      │ authentication + route allowlist + response scrubbing
      ▼
host harness 127.0.0.1:8799
```

While client mode is active, Electron does not start its local harness, companion sidecar, computer-use daemon, or built-in browser host. The renderer still uses ordinary same-origin API calls and `EventSource`, so the existing UI and streaming store do not learn or handle a second transport.
