# Selected documents and extension inbox

`AssistSharedInbox.swift` is compiled into Assist, AssistShare and AssistWidget.
The only common capability is `group.org.27pm.assist`. These source declarations
do not register that group or enable a signing profile in an Apple account.

The Share extension accepts one explicitly shared plain-text, web URL, image or
PDF provider. Save is a user gesture; opening the share sheet alone copies
nothing. It never opens Assist automatically, runs a model, opens a shared URL or
submits an iOS action. The app's file picker similarly copies one selected file,
not a folder or a provider's entire library. The app can export bounded text to a
user-chosen Files destination through the system export picker.

The private group inbox has a versioned metadata record and fixed UUID payload
basename per item. There are no original filenames, accounts, tokens or chat
history in metadata. All participating Apple processes coordinate mutations on
the same directory with NSFileCoordinator. Payload and metadata are atomically
written, protected completely while locked, private to the app group and excluded
from backups. A crash between payload and metadata leaves an unpublished orphan
that the next coordinated maintenance removes.

Bounds: 20 items, 24 MiB aggregate, 8 MiB per binary item, 64 KiB per text item.
Pending items expire in seven days, consumed items in one day. Consumption is
idempotent for the same item and does not execute anything. Removal is explicit
and idempotent. Quotas reject new imports instead of evicting unexpired documents.
Metadata corruption or symlinks fail closed. Store failures after submission are
not proof that no copy occurred; the Share UI tells the user to inspect Assist
before trying again.

Read only happens after an explicit item selection. Plain text is decoded as
UTF-8. PDFKit extracts text from at most five pages of a PDF with at most 50 pages;
this is not OCR for scanned PDFs. Image OCR uses Vision after validating dimensions
(4096 per side and at most 16 million pixels), then downsamples to 2048, takes at
most 40 lines and returns at most 8192 UTF-8 bytes. All returned text is marked
untrusted; there is no general image understanding. Cancellation suppresses stale
callbacks; an import already committed remains a recoverable inbox item, and
non-preemptible framework work may drain before stopping.

The widget is a launcher, not an agent or a timer. It reads only a bounded count
of pending items and shows no filenames, document text, URL, fake progress or
AlarmKit countdown. Its timeline snapshot has a stable date and a 30-minute
refresh request; the system may delay refresh. The app/share extension requests a
reload after changes. File protection may make the count unavailable while
locked; it is then omitted rather than shown as a fabricated zero. The single
widget URL is `assist://inbox`; it must only navigate the main app, never authorize
or execute an action.

## Checks

Run `bash scripts/check-shared-inbox.sh` from a Swift 6 environment. The deterministic
Foundation checks cover idempotence, metadata minimisation, path refusal, quotas,
expiry, consumption and bounded file reads. On Apple the production coordinator
is used; the conditional Linux path proves sequential storage contracts only,
not cross-process iOS behavior.

Before claiming release readiness, also type-check the real three targets using
the intended iOS SDK, inspect app-group entitlements in all signed binaries and
profiles, then exercise actual Files/Safari/Photos shares, double Save, Cancel,
background during provider loading, app relaunch, locked-device widget content,
quota/expiry and failed providers on an iPhone. Foundation checks do not prove
system UI, provider compatibility, code signing or physical-device behavior.
