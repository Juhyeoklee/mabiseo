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

private func event(_ name: String, seq: Int) throws -> String {
  let message = try #require(try JSONSerialization.jsonObject(with: Data(fixture(name).utf8)) as? NSDictionary).mutableCopy() as! NSMutableDictionary
  message["seq"] = seq
  return String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)
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
private func pairedSession(transport: FakeTransport = FakeTransport(), then later: [any Transport] = [], ids: [String] = ["a1"]) async throws -> Session {
  let queue = Ids(ids)
  let transports = Transports([transport] + later)
  let session = Session(makeTransport: { transports.next() }, makeId: { queue.next() })
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

private final class Transports: @unchecked Sendable {
  private var queue: [any Transport]
  init(_ queue: [any Transport]) { self.queue = queue }
  func next() -> any Transport { queue.count > 1 ? queue.removeFirst() : queue[0] }
}

private final class Watched: Transport, @unchecked Sendable {
  private let inner: FakeTransport
  private(set) var closed = false
  init(_ inner: FakeTransport) { self.inner = inner }
  func connect() async throws { try await inner.connect() }
  func send(_ text: String) async throws { try await inner.send(text) }
  func messages() -> AsyncThrowingStream<String, any Error> { inner.messages() }
  func close() {
    closed = true
    inner.close()
  }
}

private func text(_ id: String, seq: Int, _ text: String) -> String {
  #"{"type":"event","id":"\#(id)","seq":\#(seq),"event":{"kind":"text","text":"\#(text)"}}"#
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
  for (seq, name) in ["event.started", "event.tool", "event.tool_result", "event.text", "event.done"].enumerated() {
    transport.push(try event(name, seq: seq))
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
@Test("진행 event는 쌓이지 않고 마지막 진행 줄을 덮어쓴다")
func progressReplacesLastProgress() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("통나무 채집해")
  transport.push(try fixture("event.tool"))
  transport.push(#"{"type":"event","id":"a1","seq":1,"event":{"kind":"progress","activity":"execute_gathering","elapsedSeconds":20}}"#)
  transport.push(try event("event.progress", seq: 2))
  await settle { session.entries.last?.body == .agent(.progress(activity: "execute_gathering", elapsedSeconds: 40)) }
  #expect(session.entries.count == 3)
  #expect(session.busy)
}

@MainActor
@Test("다른 id의 event와 승인 요청은 무시한다")
func staleMessagesAreIgnored() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a2"])
  await session.ask("뭐 해")
  transport.push(try fixture("event.text"))
  transport.push(try fixture("approval_request"))
  transport.push(#"{"type":"event","id":"a2","seq":0,"event":{"kind":"text","text":"보고 있다."}}"#)
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
  await session.ask("철괴 9개 만들어줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  #expect(session.approval?.id == "r1")
  #expect(session.approval?.tool == "propose_plan")
  #expect(session.approval?.wings == 20)
  #expect(session.approval?.plan?.item == "철괴")
  #expect(session.approval?.plan?.steps.map(\.kind) == [.gather, .register, .wait, .collect])
  await session.approve(true)
  #expect(session.approval == nil)
  #expect(try json(await transport.sent[2]) == ["type": "approve", "id": "r1", "allow": true])
}

@MainActor
@Test("cancel은 진행 중인 ask의 id로 나가고, failed(cancelled)가 오면 진행이 끝난다")
func cancelEndsRun() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("철괴 9개 만들어줘")
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
@Test("PC가 연결을 닫으면 lost가 되고 승인 대기는 비워지지만 진행 중인 ask와 대화와 PC 이름은 남는다")
func closedSocketIsLost() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("철괴 9개 만들어줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  transport.close()
  await settle { session.phase == .lost(.closed) }
  #expect(session.busy)
  #expect(session.approval == nil)
  #expect(session.entries.map(\.body) == [.request("철괴 9개 만들어줘")])
  #expect(session.pcName == "SOAP-PC")
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

@MainActor
@Test("이미 받은 seq 이하의 event는 버린다")
func seenSeqIsDropped() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("뭐 해")
  transport.push(text("a1", seq: 0, "하나"))
  transport.push(text("a1", seq: 1, "둘"))
  transport.push(text("a1", seq: 0, "하나"))
  transport.push(text("a1", seq: 1, "둘"))
  transport.push(text("a1", seq: 2, "셋"))
  await settle { session.entries.last?.body == .agent(.text("셋")) }
  #expect(session.entries.map(\.body) == [.request("뭐 해"), .agent(.text("하나")), .agent(.text("둘")), .agent(.text("셋"))])
}

@MainActor
@Test("새 ask는 seq를 0부터 다시 센다")
func newAskRestartsSeq() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a1", "a2"])
  await session.ask("하나")
  transport.push(try fixture("event.done"))
  await settle { !session.busy }
  await session.ask("둘")
  transport.push(text("a2", seq: 0, "둘째 답"))
  await settle { session.entries.count == 4 }
  #expect(session.entries.last?.body == .agent(.text("둘째 답")))
}

@MainActor
@Test("reconnect는 새 연결을 열어 저장한 코드로 pair를 보내고, 다시 온 event 중 새것만 쌓으며 done이 오면 진행이 끝난다")
func reconnectReplaysOnlyNewEvents() async throws {
  let first = FakeTransport()
  let second = FakeTransport()
  let session = try await pairedSession(transport: first, then: [second])
  await session.ask("통나무 채집해")
  first.push(text("a1", seq: 0, "하나"))
  first.push(text("a1", seq: 1, "둘"))
  await settle { session.entries.count == 3 }
  await session.reconnect()
  #expect(await second.connects == 1)
  #expect(try json(await second.sent[0]) == ["type": "pair", "code": "123456"])
  second.push(try fixture("paired"))
  second.push(try fixture("status"))
  second.push(text("a1", seq: 0, "하나"))
  second.push(text("a1", seq: 1, "둘"))
  second.push(try event("event.done", seq: 2))
  await settle { !session.busy }
  #expect(session.phase == .paired(pcName: "SOAP-PC"))
  #expect(session.entries.map(\.body) == [
    .request("통나무 채집해"),
    .agent(.text("하나")),
    .agent(.text("둘")),
    .agent(.done(text: "채집을 시작했다.", turns: 3, costUsd: 0.0312)),
  ])
}

@MainActor
@Test("reconnect는 열린 연결을 닫고, 그 닫힘이 phase를 lost로 덮지 않는다")
func reconnectClosesWithoutLoss() async throws {
  let inner = FakeTransport()
  let first = Watched(inner)
  let second = FakeTransport()
  let transports = Transports([first, second])
  let session = Session(makeTransport: { transports.next() })
  await session.pair(code: "123456")
  inner.push(try fixture("paired"))
  await settle { session.pcName != nil }
  await session.reconnect()
  #expect(session.phase == .pairing)
  #expect(first.closed)
  try await Task.sleep(for: .milliseconds(50))
  #expect(session.phase == .pairing)
}

@MainActor
@Test("reconnect 뒤 다시 온 approval_request가 승인 대기에 실린다")
func reconnectReceivesApprovalAgain() async throws {
  let first = FakeTransport()
  let second = FakeTransport()
  let session = try await pairedSession(transport: first, then: [second])
  await session.ask("철괴 9개 만들어줘")
  first.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  await session.reconnect()
  #expect(session.approval == nil)
  second.push(try fixture("paired"))
  second.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  #expect(session.approval?.id == "r1")
}

@MainActor
@Test("다시 연결하지 못하면 lost(unreachable)가 되고 대화와 진행 중인 ask는 남는다")
func failedReconnectKeepsConversation() async throws {
  let first = FakeTransport()
  let session = try await pairedSession(transport: first, then: [FakeTransport(reachable: false)])
  await session.ask("통나무 채집해")
  first.push(text("a1", seq: 0, "하나"))
  await settle { session.entries.count == 2 }
  await session.reconnect()
  #expect(session.phase == .lost(.unreachable))
  #expect(session.busy)
  #expect(session.entries.map(\.body) == [.request("통나무 채집해"), .agent(.text("하나"))])
}

@MainActor
@Test("페어링한 적 없으면 reconnect는 연결을 열지 않는다")
func reconnectWithoutPairingDoesNothing() async {
  let transport = FakeTransport()
  let session = Session(makeTransport: { transport })
  await session.reconnect()
  #expect(await transport.connects == 0)
  #expect(session.phase == .disconnected)
}

@MainActor
@Test("disconnect하면 PC 이름과 진행 중인 ask가 비고 reconnect는 연결을 열지 않는다")
func disconnectForgetsPairing() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("뭐 해")
  session.disconnect()
  #expect(session.pcName == nil)
  #expect(!session.busy)
  await session.reconnect()
  #expect(await transport.connects == 1)
  #expect(session.phase == .disconnected)
}

@MainActor
@Test("다시 연결하는 중에 겹쳐 부른 reconnect는 새 연결을 하나만 연다")
func overlappingReconnectOpensOnce() async throws {
  let first = FakeTransport()
  let second = FakeTransport()
  let third = FakeTransport()
  let session = try await pairedSession(transport: first, then: [second, third])
  async let one: Void = session.reconnect()
  async let two: Void = session.reconnect()
  _ = await (one, two)
  #expect(await second.connects == 1)
  #expect(await third.connects == 0)
}

@MainActor
private func plannedSession(allow: Bool = true) async throws -> (Session, FakeTransport) {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("철괴 9개 만들어줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  await session.approve(allow)
  return (session, transport)
}

private func planStep(seq: Int, done: Int, remaining: Int) -> String {
  #"{"type":"event","id":"a1","seq":\#(seq),"event":{"kind":"plan_step","done":\#(done),"remainingSeconds":\#(remaining)}}"#
}

@MainActor
@Test("허용한 계획에 plan_step이 오면 job이 계획 · 마친 수 · 남은 시간을 싣고, 대화에는 단계마다 그 계획을 든 줄이 하나씩 붙는다")
func planStepMakesJob() async throws {
  let (session, transport) = try await plannedSession()
  transport.push(planStep(seq: 0, done: 0, remaining: 243))
  transport.push(planStep(seq: 1, done: 1, remaining: 103))
  transport.push(try event("event.text", seq: 2))
  transport.push(planStep(seq: 3, done: 1, remaining: 80))
  await settle { session.job?.remainingSeconds == 80 }
  let plan = try #require(session.job?.plan)
  #expect(plan.item == "철괴")
  #expect(session.job?.done == 1)
  #expect(session.entries.map(\.body) == [
    .request("철괴 9개 만들어줘"),
    .plan(plan, done: 0),
    .plan(plan, done: 1),
    .agent(.text("날개가 10개 남았다.")),
  ])
}

@MainActor
@Test("계획이 도는 동안 도구 · 결과 · 진행 줄은 대화에 쌓이지 않고, 끝나면 job은 끝남으로 남는다")
func planHidesToolLines() async throws {
  let (session, transport) = try await plannedSession()
  transport.push(planStep(seq: 0, done: 0, remaining: 243))
  transport.push(try event("event.tool", seq: 1))
  transport.push(try event("event.tool_result", seq: 2))
  transport.push(try event("event.progress", seq: 3))
  transport.push(try event("event.text", seq: 4))
  transport.push(try event("event.done", seq: 5))
  await settle { !session.busy }
  let plan = try #require(session.job?.plan)
  #expect(session.entries.map(\.body) == [
    .request("철괴 9개 만들어줘"),
    .plan(plan, done: 0),
    .agent(.text("날개가 10개 남았다.")),
    .agent(.done(text: "채집을 시작했다.", turns: 3, costUsd: 0.0312)),
  ])
  #expect(session.job?.ended == true)
}

@MainActor
@Test("plan_ended가 오면 요청이 끝나기 전에도 job이 끝남이 되고, 요청이 끝날 때까지 도구 줄은 계속 숨는다")
func planEndedEndsJob() async throws {
  let (session, transport) = try await plannedSession()
  transport.push(planStep(seq: 0, done: 0, remaining: 243))
  transport.push(#"{"type":"event","id":"a1","seq":1,"event":{"kind":"plan_ended","reason":"replaced"}}"#)
  transport.push(try event("event.tool", seq: 2))
  transport.push(try event("event.text", seq: 3))
  await settle { session.entries.count == 4 }
  let plan = try #require(session.job?.plan)
  #expect(session.job?.ended == true)
  #expect(session.busy)
  #expect(session.entries.map(\.body) == [
    .request("철괴 9개 만들어줘"),
    .plan(plan, done: 0),
    .agent(.planEnded(reason: .replaced)),
    .agent(.text("날개가 10개 남았다.")),
  ])
}

@MainActor
@Test("거절한 계획은 plan_step이 와도 job을 만들지 않는다")
func deniedPlanMakesNoJob() async throws {
  let (session, transport) = try await plannedSession(allow: false)
  transport.push(planStep(seq: 0, done: 0, remaining: 243))
  await settle { session.entries.count == 2 }
  #expect(session.job == nil)
}

@MainActor
@Test("새 ask는 앞 계획의 job을 비운다")
func newAskClearsJob() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a1", "a2"])
  await session.ask("철괴 9개 만들어줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  await session.approve(true)
  transport.push(planStep(seq: 0, done: 0, remaining: 243))
  transport.push(try event("event.done", seq: 1))
  await settle { !session.busy }
  #expect(session.job != nil)
  await session.ask("날개 얼마나 남았어")
  #expect(session.job == nil)
}

@MainActor
@Test("계획 승인 요청이 오면 그 요청을 부른 도구 줄을 대화에서 지운다")
func planApprovalDropsToolLines() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport)
  await session.ask("철괴 9개 만들어줘")
  transport.push(try event("event.started", seq: 0))
  transport.push(try event("event.tool", seq: 1))
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  #expect(session.entries.map(\.body) == [
    .request("철괴 9개 만들어줘"),
    .agent(.started(model: "claude-opus-5-5")),
  ])
}

@MainActor
@Test("새 계획이 시작돼도 앞 계획의 대화 줄은 앞 계획을 든 채 남는다")
func earlierPlanLinesKeepTheirPlan() async throws {
  let transport = FakeTransport()
  let session = try await pairedSession(transport: transport, ids: ["a1", "a2"])
  await session.ask("철괴 9개 만들어줘")
  transport.push(try fixture("approval_request"))
  await settle { session.approval != nil }
  await session.approve(true)
  transport.push(planStep(seq: 0, done: 1, remaining: 103))
  transport.push(try event("event.done", seq: 1))
  await settle { !session.busy }
  let first = try #require(session.job?.plan)

  await session.ask("강철괴 3개 만들어줘")
  let second = Plan(item: "강철괴", count: 3, steps: [PlanStep(kind: .register, item: "강철괴", count: 1, seconds: 7, wings: 5)])
  let request = DesktopMessage.approvalRequest(id: "r2", askId: "a2", tool: "propose_plan", input: [:], wings: 5, plan: second)
  transport.push(String(decoding: try JSONEncoder().encode(request), as: UTF8.self))
  await settle { session.approval != nil }
  await session.approve(true)
  transport.push(#"{"type":"event","id":"a2","seq":0,"event":{"kind":"plan_step","done":1,"remainingSeconds":0}}"#)
  await settle { session.job?.plan == second }
  #expect(session.entries.compactMap { if case .plan(let plan, let done) = $0.body { "\(plan.item) \(done)" } else { nil } } == ["철괴 1", "강철괴 1"])
}
