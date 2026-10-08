public enum ConnectorState: String, Codable, Sendable {
  case connected
  case disconnected
  case notInGame = "not_in_game"
}

public enum PairFailure: String, Codable, Sendable {
  case wrongCode = "wrong_code"
}

public enum AgentEvent: Codable, Equatable, Sendable {
  case started(model: String)
  case text(String)
  case tool(name: String, input: ToolInput)
  case toolResult(text: String)
  case progress(activity: String, elapsedSeconds: Int)
  case planStep(done: Int, remainingSeconds: Int)
  case done(text: String, turns: Int, costUsd: Double)
  case failed(reason: String)

  private enum Key: String, CodingKey {
    case kind, model, text, name, input, activity, elapsedSeconds, done, remainingSeconds, turns, costUsd, reason
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    switch try container.decode(String.self, forKey: .kind) {
    case "started":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .model])
      self = .started(model: try container.decode(String.self, forKey: .model))
    case "text":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .text])
      self = .text(try container.decode(String.self, forKey: .text))
    case "tool":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .name, .input])
      self = .tool(name: try container.decode(String.self, forKey: .name), input: try container.decode(ToolInput.self, forKey: .input))
    case "tool_result":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .text])
      self = .toolResult(text: try container.decode(String.self, forKey: .text))
    case "progress":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .activity, .elapsedSeconds])
      self = .progress(
        activity: try container.decode(String.self, forKey: .activity),
        elapsedSeconds: try container.decode(Int.self, forKey: .elapsedSeconds))
    case "plan_step":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .done, .remainingSeconds])
      self = .planStep(
        done: try container.decode(Int.self, forKey: .done),
        remainingSeconds: try container.decode(Int.self, forKey: .remainingSeconds))
    case "done":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .text, .turns, .costUsd])
      self = .done(
        text: try container.decode(String.self, forKey: .text),
        turns: try container.decode(Int.self, forKey: .turns),
        costUsd: try container.decode(Double.self, forKey: .costUsd))
    case "failed":
      try rejectUnknownKeys(in: decoder, allowed: [Key.kind, .reason])
      self = .failed(reason: try container.decode(String.self, forKey: .reason))
    case let kind:
      throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "모르는 에이전트 이벤트: \(kind)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    switch self {
    case .started(let model):
      try container.encode("started", forKey: .kind)
      try container.encode(model, forKey: .model)
    case .text(let text):
      try container.encode("text", forKey: .kind)
      try container.encode(text, forKey: .text)
    case .tool(let name, let input):
      try container.encode("tool", forKey: .kind)
      try container.encode(name, forKey: .name)
      try container.encode(input, forKey: .input)
    case .toolResult(let text):
      try container.encode("tool_result", forKey: .kind)
      try container.encode(text, forKey: .text)
    case .progress(let activity, let elapsedSeconds):
      try container.encode("progress", forKey: .kind)
      try container.encode(activity, forKey: .activity)
      try container.encode(elapsedSeconds, forKey: .elapsedSeconds)
    case .planStep(let done, let remainingSeconds):
      try container.encode("plan_step", forKey: .kind)
      try container.encode(done, forKey: .done)
      try container.encode(remainingSeconds, forKey: .remainingSeconds)
    case .done(let text, let turns, let costUsd):
      try container.encode("done", forKey: .kind)
      try container.encode(text, forKey: .text)
      try container.encode(turns, forKey: .turns)
      try container.encode(costUsd, forKey: .costUsd)
    case .failed(let reason):
      try container.encode("failed", forKey: .kind)
      try container.encode(reason, forKey: .reason)
    }
  }
}

public enum DesktopMessage: Codable, Equatable, Sendable {
  case paired(pcName: String)
  case pairFailed(reason: PairFailure)
  case status(connector: ConnectorState, wings: Int)
  case approvalRequest(id: String, askId: String, tool: String, input: ToolInput, wings: Int, plan: Plan?)
  case event(id: String, seq: Int, AgentEvent)

  private enum Key: String, CodingKey {
    case type, pcName, reason, connector, wings, id, askId, tool, input, plan, seq, event
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    switch try container.decode(String.self, forKey: .type) {
    case "paired":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .pcName])
      self = .paired(pcName: try container.decode(String.self, forKey: .pcName))
    case "pair_failed":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .reason])
      self = .pairFailed(reason: try container.decode(PairFailure.self, forKey: .reason))
    case "status":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .connector, .wings])
      self = .status(
        connector: try container.decode(ConnectorState.self, forKey: .connector),
        wings: try container.decode(Int.self, forKey: .wings))
    case "approval_request":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .id, .askId, .tool, .input, .wings, .plan])
      self = .approvalRequest(
        id: try container.decode(String.self, forKey: .id),
        askId: try container.decode(String.self, forKey: .askId),
        tool: try container.decode(String.self, forKey: .tool),
        input: try container.decode(ToolInput.self, forKey: .input),
        wings: try container.decode(Int.self, forKey: .wings),
        plan: try container.decodeIfPresent(Plan.self, forKey: .plan))
    case "event":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .id, .seq, .event])
      self = .event(
        id: try container.decode(String.self, forKey: .id),
        seq: try container.decode(Int.self, forKey: .seq),
        try container.decode(AgentEvent.self, forKey: .event))
    case let type:
      throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "모르는 데스크탑 메시지: \(type)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    switch self {
    case .paired(let pcName):
      try container.encode("paired", forKey: .type)
      try container.encode(pcName, forKey: .pcName)
    case .pairFailed(let reason):
      try container.encode("pair_failed", forKey: .type)
      try container.encode(reason, forKey: .reason)
    case .status(let connector, let wings):
      try container.encode("status", forKey: .type)
      try container.encode(connector, forKey: .connector)
      try container.encode(wings, forKey: .wings)
    case .approvalRequest(let id, let askId, let tool, let input, let wings, let plan):
      try container.encode("approval_request", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(askId, forKey: .askId)
      try container.encode(tool, forKey: .tool)
      try container.encode(input, forKey: .input)
      try container.encode(wings, forKey: .wings)
      try container.encodeIfPresent(plan, forKey: .plan)
    case .event(let id, let seq, let event):
      try container.encode("event", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(seq, forKey: .seq)
      try container.encode(event, forKey: .event)
    }
  }
}
