# Assist private search and public-page facade

This is a runnable Python standard-library facade for the **existing** Ubuntu
SearXNG gateway. It does not deploy a service, replace SearXNG, configure TLS,
open a firewall, change Tailscale, or make Gemma call web tools.

## Boundaries

- The listener is fixed to `127.0.0.1:8722`. Do not bind it publicly.
- An operator must supply a private HTTPS reverse proxy with a valid certificate
  before an iPhone can pair. Native Assist rejects HTTP, credential-bearing URLs,
  paths in the configured origin, TLS bypasses and redirects.
- Every endpoint requires a bearer token. Supply a separate random token for
  each device through `ASSIST_GATEWAY_TOKENS_FILE` (preferred): an absolute
  credential-file path, or the legacy `ASSIST_GATEWAY_TOKENS_JSON` environment
  value. Both formats contain a JSON array of 1–16 unique
  URL-safe ASCII tokens, each 32–256 characters. There is no default credential.
  Do not use the synthetic test tokens, commit a token, paste it into a URL or
  enter it in a shell command that will retain it in history. Use an existing
  secret manager or the private credential-file provisioner below instead.
  A configured file takes precedence; an invalid file fails closed and never
  falls back to an older environment token. Files must be regular, owned by the
  process user, exactly mode `0600`, and at most 8 KiB. Descriptor-based path
  walking rejects symlinks in the file or any ancestor directory.
- Disconnect in Assist cancels local work and deletes that device's Keychain
  configuration. **It does not revoke the server credential.** To revoke it on
  Ubuntu, remove only that device's token from the operator-managed credential
  file (or legacy environment) and restart the facade deliberately. Other
  devices' tokens can remain valid.
- The native setup form sends the proposed token only to the chosen HTTPS
  origin's authenticated capabilities endpoint, and saves it atomically in a
  device-only, unlocked-only, nonsynchronizing Keychain item after validation.
  The token never crosses React Native or Gemma.

The provisioner creates one fresh device token without printing it:

```sh
python3 services/private-gateway/provision.py --file /absolute/private/new-directory/tokens.json
```

The destination must not exist. Its immediate parent may be newly created
`0700`, or must already be user-owned and exactly `0700`. Existing unrelated
directories are never chmodded. The credential is created exclusively at mode
`0600`, flushed before success, and never overwritten on another invocation.
Transfer the device token to the native setup form using an operator-controlled
secure channel; do not paste it into a chat, URL or request log.

After provisioning, point `ASSIST_GATEWAY_TOKENS_FILE` to that nonsecret absolute
path in the service environment. An operator can then start the facade with:

```sh
python3 services/private-gateway/server.py
```

`assist-private-gateway.service` is an optional user-systemd unit with a private
credential-file path, protected umask, resource ceilings and bounded restart
rate. It is not installed by tests or app startup. In this workspace's operator
setup it has been explicitly installed and started on loopback; the existing
SearXNG service was not restarted or replaced. See the dated
[implementation status](../../docs/native-workspace-implementation.md) for the
exact deployed boundary and verified private Tailscale HTTPS route. Running the
loopback listener alone is insufficient for iPhone connectivity.

## Versioned API

`GET /v1/capabilities` returns exactly:

```json
{"schemaVersion":1,"service":"assist-private-gateway","protocolVersion":1,"capabilities":["search"]}
```

`POST /v1/search` accepts only `application/json` with these exact fields:

```json
{"schemaVersion":1,"requestId":"device-request-1","query":"WeatherKit documentation Apple"}
```

`requestId` is 1–128 ASCII characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]*`. `query` is nonempty, at most 512 UTF-8 bytes, with
no control characters or reserved model protocol markers. Unknown fields,
duplicate decoded JSON keys, duplicated auth/body headers, chunked or compressed
request bodies, and bodies over 4096 bytes are rejected before the upstream call.
No caller can provide a URL, HTTP headers, provider name, method or proxy target.

The sole upstream is `POST http://127.0.0.1:8721/search`, using the standard
SearXNG `q`/`format=json` form. Native bearer tokens, cookies and browser
credentials are not forwarded. The facade does not follow redirects, requires
uncompressed JSON, caps upstream bodies at 1 MiB and uses a 12-second socket
timeout. There is no automatic retry.

Responses are bounded to 24 KiB and at most 10 typed search hits:

```json
{"schemaVersion":1,"requestId":"device-request-1","results":[{"id":"opaque-source-id","title":"Title","url":"https://developer.apple.com/","snippet":"Search excerpt"}],"degraded":false}
```

Titles and snippets are capped at 256 and 1024 UTF-8 bytes. URLs are capped at
2048 UTF-8 bytes, require HTTPS/ASCII DNS names, and exclude credentials,
fragments, non-443 ports, IP literals and local/reserved-name suffixes. Results
are deduplicated. Provider failures, dropped/invalid hits, result or byte limits
and empty results are exposed as degradation. A successful response is not proof
of freshness, exhaustiveness, relevance, safe-search support or page consultation.

The v1 search route does **not** fetch pages. Its URL syntax policy does not
resolve DNS and is not itself a DNS-rebinding defense. The separate v2 reader
below applies its own destination policy. The iPhone opens a selected hit through
native Safari only using a short-lived
request/result handle previously stored by the native service, never an arbitrary
URL passed back through JavaScript or generated by Gemma.

### v2 public-page reader (source candidate; not automatically deployed)

The v1 endpoints remain exact and backward-compatible. A newer client may
explicitly discover `GET /v2/capabilities`, which returns exactly:

```json
{"schemaVersion":1,"service":"assist-private-gateway","protocolVersion":2,"capabilities":["search","read"]}
```

`POST /v2/read` accepts only these exact fields, not a URL, headers, cookies,
provider or method:

```json
{"schemaVersion":1,"requestId":"device-request-1","resultId":"32-lowercase-hex-hit-id-from-search"}
```

The ID must be an actual 32-character lowercase hexadecimal ID issued by a
successful `/v1/search` to the **same authenticated device token and request**.
The cache expires after 600 seconds and holds at most 32 requests globally and
four per token. A handle is consumed before network submission, including on
failure: neither the service nor a retry can silently repeat it. Each request
permits at most four distinct read attempts; the service permits 12 read attempts
per rolling minute, within the same two-handler limit as search. Restarting the
service forgets all handles. Missing, expired, other-device and consumed handles
return the same `404 read_unavailable`; reader failures return a fixed generic
`502 read_unavailable`. Budget exhaustion returns `429 busy`.

A successful response contains exactly:

```json
{"schemaVersion":1,"requestId":"device-request-1","resultId":"issued-hit-id","title":"Issued search title","url":"https://public-site.org/final-page","text":"Extracted public text","truncated":false,"readAt":"2026-10-19T12:00:00Z","untrusted":true}
```

`title` retains the issued search title, not an independently verified page title.
`url` is the final validated destination after at most three page redirects.
Text is at most 8192 UTF-8 bytes, title 256, URL 2048 and total response 24 KiB.
`truncated` describes the extracted text budget, not completeness of the article
or website. The server clock supplies `readAt`; it is a fetch observation, not
proof that the publication is current.

Reader destination and resource boundaries:

- HTTPS with ASCII DNS names and port 443 only; no IP literals, credentials,
  fragments, private/reserved host suffixes or tailnet destinations.
- Each connection resolves DNS afresh in an isolated, credential-free child
  process with a three-second deadline. Empty, excessive or mixed public/private
  answers fail closed. The connection goes directly to one validated numeric IP;
  there is no hostname re-resolution or fallback attempt in the actual socket.
- IPv4/IPv6 private, loopback, link-local, shared address space, multicast,
  unspecified and special/reserved destinations are refused. IPv4-mapped IPv6,
  translation/transition ranges and known platform metadata/service addresses
  are also excluded. Every redirect repeats destination and robots checks.
- TLS uses Python's standard trust store, required certificate validation and
  original-hostname checking/SNI. There is no insecure override. No environment
  proxy, browser credential, bearer token, Cookie or Referer is forwarded; only
  fixed Host/User-Agent/Accept/Accept-Encoding/Connection headers are sent.
- The entire read, including DNS, TLS, headers, robots and page redirects, has a
  15-second deadline. A socket shutdown timer bounds slow-drip headers/bodies;
  time is also checked between chunks. Page bodies are capped at 512 KiB and
  robots at 64 KiB. Compressed bodies, ambiguous lengths/encoding, incomplete
  declared bodies and unsupported types fail closed; there is no automatic retry.
- Only `text/html` and `text/plain` are extracted. No PDF, JavaScript execution,
  browser automation, login, paywall or anti-bot bypass is implemented. HTML
  parsing omits scripts/styles/navigation and several nonarticle containers; it
  is a bounded text extraction, not a full article/visibility classifier.
- A bounded robots check precedes access to each origin. Matching rules for
  `AssistResearchReader` take precedence over `*`; longest rule wins, with Allow
  on a tie. Only robots `404`/`410` permit access without rules. Robots redirects,
  authentication restrictions, errors, excess size and uncertain parsing fail
  closed. This conservative subset can decline legitimate sites and does not
  claim full RFC conformance. See [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html)
  and Python's [TLS guidance](https://docs.python.org/3/library/ssl.html).

All extracted text is **untrusted external data**, not an instruction or a tool
authorization. Protocol-marker rejection is not a prompt-injection defense;
registry, permissions and user confirmations must remain outside the model.
The reader fetches a source only; it does not run Gemma or upload private device
context. The separate [native research source candidate](../../docs/public-research-implementation.md)
owns the bounded Gemma synthesis loop. Neither component claims parity with
Deep Research, and this v2 reader is not the currently deployed v1 snapshot.

Two connections/handler threads may be active at once, with a global ceiling of
30 accepted searches in a rolling minute. Saturation returns `429` with a fixed
`busy` code. This is a bounded private application facade, not a hardened public
Internet HTTP server. Access/request logs and raw exceptions are disabled;
responses expose only fixed error codes, not queries, tokens or upstream bodies.

## Isolated verification

```sh
python3 -m unittest discover -s services/private-gateway -p 'test_*.py' -v
```

The suite starts only disposable loopback servers and uses synthetic tokens. It
checks authenticated metadata/search, missing/wrong/non-ASCII credentials,
duplicate headers, input/output bounds, closed routes, URL syntax, rate and
concurrency limits, and the actual HTTP upstream adapter against a fake server
(fixed host/port, form body, no auth/cookie forwarding, redirect/MIME/encoding/
oversize/duplicate-JSON rejection), exclusive credential provisioning, private
file permissions, ownership, symlink refusal, no-overwrite and no-token-output
behavior. Reader tests add deterministic public/private DNS, numeric-IP pinning,
TLS/SNI settings, redirects/rebinding, robots denial, absolute slow-header/body
deadlines, extraction and handle/token/TTL/rate/concurrent-consumption bounds.
They exercise the real standard-library HTTP parser with fixed wire fixtures.
They do not contact public pages. It does not test real HTTPS ingress, the
iPhone Keychain, Safari navigation, Gemma, or external search-engine reliability.

## Explicit HTTPS qualification

After the operator has configured the private HTTPS origin, `verify.py` checks
normal TLS/hostname validation, missing and incorrect credential rejection, and
the authenticated exact capabilities schema. An explicit public technical query
may additionally verify the typed search route:

```sh
python3 services/private-gateway/verify.py \
  --origin https://your-host.your-tailnet.ts.net:9446 \
  --tokens-file /absolute/private/directory/tokens.json \
  --query 'WeatherKit Apple documentation'
```

Omit `--query` to avoid contacting search providers. This verifier refuses
redirects and environment proxies; output is only redacted proof/count metadata.
It does not print credentials, queries, result titles/URLs, or HTTP bodies.
