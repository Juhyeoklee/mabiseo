import Foundation

public enum TransportError: Error, Equatable {
  case unreachable
  case dropped
}

public final class WebSocketTransport: NSObject, Transport, URLSessionWebSocketDelegate, @unchecked Sendable {
  private let pc: FoundPC
  private let stream: AsyncThrowingStream<String, any Error>
  private let incoming: AsyncThrowingStream<String, any Error>.Continuation
  private let opening = Pending()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?

  public init(pc: FoundPC) {
    self.pc = pc
    (stream, incoming) = AsyncThrowingStream.makeStream()
  }

  public func connect() async throws {
    let address = try await MulticastResolver(interface: pc.interface).resolve(name: pc.name, domain: pc.domain)
    guard let url = URL(string: "ws://\(address.host):\(address.port)/") else { throw TransportError.unreachable }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: url)
    self.session = session
    self.task = task
    try await withCheckedThrowingContinuation { (ready: CheckedContinuation<Void, any Error>) in
      opening.put(ready)
      task.resume()
    }
    receive(from: task)
  }

  public func send(_ text: String) async throws {
    guard let task else { throw TransportError.dropped }
    do {
      try await task.send(.string(text))
    } catch {
      throw TransportError.dropped
    }
  }

  public func messages() -> AsyncThrowingStream<String, any Error> {
    stream
  }

  public func close() {
    task?.cancel(with: .normalClosure, reason: nil)
    session?.invalidateAndCancel()
  }

  public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    opening.take()?.resume()
  }

  public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    incoming.finish()
    session.invalidateAndCancel()
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    if let ready = opening.take() {
      ready.resume(throwing: TransportError.unreachable)
    } else if error != nil {
      incoming.finish(throwing: TransportError.dropped)
    } else {
      incoming.finish()
    }
    session.invalidateAndCancel()
  }

  private func receive(from task: URLSessionWebSocketTask) {
    task.receive { [self] result in
      switch result {
      case .success(.string(let text)):
        incoming.yield(text)
        receive(from: task)
      case .success(.data(let data)):
        if let text = String(data: data, encoding: .utf8) { incoming.yield(text) }
        receive(from: task)
      case .success:
        receive(from: task)
      case .failure:
        incoming.finish(throwing: TransportError.dropped)
      }
    }
  }
}

private final class Pending: @unchecked Sendable {
  private var continuation: CheckedContinuation<Void, any Error>?
  private let lock = NSLock()

  func put(_ continuation: CheckedContinuation<Void, any Error>) {
    lock.withLock { self.continuation = continuation }
  }

  func take() -> CheckedContinuation<Void, any Error>? {
    lock.withLock {
      defer { continuation = nil }
      return continuation
    }
  }
}
