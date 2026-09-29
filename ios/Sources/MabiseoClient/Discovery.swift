import Network
import Observation

public let serviceType = "_mabiseo._tcp"

public struct FoundPC: Identifiable, Hashable, Sendable {
  public let name: String
  public let domain: String
  public let interface: NWInterface?

  public var id: String { name }
}

@MainActor @Observable
public final class Discovery {
  public private(set) var pcs: [FoundPC] = []
  private var browser: NWBrowser?

  public init() {}

  public func start() {
    guard browser == nil else { return }
    let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: .tcp)
    browser.browseResultsChangedHandler = { results, _ in
      let pcs = results
        .compactMap { result -> FoundPC? in
          guard case .service(let name, _, let domain, _) = result.endpoint else { return nil }
          return FoundPC(name: name, domain: domain, interface: result.interfaces.first)
        }
        .sorted { $0.name < $1.name }
      MainActor.assumeIsolated { self.pcs = pcs }
    }
    browser.start(queue: .main)
    self.browser = browser
  }

  public func stop() {
    browser?.cancel()
    browser = nil
    pcs = []
  }
}
