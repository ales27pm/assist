import Foundation

/// Version negotiation describes compiled support, never an OS permission or
/// an authorization to act. A selection can only narrow the native registry;
/// neither an OTA recipe nor model output can supply an executor or a schema.
enum AssistToolHost {
    static let catalogRevision = "device-v3-31"

    struct Selection: Sendable {
        let request: AssistGenerationRequest
        let allowedTools: Set<AssistToolName>
    }

    private struct Capability: Encodable {
        let id: String
        let version = 1
        let effect: String
        let execution: String
        let availability = "available"
    }

    private struct Capabilities: Encodable {
        let schemaVersion = 1
        let hostProtocolVersions = [2]
        let policyVersion = 1
        let catalogRevision = AssistToolHost.catalogRevision
        let confirmation = "all_accesses"
        let tools = AssistToolName.allCases.map {
            Capability(id: $0.rawValue, effect: $0.effect.rawValue, execution: $0.execution)
        }
    }

    /// Pure metadata only. "available" means an executor is compiled into this
    /// binary, not that its framework, permission or user consent is available.
    static func capabilitiesJSON() throws -> String {
        try AssistJSON.encode(Capabilities())
    }

    static func selection(from json: String) throws -> Selection {
        // The shared reader bounds bytes, strings, nesting and node count. It
        // rejects duplicate decoded keys (including escaped spellings), unlike
        // decoding an object with JSONSerialization or JSONDecoder directly.
        guard let object = try AssistToolValue.decodeJSON(json).objectDictionary else {
            throw AssistToolContractError.invalidArguments
        }
        let required: Set<String> = ["schemaVersion", "hostProtocolVersion", "catalogRevision", "requiredTools",
                                     "profile", "requestId", "messages", "temperature"]
        let actual = Set(object.keys)
        guard required.isSubset(of: actual), actual.isSubset(of: required.union(["maxTokens"])),
              object["schemaVersion"]?.integerValue == 1,
              object["hostProtocolVersion"]?.integerValue == 2,
              object["catalogRevision"]?.stringValue == catalogRevision,
              object["profile"]?.stringValue == "device_v1",
              case .array(let contracts) = object["requiredTools"],
              !contracts.isEmpty, contracts.count <= AssistToolName.allCases.count else {
            throw AssistToolContractError.invalidArguments
        }
        var allowedTools: Set<AssistToolName> = []
        for contract in contracts {
            guard let tool = contract.objectDictionary, Set(tool.keys) == ["id", "version"],
                  let id = tool["id"]?.stringValue, let name = AssistToolName(rawValue: id),
                  tool["version"]?.integerValue == 1,
                  allowedTools.insert(name).inserted else {
                throw AssistToolContractError.invalidArguments
            }
        }
        guard let requestId = object["requestId"]?.stringValue,
              !requestId.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              case .array(let messages) = object["messages"], messages.count == 1,
              let message = messages.first?.objectDictionary, Set(message.keys) == ["role", "content"],
              message["role"]?.stringValue == "user", let content = message["content"]?.stringValue,
              case .number(let temperature) = object["temperature"], temperature == 0 else {
            throw AssistToolContractError.invalidArguments
        }
        let maxTokens: Int?
        if let budget = object["maxTokens"] {
            guard let value = budget.integerValue, (1...1_024).contains(value) else {
                throw AssistToolContractError.invalidArguments
            }
            maxTokens = value
        } else { maxTokens = nil }
        let request = AssistGenerationRequest(requestId: requestId,
            messages: [.init(role: "user", content: content)], temperature: temperature, maxTokens: maxTokens)
        try request.validate()
        _ = try AssistDeviceToolAdapter.validatePublicText(content)
        return Selection(request: request, allowedTools: allowedTools)
    }
}
