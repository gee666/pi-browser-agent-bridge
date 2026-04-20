# pi-browser-agent-bridge

`pi-browser-agent-bridge` is the service-worker-side bridge embedded inside `browser-agent-ext`.

It is not a standalone server. The bridge connects out from the extension service worker to the local `pi-browser-agent` broker over WebSocket.

## Responsibilities

- open and maintain the outbound WebSocket connection
- advertise extension capabilities to the broker
- dispatch incoming `browser_*` requests to the extension runtime
- share one refcounted CDP inspector across browser tools and input control
- keep console/network observability buffers alive across service-worker restarts
- surface failures as structured protocol errors instead of crashing the parent runtime

## Embedded usage

`browser-agent-ext/background/sw.js` creates the bridge with:

- a hello payload containing the extension id, version, and capabilities
- a request handler that routes tool calls into the real runtime
- alarms-based reconnect / keepalive behavior

The bridge is configured from `chrome.storage.local.piBridgeConfig`.

Default config:

- enabled: `true`
- url: `ws://127.0.0.1:7878`

## Development

Run the bridge unit tests from this folder:

```bash
node --test ./tests/*.test.js
```

The bridge code is intentionally defensive:

- unknown requests return structured `E_UNKNOWN_TYPE`
- handler failures are normalized to protocol-safe errors
- disconnects and attach failures are surfaced without taking down the service worker
