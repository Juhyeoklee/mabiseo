import Foundation
import Network
import Testing
@testable import MabiseoClient

@Test("Bonjour로 광고된 서비스를 멀티캐스트만으로 주소와 포트로 푼다")
func resolvesAdvertisedService() async throws {
  let name = "mabiseo-test-\(UUID().uuidString.prefix(8))"
  let listener = try NWListener(using: .tcp)
  listener.service = NWListener.Service(name: name, type: serviceType)
  listener.newConnectionHandler = { $0.cancel() }
  let registered = AsyncStream<Void>.makeStream()
  listener.serviceRegistrationUpdateHandler = { change in
    if case .add = change { registered.continuation.yield() }
  }
  listener.start(queue: DispatchQueue(label: "test.listener"))
  defer { listener.cancel() }
  for await _ in registered.stream { break }

  let address = try await MulticastResolver(interface: nil).resolve(name: name, domain: "local.")
  #expect(address.port == listener.port?.rawValue)
  #expect(IPv4Address(address.host) != nil)
}

@Test("없는 서비스는 시간 안에 못 찾으면 timeout으로 끝난다")
func missingServiceTimesOut() async {
  await #expect(throws: ResolveError.timeout) {
    try await MulticastResolver(interface: nil).resolve(name: "mabiseo-none-\(UUID())", domain: "local.", timeout: 0.5)
  }
}
