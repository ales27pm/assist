#if TTS
import Foundation

/// Assist-specific local path validation. It intentionally has no downloader,
/// repository resolver or cache recovery path. The app separately verifies its
/// pinned manifest before supplying this directory; Core ML validates programs.
enum PocketTtsOfflineAssets {
    static func validate(
        directory: URL, precision: PocketTtsPrecision, placement: PocketTtsModelPlacement
    ) throws -> URL {
        try requireDirectory(directory, name: "PocketTTS local root")
        for name in ModelNames.PocketTTS.requiredModels(precision: precision, placement: placement).sorted() {
            try requireDirectory(directory.appendingPathComponent(name), name: name)
        }
        for name in ["bos_emb.bin", "bos_before_voice.bin", "text_embed_table.bin", "tokenizer.model"] {
            let file = directory.appendingPathComponent("constants_bin").appendingPathComponent(name)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory),
                  !isDirectory.boolValue else { throw PocketTTSError.modelNotFound(name) }
        }
        return directory
    }

    static func encoder(in directory: URL) throws -> URL {
        try requireDirectory(directory, name: "PocketTTS local root")
        let encoder = directory.appendingPathComponent(ModelNames.PocketTTS.mimiEncoderV3File)
        try requireDirectory(encoder, name: ModelNames.PocketTTS.mimiEncoderV3File)
        return encoder
    }

    private static func requireDirectory(_ url: URL, name: String) throws {
        var isDirectory: ObjCBool = false
        guard url.isFileURL,
              FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { throw PocketTTSError.modelNotFound(name) }
    }
}
#endif
