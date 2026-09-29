import MabiseoClient
import SwiftUI

struct ConnectView: View {
  @Binding var session: Session?
  @State private var discovery = Discovery()
  @State private var selected: FoundPC?
  @State private var code = ""

  var body: some View {
    NavigationStack {
      List {
        Section {
          if discovery.pcs.isEmpty {
            HStack(spacing: 12) {
              ProgressView()
              Text("같은 와이파이에서 PC를 찾는 중")
                .foregroundStyle(.secondary)
            }
          }
          ForEach(discovery.pcs) { pc in
            Button {
              if selected != pc {
                session?.disconnect()
                session = nil
              }
              selected = pc
              code = ""
            } label: {
              HStack {
                Label(pc.name, systemImage: "desktopcomputer")
                Spacer()
                if pc == selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
              }
            }
            .foregroundStyle(.primary)
          }
        } header: {
          Text("PC")
        } footer: {
          Text("PC에서 마비서 데스크탑이 켜져 있어야 보여요.")
        }

        if let selected {
          Section {
            TextField("6자리", text: $code)
              .keyboardType(.numberPad)
              .font(.system(.title2, design: .monospaced))
              .onChange(of: code) { _, new in code = String(new.filter(\.isNumber).prefix(6)) }
            Button(session?.phase == .pairing ? "연결하는 중" : "연결") {
              Task { await pair(to: selected) }
            }
            .disabled(code.count != 6 || session?.phase == .pairing)
          } header: {
            Text("\(selected.name)의 페어링 코드")
          } footer: {
            if let message { Text(message).foregroundStyle(.red) }
          }
        }
      }
      .navigationTitle("마비서")
    }
    .onAppear { discovery.start() }
    .onDisappear { discovery.stop() }
  }

  private var message: String? {
    switch session?.phase {
    case .wrongCode: "코드가 틀렸어요. PC 화면의 코드를 다시 확인해 주세요."
    case .lost(.unreachable): "PC에 연결하지 못했어요."
    case .lost(.closed), .lost(.dropped): "PC와 연결이 끊어졌어요."
    case .lost(.unknownMessage): "PC가 모르는 메시지를 보냈어요. 데스크탑과 앱의 버전이 다른지 확인해 주세요."
    case .none, .disconnected, .pairing, .paired: nil
    }
  }

  private func pair(to pc: FoundPC) async {
    if session == nil {
      session = Session(makeTransport: { WebSocketTransport(pc: pc) })
    }
    await session?.pair(code: code)
  }
}
