import MabiseoClient
import SwiftUI

struct RootView: View {
  @State private var session: Session?

  var body: some View {
    if let session, let pcName = session.pcName {
      ChatView(session: session, pcName: pcName) {
        session.disconnect()
        self.session = nil
      }
    } else {
      ConnectView(session: $session)
    }
  }
}
