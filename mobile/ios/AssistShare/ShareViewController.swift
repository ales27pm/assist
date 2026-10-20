import UIKit
import UniformTypeIdentifiers
import WidgetKit

/// Sharing only deposits a bounded item. It never opens the containing app,
/// fetches a shared URL, runs Gemma or interprets shared text as an instruction.
@MainActor
final class ShareViewController: UIViewController {
    private let importIdentifier = UUID()
    private let gate = AssistInboxAdmission()
    private var provider: NSItemProvider?
    private var progress: Progress?
    private var saving = false
    private var finished = false
    private let message = UILabel()
    private let saveButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        isModalInPresentation = true
        let title = UILabel(); title.text = "Partager avec Assist"
        title.font = .preferredFont(forTextStyle: .title2); title.adjustsFontForContentSizeCategory = true
        title.accessibilityTraits = .header; title.numberOfLines = 0
        message.font = .preferredFont(forTextStyle: .body); message.numberOfLines = 0
        message.adjustsFontForContentSizeCategory = true
        message.text = "Enregistre ce document dans Assist. Aucune recherche, lecture ou action ne sera lancée automatiquement."
        saveButton.setTitle("Enregistrer dans Assist", for: .normal)
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
        cancelButton.setTitle("Annuler", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        for button in [saveButton, cancelButton] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
            button.titleLabel?.adjustsFontForContentSizeCategory = true
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        }
        let stack = UIStackView(arrangedSubviews: [title, message, saveButton, cancelButton])
        stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        if items.count == 1, let attachments = items.first?.attachments, attachments.count == 1 {
            provider = attachments[0]
        }
        if provider == nil || (try? AssistSharedInbox.appGroup()) == nil {
            saveButton.isEnabled = false
            message.text = "Partage un seul texte, lien web, PDF ou fichier image. La boîte partagée doit être disponible."
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if !finished { gate.cancel(); progress?.cancel() }
    }

    @objc private func save() {
        guard !saving, !finished, let provider else { return }
        saving = true; saveButton.isEnabled = false; message.text = "Enregistrement local…"
        let identifier = importIdentifier; let gate = gate
        let fileType: UTType? = provider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) ? .pdf
            : provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? .image : nil
        if let fileType {
            let kind: AssistSharedInbox.Kind = fileType == .pdf ? .pdf : .image
            progress = provider.loadFileRepresentation(forTypeIdentifier: fileType.identifier) { [weak self] url, _ in
                // The provider's URL expires when this callback returns. Copy
                // bounded bytes now, not in a later MainActor task.
                let outcome: Result<AssistSharedInbox.Item, Error> = Result {
                    try gate.check()
                    guard let url else { throw AssistInboxError.invalidItem }
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let bytes = try AssistSharedInbox.readSelectedFile(url)
                    try gate.check()
                    return try AssistSharedInbox.appGroup().save(id: identifier, kind: kind, data: bytes, source: .share, admission: gate)
                }
                Task { @MainActor in self?.complete(outcome) }
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            progress = provider.loadObject(ofClass: NSURL.self) { [weak self] value, _ in
                let outcome: Result<AssistSharedInbox.Item, Error> = Result {
                    try gate.check()
                    guard let url = value as? URL else { throw AssistInboxError.invalidItem }
                    let text = try AssistSharedInbox.safeWebURL(url.absoluteString)
                    try gate.check()
                    return try AssistSharedInbox.appGroup().save(id: identifier, kind: .url, data: Data(text.utf8), source: .share, admission: gate)
                }
                Task { @MainActor in self?.complete(outcome) }
            }
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            progress = provider.loadObject(ofClass: NSString.self) { [weak self] value, _ in
                let outcome: Result<AssistSharedInbox.Item, Error> = Result {
                    try gate.check()
                    let data: Data
                    if let text = value as? String {
                        guard text.utf8.count <= AssistSharedInbox.maximumTextBytes else { throw AssistInboxError.oversized }
                        data = Data(text.utf8)
                    }
                    else { throw AssistInboxError.invalidItem }
                    guard data.count <= AssistSharedInbox.maximumTextBytes else { throw AssistInboxError.oversized }
                    try gate.check()
                    return try AssistSharedInbox.appGroup().save(id: identifier, kind: .text, data: data, source: .share, admission: gate)
                }
                Task { @MainActor in self?.complete(outcome) }
            }
        } else { complete(.failure(AssistInboxError.unsupported)) }
    }

    private func complete(_ result: Result<AssistSharedInbox.Item, Error>) {
        guard !finished else { return }
        progress = nil
        switch result {
        case .success:
            finished = true; gate.cancel()
            WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        case .failure:
            saving = false
            // Retry stays tied to the same stable import ID. A successful copy
            // with a lost reply cannot create a second item on another tap.
            message.text = "Le document n’a pas pu être confirmé. Ouvre Assist pour vérifier sa boîte de réception avant de recommencer."
            cancelButton.setTitle("Fermer", for: .normal)
        }
    }

    @objc private func cancel() {
        guard !finished else { return }
        finished = true; gate.cancel(); progress?.cancel(); progress = nil
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
}
