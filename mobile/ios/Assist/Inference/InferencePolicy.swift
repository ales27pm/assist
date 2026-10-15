import Foundation

enum AssistInferenceError: Error, LocalizedError {
    case invalid(String)
    case busy
    case notLoaded

    var errorDescription: String? {
        switch self {
        case .invalid(let detail): return detail
        case .busy: return "Une opération native est déjà en cours. Annule-la et attends sa fin."
        case .notLoaded: return "Charge d’abord le modèle local."
        }
    }
}

struct AssistMessage: Codable, Sendable {
    let role: String
    let content: String
}

struct AssistGenerationRequest: Decodable, Sendable {
    let requestId: String
    let messages: [AssistMessage]
    let temperature: Double
    let maxTokens: Int?

    func validate() throws {
        guard !requestId.isEmpty, requestId.utf8.count <= 128 else {
            throw AssistInferenceError.invalid("Identifiant de requête invalide.")
        }
        guard temperature.isFinite, (0...2).contains(temperature) else {
            throw AssistInferenceError.invalid("La température doit être comprise entre 0 et 2.")
        }
        guard maxTokens == nil || maxTokens! > 0 else {
            throw AssistInferenceError.invalid("Le budget de sortie doit être positif ou absent (nil : contexte restant).")
        }
        guard !messages.isEmpty, messages.last?.role == "user",
            messages.allSatisfy({ ["user", "assistant"].contains($0.role) && !$0.content.isEmpty })
        else {
            throw AssistInferenceError.invalid("Conversation invalide : messages user/assistant, terminés par user.")
        }
    }
}

enum AssistInferencePolicy {
    static let sourceModel = "google/gemma-4-E2B-it"
    static let supportedContexts: Set<Int> = [8192, 32768]

    static func validateModel(tokenizer: String, context: Int, embeddedTokenizer: Bool) throws {
        guard tokenizer == sourceModel else {
            throw AssistInferenceError.invalid("Ce prototype accepte uniquement Gemma 4 E2B Instruct.")
        }
        guard supportedContexts.contains(context) else {
            throw AssistInferenceError.invalid("Un export réel 8 192 ou 32 768 jetons est requis.")
        }
        guard embeddedTokenizer else {
            throw AssistInferenceError.invalid("Tokenizer local absent : tout téléchargement implicite est interdit.")
        }
    }

    static func validateGraphs(_ names: [String], context: Int) throws {
        let decodeDimensions: [(Int, Int)] = names.compactMap { name in
            let pieces = name.split(separator: "_")
            guard pieces.count == 3, pieces[0] == "extend",
                let capacity = Int(pieces[1]), let query = Int(pieces[2]), capacity > 0, query > 0
            else { return nil }
            return (capacity, query)
        }
        guard names.contains("load_embeddings"),
            decodeDimensions.map({ $0.0 }).max() == context,
            // Apple's pinned Gemma export uses an 8-position extend graph even
            // for one-token decoding; it pads/masks the unused positions.
            decodeDimensions.contains(where: { $0.0 == context && $0.1 == 8 }),
            names.contains("prompt_opt_\(context)_64")
        else {
            throw AssistInferenceError.invalid("Les graphes Core AI ne correspondent pas au contexte déclaré.")
        }
    }

    static func outputBudget(promptTokens: Int, capacity: Int, requested: Int?) throws -> Int {
        guard promptTokens > 0, promptTokens < capacity else {
            throw AssistInferenceError.invalid("Le contexte est plein : conserve une place pour la réponse.")
        }
        if let requested, requested <= 0 {
            throw AssistInferenceError.invalid("Le budget de sortie doit être positif.")
        }
        return min(requested ?? capacity, capacity - promptTokens)
    }

    static func stopTokenIDs(metadata: Data, vocabSize: Int, tokenizerEOS: Int?) throws -> Set<Int32> {
        struct Envelope: Decodable {
            struct Language: Decodable {
                let eos_token_ids: [Int]
            }
            let language: Language
        }
        // Apple's Gemma exporter records the checkpoint's generation EOS union.
        // Do not treat every tokenizer "additional_special_token" as a stop token:
        // that can include non-terminal role or thinking markers.
        let declared = try JSONDecoder().decode(Envelope.self, from: metadata).language.eos_token_ids
        guard !declared.isEmpty else {
            throw AssistInferenceError.invalid("Le paquet ne déclare aucun jeton de fin de génération.")
        }
        let ids = Set(declared + (tokenizerEOS.map { [$0] } ?? []))
        guard ids.allSatisfy({ $0 >= 0 && $0 < vocabSize && $0 <= Int(Int32.max) }) else {
            throw AssistInferenceError.invalid("Jeton de fin hors du vocabulaire du modèle.")
        }
        return Set(ids.map(Int32.init))
    }

    /// Reject absolute, parent-traversing, or symlink-escaping paths from imported metadata.
    static func confinedURL(_ relativePath: String, root: URL) throws -> URL {
        guard !relativePath.isEmpty, !(relativePath as NSString).isAbsolutePath,
            !relativePath.split(separator: "/").contains("..")
        else {
            throw AssistInferenceError.invalid("Chemin d’artefact hors du dossier importé.")
        }
        let normalizedRoot = root.resolvingSymlinksInPath().standardizedFileURL
        let result = normalizedRoot.appendingPathComponent(relativePath).resolvingSymlinksInPath().standardizedFileURL
        guard result.path.hasPrefix(normalizedRoot.path + "/") else {
            throw AssistInferenceError.invalid("Un lien symbolique sort du dossier importé.")
        }
        return result
    }
}

/// Inspect every entry before listing a directory; metadata checks never read file contents.
enum AssistModelDirectoryPolicy {
    struct Entry {
        let isDirectory: Bool
        let isSymbolicLink: Bool
        let isReadable: Bool
        let isUbiquitous: Bool
        let isDownloaded: Bool
    }

    static func validate(
        _ root: URL,
        entry: (URL) throws -> Entry,
        children: (URL) throws -> [URL]
    ) throws {
        var pending = [root]
        while let url = pending.popLast() {
            let metadata = try entry(url)
            guard (url != root || metadata.isDirectory), !metadata.isSymbolicLink,
                metadata.isReadable, !metadata.isUbiquitous, metadata.isDownloaded
            else {
                throw NSError(
                    domain: "Assist.ModelDirectoryPicker", code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey: "Le modèle doit être entièrement téléchargé dans un dossier local, lisible et sans lien symbolique.",
                        "code": "E_MODEL_DIRECTORY"
                    ]
                )
            }
            if metadata.isDirectory { pending.append(contentsOf: try children(url)) }
        }
    }
}

enum AssistJSON {
    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }
}

/// Full-prefix snapshots preserve byte-fallback UTF-8 and tokenizer normalization.
/// Progress snapshots grow at least 1/64 beyond the last one, bounding cumulative
/// decoded tokens to 65 times output length; the final snapshot adds one more pass.
struct AssistOutputBuffer {
    private var ids: [Int] = []
    private var text = ""
    private var nextProgressSnapshot = 1
    var count: Int { ids.count }
    mutating func append(_ id: Int) { ids.append(id) }

    mutating func progressSnapshot(decode: ([Int]) -> String) -> String {
        guard count >= nextProgressSnapshot else { return text }
        return snapshot(decode: decode)
    }

    mutating func snapshot(decode: ([Int]) -> String) -> String {
        text = decode(ids)
        nextProgressSnapshot = count + max(1, (count + 63) / 64)
        return text
    }
}
