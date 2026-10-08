import Foundation
import MabiseoProtocol
import Observation

public enum Loss: Equatable, Sendable {
  case unreachable
  case closed
  case dropped
  case unknownMessage
}

public enum Phase: Equatable, Sendable {
  case disconnected
  case pairing
  case paired(pcName: String)
  case wrongCode
  case lost(Loss)
}

public struct Status: Equatable, Sendable {
  public let connector: ConnectorState
  public let wings: Int
}

public struct PendingApproval: Equatable, Sendable, Identifiable {
  public let id: String
  public let tool: String
  public let input: ToolInput
  public let wings: Int
  public let plan: Plan?
}

public struct Entry: Equatable, Sendable, Identifiable {
  public enum Body: Equatable, Sendable {
    case request(String)
    case agent(AgentEvent)
    case plan(Plan, done: Int)
  }

  public let id: Int
  public let body: Body
}

@MainActor @Observable
public final class Session {
  public private(set) var phase: Phase = .disconnected
  public private(set) var status: Status?
  public private(set) var entries: [Entry] = []
  public private(set) var approval: PendingApproval?
  public private(set) var askId: String?
  public private(set) var pcName: String?
  public private(set) var job: Job?

  private let makeTransport: @Sendable () -> any Transport
  private let makeId: @Sendable () -> String
  private var transport: (any Transport)?
  private var receiving: Task<Void, Never>?
  private var nextEntryId = 0
  private var code: String?
  private var nextSeq = 0
  private var approvedPlan: Plan?

  public init(makeTransport: @escaping @Sendable () -> any Transport, makeId: @escaping @Sendable () -> String = { UUID().uuidString }) {
    self.makeTransport = makeTransport
    self.makeId = makeId
  }

  public var busy: Bool { askId != nil }

  public func pair(code: String) async {
    self.code = code
    if transport == nil {
      let transport = makeTransport()
      phase = .pairing
      do {
        try await transport.connect()
      } catch {
        phase = .lost(.unreachable)
        return
      }
      self.transport = transport
      receiving = Task { await receive(from: transport) }
    }
    phase = .pairing
    await send(.pair(code: code))
  }

  public func ask(_ text: String) async {
    guard case .paired = phase, askId == nil else { return }
    let id = makeId()
    askId = id
    nextSeq = 0
    job = nil
    approvedPlan = nil
    append(.request(text))
    await send(.ask(id: id, text: text))
  }

  public func approve(_ allow: Bool) async {
    guard let approval else { return }
    self.approval = nil
    if allow, let plan = approval.plan { approvedPlan = plan }
    await send(.approve(id: approval.id, allow: allow))
  }

  public func cancel() async {
    guard let askId else { return }
    await send(.cancel(id: askId))
  }

  public func disconnect() {
    transport?.close()
    drop(phase: .disconnected)
    askId = nil
    pcName = nil
    code = nil
  }

  public func reconnect() async {
    guard let code, phase != .pairing else { return }
    receiving?.cancel()
    receiving = nil
    transport?.close()
    transport = nil
    approval = nil
    await pair(code: code)
  }

  private func send(_ message: PhoneMessage) async {
    guard let transport, let data = try? JSONEncoder().encode(message), let text = String(data: data, encoding: .utf8) else { return }
    do {
      try await transport.send(text)
    } catch {
      transport.close()
      drop(phase: .lost(.dropped))
    }
  }

  private func receive(from transport: any Transport) async {
    do {
      for try await text in transport.messages() {
        guard let message = try? JSONDecoder().decode(DesktopMessage.self, from: Data(text.utf8)) else {
          transport.close()
          drop(phase: .lost(.unknownMessage))
          return
        }
        handle(message)
      }
      if !Task.isCancelled { drop(phase: .lost(.closed)) }
    } catch {
      if !Task.isCancelled { drop(phase: .lost(.dropped)) }
    }
  }

  private func handle(_ message: DesktopMessage) {
    switch message {
    case .paired(let pcName):
      phase = .paired(pcName: pcName)
      self.pcName = pcName
    case .pairFailed(.wrongCode):
      phase = .wrongCode
    case .status(let connector, let wings):
      status = Status(connector: connector, wings: wings)
    case .approvalRequest(let id, let askId, let tool, let input, let wings, let plan):
      guard askId == self.askId else { return }
      approval = PendingApproval(id: id, tool: tool, input: input, wings: wings, plan: plan)
      if plan != nil { dropToolLinesSinceRequest() }
    case .event(let id, let seq, let event):
      guard id == askId, seq >= nextSeq else { return }
      nextSeq = seq + 1
      record(event)
      switch event {
      case .planStep(let done, let remainingSeconds):
        if let plan = approvedPlan { job = Job(plan: plan, done: done, remainingSeconds: remainingSeconds) }
      case .done, .failed:
        askId = nil
        approval = nil
        job?.ended = true
      case .started, .text, .tool, .toolResult, .progress:
        break
      }
    }
  }

  private func record(_ event: AgentEvent) {
    if job?.ended == false {
      switch event {
      case .tool, .toolResult, .progress: return
      default: break
      }
    }
    switch (event, entries.last?.body) {
    case (.progress, .agent(.progress)?):
      replaceLast(with: event)
    case (.planStep(let done, _), _) where approvedPlan != nil:
      guard let plan = approvedPlan else { return }
      let shown = entries.last { if case .plan = $0.body { true } else { false } }
      if shown?.body == .plan(plan, done: done) { return }
      append(.plan(plan, done: done))
    default:
      append(.agent(event))
    }
  }

  private func dropToolLinesSinceRequest() {
    guard let request = entries.lastIndex(where: { if case .request = $0.body { true } else { false } }) else { return }
    let kept = entries[(request + 1)...].filter { entry in
      switch entry.body {
      case .agent(.tool), .agent(.toolResult), .agent(.progress): false
      default: true
      }
    }
    entries.replaceSubrange((request + 1)..., with: kept)
  }

  private func replaceLast(with event: AgentEvent) {
    guard let last = entries.last else { return }
    entries[entries.count - 1] = Entry(id: last.id, body: .agent(event))
  }

  private func append(_ body: Entry.Body) {
    entries.append(Entry(id: nextEntryId, body: body))
    nextEntryId += 1
  }

  private func drop(phase: Phase) {
    receiving?.cancel()
    receiving = nil
    transport = nil
    approval = nil
    self.phase = phase
  }
}
