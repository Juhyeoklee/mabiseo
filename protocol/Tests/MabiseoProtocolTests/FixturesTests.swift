import Foundation
import Testing
import MabiseoProtocol

private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .appendingPathComponent("fixtures")

private func files(_ dir: String) throws -> [URL] {
  try FileManager.default
    .contentsOfDirectory(at: fixtures.appendingPathComponent(dir), includingPropertiesForKeys: nil)
    .filter { $0.pathExtension == "json" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
}

private func roundTrip<Message: Codable>(_ url: URL, as: Message.Type) throws {
  let original = try Data(contentsOf: url)
  let decoded = try JSONDecoder().decode(Message.self, from: original)
  let encoded = try JSONEncoder().encode(decoded)
  let before = try #require(try JSONSerialization.jsonObject(with: original) as? NSDictionary)
  let after = try #require(try JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
  #expect(before == after, "\(url.lastPathComponent)")
}

@Test("폰 픽스처 전부가 PhoneMessage로 디코드되고 다시 인코드하면 원본과 같다")
func phoneFixturesRoundTrip() throws {
  let urls = try files("phone")
  #expect(!urls.isEmpty)
  for url in urls { try roundTrip(url, as: PhoneMessage.self) }
}

@Test("데스크탑 픽스처 전부가 DesktopMessage로 디코드되고 다시 인코드하면 원본과 같다")
func desktopFixturesRoundTrip() throws {
  let urls = try files("desktop")
  #expect(!urls.isEmpty)
  for url in urls { try roundTrip(url, as: DesktopMessage.self) }
}

@Test("모르는 type은 디코드에 실패한다")
func unknownTypeFails() {
  let data = Data(#"{"type":"popup","id":"a1"}"#.utf8)
  #expect(throws: DecodingError.self) { try JSONDecoder().decode(DesktopMessage.self, from: data) }
}

@Test("모르는 필드가 있는 메시지는 디코드에 실패한다")
func unknownFieldFails() {
  let data = Data(#"{"type":"cancel","id":"a1","force":true}"#.utf8)
  #expect(throws: DecodingError.self) { try JSONDecoder().decode(PhoneMessage.self, from: data) }
}

@Test("이벤트 안의 모르는 필드도 디코드에 실패한다")
func unknownEventFieldFails() {
  let data = Data(#"{"type":"event","id":"a1","event":{"kind":"text","text":"안녕","bold":true}}"#.utf8)
  #expect(throws: DecodingError.self) { try JSONDecoder().decode(DesktopMessage.self, from: data) }
}
