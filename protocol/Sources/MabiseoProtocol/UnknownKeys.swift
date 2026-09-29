private struct AnyKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }
}

func rejectUnknownKeys<Key: CodingKey>(in decoder: Decoder, allowed: [Key]) throws {
  let present = try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue)
  let unknown = Set(present).subtracting(allowed.map(\.stringValue))
  guard unknown.isEmpty else {
    throw DecodingError.dataCorrupted(
      .init(codingPath: decoder.codingPath, debugDescription: "모르는 필드: \(unknown.sorted().joined(separator: ", "))"))
  }
}
