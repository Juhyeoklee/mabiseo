import Foundation
import MabiseoProtocol
import Testing
@testable import MabiseoClient

private let fixtures = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .deletingLastPathComponent()
  .appendingPathComponent("protocol/fixtures/desktop")

private func fixture(_ name: String) throws -> String {
  try String(contentsOf: fixtures.appendingPathComponent("\(name).json"), encoding: .utf8)
}

private func json(_ text: String) throws -> NSDictionary {
  try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
}

@MainActor
private func settle(_ condition: @MainActor () -> Bool) async {
  for _ in 0..<200 where !condition() {
    try? await Task.sleep(for: .milliseconds(5))
  }
  #expect(condition())
}

@MainActor
private func pairedSession(transport: FakeTransport = FakeTransport(), ids: [String] = ["a1"]) async throws -> Session {
  let queue = Ids(ids)
  let session = Session(makeTransport: { transport }, makeId: { queue.next() })
  await session.pair(code: "123456")
  transport.push(try fixture("paired"))
  transport.push(try fixture("status"))
  await settle { session.status != nil }
  return session
}

private final class Ids: @unchecked Sendable {
  private var ids: [String]
  init(_ ids: [String]) { self.ids = ids }
  func next() -> String { ids.removeFirst() }
}

@MainActor
@Test("맞는 코드로 pair하면 paired와 status가 화면 상태에 실린다")
func pairSucceeds() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  #expect(session.phase == .paired(pcName: "SOAP-PC"))
  #expect(session.status == Status(connector: .connected, wings: 10))
  #expect(try json(await transport.sent[0]) == ["type": "pair", "code": "123456"])
}

@MainActor
@Test("틀린 코드면 wrongCode가 되고, 다시 pair하면 재접속 없이 pair만 한 번 더 보낸다")
func wrongCodeRetriesOnSameSocket() async throws {
  let transport = FakeTransport()
  let session = Session(makeTransport: { transport })
  await session.pair(code: "000000")
  transport.push(try fixture("pair_failed"))
  await settle { session.phase == .wrongCode }
  await session.pair(code: "123456")
  #expect(session.phase == .pairing)
  #expect(await transport.connects == 1)
  #expect(await transport.sent.count == 2)
}

@MainActor
@Test("PC에 닿지 못하면 lost가 된다")
func unreachableIsLost() async {
  let session = Session(makeTransport: { FakeTransport(reachable: false) })
  await session.pair(code: "123456")
  #expect(session.phase == .lost(.unreachable))
}

@MainActor
@Test("paired 전에는 ask를 보내지 않는다")
func askBeforePairedIsIgnored() async {
  let transport = FakeTransport()
  let session = Session(makeTransport: { transport })
  await session.ask("날개 얼마나 남았어")
  #expect(session.entries.isEmpty)
  #expect(await transport.sent.isEmpty)
}

@MainActor
@Test("ask는 요청 항목을 남기고 ask 메시지를 보내며, event가 순서대로 쌓이고 done이면 진행이 끝난다")
func askStreamsEvents() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("날개 얼마나 남았어")
  #expect(session.busy)
  #expect(try json(await transport.sent[1]) == ["type": "ask", "id": "a1", "text": "날개 얼마나 남았어"])
  for name in ["event.started", "event.tool", "event.tool_result", "event.text", "event.done"] {
    transport.push(try fixture(name))
  }
  await settle { !session.busy }
  #expect(session.entries.map(\.body) == [
    .request("날개 얼마나 남았어"),
    .agent(.started(model: "claude-opus-5-5")),
    .agent(.tool(name: "get_currencies", input: [:])),
    .agent(.toolResult(text: "{\"wings\":10}")),
    .agent(.text("날개가 10개 남았다.")),
    .agent(.done(text: "채집을 시작했다.", turns: 3, costUsd: 0.0312)),
  ])
}

@MainActor
@Test("다른 id의 event와 승인 요청은 무시한다")
func staleMessagesAreIgnored() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a2"])
  await session.ask("뭐 해")
  transport.push(try fixture("event.text"))
  transport.push(try fixture("approval_request"))
  transport.push(#"{"type":"event","id":"a2","event":{"kind":"text","text":"보고 있다."}}"#)
  await settle { session.entries.count == 2 }
  #expect(session.entries.last?.body == .agent(.text("보고 있다.")))
  #expect(session.approval == nil)
}

@MainActor
@Test("진행 중이면 두 번째 ask는 보내지 않는다")
func secondAskWhileBusyIsIgnored() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a1", "a2"])
  await session.ask("하나")
  await session.ask("둘")
  #expect(session.entries.count == 1)
  #expect(await transport.sent.count == 2)
}

@MainActor
@Test("approval_request가 오면 승인 대기에 실리고, 허용하면 approve가 나가고 대기가 비워진다")
func approvalRoundTrip() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("새록 버섯 100개 캐 줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  #expect(session.approval == PendingApproval(id: "r1", tool: "execute_gathering", input: ["displayName": .string("새록 버섯"), "count": .number(100)], wings: 5))
  await session.approve(true)
  #expect(session.approval == nil)
  #expect(try json(await transport.sent[2]) == ["type": "approve", "id": "r1", "allow": true])
}

@MainActor
@Test("cancel은 진행 중인 ask의 id로 나가고, failed(cancelled)가 오면 진행이 끝난다")
func cancelEndsRun() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("새록 버섯 100개 캐 줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  await session.cancel()
  #expect(try json(await transport.sent[2]) == ["type": "cancel", "id": "a1"])
  transport.push(try fixture("event.failed"))
  await settle { !session.busy }
  #expect(session.approval == nil)
  #expect(session.entries.last?.body == .agent(.failed(reason: "cancelled")))
}

@MainActor
@Test("진행 중이 아니면 cancel을 보내지 않는다")
func cancelWithoutRunIsIgnored() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.cancel()
  #expect(await transport.sent.count == 1)
}

@MainActor
@Test("PC가 연결을 닫으면 lost가 되고 진행 중인 ask와 승인 대기는 비워진다")
func closedSocketIsLost() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("새록 버섯 100개 캐 줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  transport.close()
  await settle { session.phase == .lost(.closed) }
  #expect(!session.busy)
  #expect(session.approval == nil)
  #expect(session.entries.count == 1)
}

@MainActor
@Test("모르는 메시지가 오면 lost가 된다")
func unknownMessageIsLost() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  transport.push(#"{"type":"popup"}"#)
  await settle { session.phase == .lost(.unknownMessage) }
}

@MainActor
@Test("disconnect하면 disconnected가 되고, 뒤따라 끝나는 수신 루프가 lost로 덮지 않는다")
func disconnectStaysDisconnected() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  session.disconnect()
  #expect(session.phase == .disconnected)
  try await Task.sleep(for: .milliseconds(50))
  #expect(session.phase == .disconnected)
}

@MainActor
@Test("lost 뒤에 다시 pair하면 새 연결을 연다")
func pairAfterLostReconnects() async throws {
  let first = FakeTransport()
  let second = FakeTransport()
  let transports = Ids(["first", "second"])
  let session = Session(makeTransport: { transports.next() == "first" ? first : second })
  await session.pair(code: "123456")
  first.close()
  await settle { session.phase != .pairing }
  await session.pair(code: "123456")
  #expect(session.phase == .pairing)
  #expect(await second.connects == 1)
  #expect(await second.sent.count == 1)
}
