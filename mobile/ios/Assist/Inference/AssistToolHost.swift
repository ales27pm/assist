import Foundation

/// Bounded conversation quotations, never a reusable permission or tool receipt.
struct AssistDeviceReferenceContext: Sendable, Equatable {
    struct Turn: Sendable, Equatable {
        let user: String
        let assistant: String
    }
    let turns: [Turn]
    let omittedTurns: Int
    static let empty = Self(turns: [], omittedTurns: 0)

    func validated() throws -> Self {
        guard turns.count <= 3, (0...1_000_000).contains(omittedTurns),
              turns.reduce(0, { $0 + $1.user.utf8.count + $1.assistant.utf8.count }) <= 8_192 else {
            throw AssistToolContractError.invalidArguments
        }
        for turn in turns {
            for text in [turn.user, turn.assistant] {
                guard text.utf8.count <= 2_048 else { throw AssistToolContractError.invalidArguments }
                _ = try AssistDeviceToolAdapter.validatePublicText(text)
                let forbidden = [
                    #"\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b"#,
                    #"\b(?:requestId|operationId|confirmationToken|inbox_id|document_id|calendarId|tool_calls|tool_responses)\b"#,
                    #"(?:file|content)://|(?:^|[\s\"'(])/(?:[^\s/]+/)*[^\s]+|[a-z]:\\"#,
                    #"(?m)^\s*[\{\[]"#,
                ]
                guard forbidden.allSatisfy({ text.range(of: $0, options: [.regularExpression, .caseInsensitive]) == nil }) else {
                    throw AssistToolContractError.invalidArguments
                }
            }
        }
        return self
    }

    static func decode(_ value: AssistToolValue) throws -> Self {
        guard let object = value.objectDictionary,
              Set(object.keys) == ["schemaVersion", "turns", "omittedTurns"],
              object["schemaVersion"]?.integerValue == 1,
              let omitted = object["omittedTurns"]?.integerValue,
              case .array(let entries) = object["turns"] else { throw AssistToolContractError.invalidArguments }
        let turns = try entries.map { entry -> Turn in
            guard let row = entry.objectDictionary, Set(row.keys) == ["user", "assistant"],
                  let user = row["user"]?.stringValue, let assistant = row["assistant"]?.stringValue else {
                throw AssistToolContractError.invalidArguments
            }
            return Turn(user: user, assistant: assistant)
        }
        return try Self(turns: turns, omittedTurns: omitted).validated()
    }
}

/// Version negotiation describes compiled support, never an OS permission or
/// an authorization to act. A selection can only narrow the native registry;
/// neither an OTA recipe nor model output can supply an executor or a schema.
enum AssistToolHost {
    static let catalogRevision = "device-v3-31"

    struct Selection: Sendable {
        let request: AssistGenerationRequest
        let allowedTools: Set<AssistToolName>
        let referenceContext: AssistDeviceReferenceContext
        let hostProtocolVersion: Int
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
        let hostProtocolVersions = [2, 3]
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
        guard required.isSubset(of: actual),
              object["schemaVersion"]?.integerValue == 1,
              object["catalogRevision"]?.stringValue == catalogRevision,
              let hostProtocolVersion = object["hostProtocolVersion"]?.integerValue,
              case .array(let contracts) = object["requiredTools"],
              !contracts.isEmpty, contracts.count <= AssistToolName.allCases.count else {
            throw AssistToolContractError.invalidArguments
        }
        let referenceContext: AssistDeviceReferenceContext
        switch hostProtocolVersion {
        case 2:
            guard actual.isSubset(of: required.union(["maxTokens"])),
                  object["profile"]?.stringValue == "device_v1" else { throw AssistToolContractError.invalidArguments }
            referenceContext = .empty
        case 3:
            guard actual == required.union(["referenceContext"]).union(object["maxTokens"] == nil ? [] : ["maxTokens"]),
                  object["profile"]?.stringValue == "device_context_v1",
                  let context = object["referenceContext"] else { throw AssistToolContractError.invalidArguments }
            referenceContext = try AssistDeviceReferenceContext.decode(context)
        default:
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
        return Selection(request: request, allowedTools: allowedTools, referenceContext: referenceContext,
                         hostProtocolVersion: hostProtocolVersion)
    }

    /// Additive v3 result metadata; old generation/result contracts are untouched.
    static func resultJSON<Value: Encodable>(_ value: Value, referenceContextEligible: Bool) throws -> String {
        try AssistJSON.encode(ContextResult(value: value, eligible: referenceContextEligible))
    }

    private struct ContextResult<Value: Encodable>: Encodable {
        let value: Value
        let eligible: Bool
        private enum CodingKeys: String, CodingKey { case referenceContextEligible }
        func encode(to encoder: any Encoder) throws {
            try value.encode(to: encoder)
            var fields = encoder.container(keyedBy: CodingKeys.self)
            try fields.encode(eligible, forKey: .referenceContextEligible)
        }
    }
}
