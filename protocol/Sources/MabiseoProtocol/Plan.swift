public struct PlanStep: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable {
    case gather, register, wait, collect
  }

  public let kind: Kind
  public let item: String
  public let count: Int
  public let seconds: Int
  public let wings: Int
  public let facility: String?

  public init(kind: Kind, item: String, count: Int, seconds: Int, wings: Int, facility: String? = nil) {
    self.kind = kind
    self.item = item
    self.count = count
    self.seconds = seconds
    self.wings = wings
    self.facility = facility
  }

  private enum CodingKeys: String, CodingKey {
    case kind, item, count, seconds, wings, facility
  }

  public init(from decoder: Decoder) throws {
    try rejectUnknownKeys(in: decoder, allowed: [CodingKeys.kind, .item, .count, .seconds, .wings, .facility])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    kind = try container.decode(Kind.self, forKey: .kind)
    item = try container.decode(String.self, forKey: .item)
    count = try container.decode(Int.self, forKey: .count)
    seconds = try container.decode(Int.self, forKey: .seconds)
    wings = try container.decode(Int.self, forKey: .wings)
    facility = try container.decodeIfPresent(String.self, forKey: .facility)
  }
}

public struct Plan: Codable, Equatable, Sendable {
  public let item: String
  public let count: Int
  public let steps: [PlanStep]

  public init(item: String, count: Int, steps: [PlanStep]) {
    self.item = item
    self.count = count
    self.steps = steps
  }

  private enum CodingKeys: String, CodingKey {
    case item, count, steps
  }

  public init(from decoder: Decoder) throws {
    try rejectUnknownKeys(in: decoder, allowed: [CodingKeys.item, .count, .steps])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    item = try container.decode(String.self, forKey: .item)
    count = try container.decode(Int.self, forKey: .count)
    steps = try container.decode([PlanStep].self, forKey: .steps)
  }
}
