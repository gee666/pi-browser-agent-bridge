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

## External scripts

`createJsNavigationDestructiveHandlers` requires an injected `executeExternalScript` service for `browser_evaluate_js` and `browser_run_js`. Every supplied script goes through this service, including read-only expressions. Missing services and rejected scripts produce structured errors. The bridge never falls back to `Runtime.evaluate`.

The callback accepts:

```js
{
  tabId,
  kind: 'expression', // or 'program' for run_js
  source,
  args: [],
  awaitPromise: true,
  returnByValue: true,
  captureConsole: false,
  timeoutMs: 120000,
  signal,
}
```

It returns `{type, value, subtype?, preview?, console_entries?}`. Console entries use `{level, entries}`; the bridge also accepts the core service's `{level, args}` format and converts it. The bridge adds tab metadata and elapsed time.

The extension injects `browser-agent-core`'s `NativeScriptService` with its configured AI provider and a dedicated Python `InputControlBridge`. The service translates source into a bounded, deterministically validated plan. It supports a subset of script semantics, not arbitrary JavaScript execution. Unsupported operations or options must reject explicitly. `world: 'main'` remains accepted for tool compatibility but does not grant direct page-world execution. Trusted built-in inspection scripts do not pass through translation.

Both external script tools default to a 120-second deadline for AI translation and native execution. Navigation deadlines are unchanged. A request deadline aborts the service's signal so pending native input can stop. The current RPC protocol has no cancellation frame; cancelling a tool call at the client does not itself stop extension work before its deadline. The extension must prevent concurrent script and task desktop input, including during provider setup and translation.

## Development

Run the bridge unit tests from this folder:

```bash
node --test ./tests/*.test.js
```

The bridge code is intentionally defensive:

- unknown requests return structured `E_UNKNOWN_TYPE`
- handler failures are normalized to protocol-safe errors
- disconnects and attach failures are surfaced without taking down the service worker
