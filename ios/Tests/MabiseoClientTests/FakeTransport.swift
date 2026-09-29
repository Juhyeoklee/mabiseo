import MabiseoClient

actor FakeTransport: Transport {
  struct Unreachable: Error {}

  private(set) var sent: [String] = []
  private(set) var connects = 0
  private let reachable: Bool
  private let stream: AsyncThrowingStream<String, any Error>
  private let continuation: AsyncThrowingStream<String, any Error>.Continuation

  init(reachable: Bool = true) {
    self.reachable = reachable
    (stream, continuation) = AsyncThrowingStream.makeStream()
  }

  func connect() async throws {
    connects += 1
    if !reachable { throw Unreachable() }
  }

  func send(_ text: String) async throws {
    sent.append(text)
  }

  nonisolated func messages() -> AsyncThrowingStream<String, any Error> {
    stream
  }

  nonisolated func close() {
    continuation.finish()
  }

  nonisolated func push(_ text: String) {
    continuation.yield(text)
  }
}
