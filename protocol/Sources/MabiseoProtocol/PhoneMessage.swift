public enum PhoneMessage: Codable, Equatable, Sendable {
  case pair(code: String)
  case ask(id: String, text: String)
  case approve(id: String, allow: Bool)
  case cancel(id: String)

  private enum Key: String, CodingKey {
    case type, code, id, text, allow
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    switch try container.decode(String.self, forKey: .type) {
    case "pair":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .code])
      self = .pair(code: try container.decode(String.self, forKey: .code))
    case "ask":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .id, .text])
      self = .ask(id: try container.decode(String.self, forKey: .id), text: try container.decode(String.self, forKey: .text))
    case "approve":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .id, .allow])
      self = .approve(id: try container.decode(String.self, forKey: .id), allow: try container.decode(Bool.self, forKey: .allow))
    case "cancel":
      try rejectUnknownKeys(in: decoder, allowed: [Key.type, .id])
      self = .cancel(id: try container.decode(String.self, forKey: .id))
    case let type:
      throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "모르는 폰 메시지: \(type)")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Key.self)
    switch self {
    case .pair(let code):
      try container.encode("pair", forKey: .type)
      try container.encode(code, forKey: .code)
    case .ask(let id, let text):
      try container.encode("ask", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(text, forKey: .text)
    case .approve(let id, let allow):
      try container.encode("approve", forKey: .type)
      try container.encode(id, forKey: .id)
      try container.encode(allow, forKey: .allow)
    case .cancel(let id):
      try container.encode("cancel", forKey: .type)
      try container.encode(id, forKey: .id)
    }
  }
}
