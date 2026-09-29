public protocol Transport: Sendable {
  func connect() async throws
  func send(_ text: String) async throws
  func messages() -> AsyncThrowingStream<String, any Error>
  func close()
}
