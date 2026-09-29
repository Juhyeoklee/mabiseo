import Foundation
import Network
import dnssd

public struct ResolvedAddress: Equatable, Sendable {
  public let host: String
  public let port: UInt16
}

public enum ResolveError: Error, Equatable {
  case dnssd(Int32)
  case timeout
}

public final class MulticastResolver: @unchecked Sendable {
  private let queue = DispatchQueue(label: "mabiseo.resolve")
  private let interfaceIndex: UInt32
  private var resolveRef: DNSServiceRef?
  private var addressRef: DNSServiceRef?
  private var continuation: CheckedContinuation<ResolvedAddress, any Error>?
  private var port: UInt16 = 0

  public init(interface: NWInterface?) {
    interfaceIndex = UInt32(interface?.index ?? 0)
  }

  public func resolve(name: String, domain: String, timeout: TimeInterval = 5) async throws -> ResolvedAddress {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        self.continuation = continuation
        let error = DNSServiceResolve(
          &self.resolveRef, DNSServiceFlags(kDNSServiceFlagsForceMulticast), self.interfaceIndex,
          name, serviceType, domain, resolveReply, Unmanaged.passUnretained(self).toOpaque())
        guard error == kDNSServiceErr_NoError else { return self.finish(.failure(ResolveError.dnssd(error))) }
        DNSServiceSetDispatchQueue(self.resolveRef, self.queue)
        self.queue.asyncAfter(deadline: .now() + timeout) { self.finish(.failure(ResolveError.timeout)) }
      }
    }
  }

  fileprivate func resolved(host: String, port: UInt16, error: DNSServiceErrorType) {
    guard error == kDNSServiceErr_NoError else { return finish(.failure(ResolveError.dnssd(error))) }
    guard addressRef == nil else { return }
    self.port = port
    let started = DNSServiceGetAddrInfo(
      &addressRef, DNSServiceFlags(kDNSServiceFlagsForceMulticast), interfaceIndex,
      DNSServiceProtocol(kDNSServiceProtocol_IPv4), host, addressReply, Unmanaged.passUnretained(self).toOpaque())
    guard started == kDNSServiceErr_NoError else { return finish(.failure(ResolveError.dnssd(started))) }
    DNSServiceSetDispatchQueue(addressRef, queue)
  }

  fileprivate func found(address: String, error: DNSServiceErrorType) {
    guard error == kDNSServiceErr_NoError else { return finish(.failure(ResolveError.dnssd(error))) }
    finish(.success(ResolvedAddress(host: address, port: port)))
  }

  private func finish(_ result: Result<ResolvedAddress, any Error>) {
    guard let continuation else { return }
    self.continuation = nil
    nonisolated(unsafe) let refs = [resolveRef, addressRef]
    resolveRef = nil
    addressRef = nil
    queue.async { for ref in refs { if let ref { DNSServiceRefDeallocate(ref) } } }
    continuation.resume(with: result)
  }
}

private let resolveReply: DNSServiceResolveReply = { _, _, _, error, _, host, port, _, _, context in
  guard let context else { return }
  let resolver = Unmanaged<MulticastResolver>.fromOpaque(context).takeUnretainedValue()
  resolver.resolved(host: host.map { String(cString: $0) } ?? "", port: UInt16(bigEndian: port), error: error)
}

private let addressReply: DNSServiceGetAddrInfoReply = { _, _, _, error, _, address, _, context in
  guard let context else { return }
  let resolver = Unmanaged<MulticastResolver>.fromOpaque(context).takeUnretainedValue()
  var text = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
  if let address {
    var sin = UnsafeRawPointer(address).load(as: sockaddr_in.self)
    inet_ntop(AF_INET, &sin.sin_addr, &text, socklen_t(text.count))
  }
  resolver.found(address: String(decoding: text.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self), error: error)
}
