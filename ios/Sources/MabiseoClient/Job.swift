import MabiseoProtocol

public struct Job: Equatable, Sendable {
  public let plan: Plan
  public internal(set) var done: Int
  public internal(set) var remainingSeconds: Int
  public internal(set) var ended = false

  public var finished: Bool { done >= plan.steps.count }

  public var current: PlanStep? { done < plan.steps.count ? plan.steps[done] : nil }

  public var facilityInUse: (facility: String, works: Int)? {
    guard let current, current.kind != .gather, let facility = current.facility else { return nil }
    let register = plan.steps[...done].last { $0.kind == .register && $0.item == current.item }
    guard let register else { return nil }
    return (facility, register.count)
  }

  public func state(of link: ChainLink) -> ChainLink.State {
    if link.steps.allSatisfy({ $0 < done }) { return .finished }
    if let current, link.steps.contains(done) { return .active(current.kind) }
    return .pending
  }
}

public struct ChainLink: Equatable, Sendable {
  public enum Source: Equatable, Sendable {
    case gathered, made
  }

  public enum State: Equatable, Sendable {
    case pending
    case active(PlanStep.Kind)
    case finished
  }

  public let item: String
  public let source: Source
  public let count: Int
  public let times: Int
  public let seconds: Int
  public let wings: Int
  public let steps: [Int]
}

extension Plan {
  public var totalSeconds: Int { steps.reduce(0) { $0 + $1.seconds } }

  public var totalWings: Int { steps.reduce(0) { $0 + $1.wings } }

  public var links: [ChainLink] {
    var order: [String] = []
    var indices: [String: [Int]] = [:]
    for (index, step) in steps.enumerated() {
      if indices[step.item] == nil { order.append(step.item) }
      indices[step.item, default: []].append(index)
    }
    return order.map { item in
      let own = indices[item, default: []]
      let picked = own.map { steps[$0] }
      let gathered = picked.allSatisfy { $0.kind == .gather }
      let counted = picked.filter { $0.kind == (gathered ? .gather : .collect) }
      return ChainLink(
        item: item,
        source: gathered ? .gathered : .made,
        count: counted.reduce(0) { $0 + $1.count },
        times: gathered ? counted.count : picked.filter { $0.kind == .register }.reduce(0) { $0 + $1.count },
        seconds: picked.filter { $0.kind == (gathered ? .gather : .wait) }.reduce(0) { $0 + $1.seconds },
        wings: picked.reduce(0) { $0 + $1.wings },
        steps: own)
    }
  }
}
