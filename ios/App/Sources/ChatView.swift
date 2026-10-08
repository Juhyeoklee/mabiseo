import MabiseoClient
import MabiseoProtocol
import SwiftUI

struct ChatView: View {
  let session: Session
  let pcName: String
  let leave: () -> Void
  @State private var draft = ""
  @State private var wasInBackground = false
  @FocusState private var typing: Bool
  @Environment(\.scenePhase) private var scenePhase

  private var linked: Bool {
    if case .paired = session.phase { true } else { false }
  }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
              ForEach(Array(session.entries.enumerated()), id: \.element.id) { index, entry in
                EntryView(entry: entry, previous: index > 0 ? session.entries[index - 1] : nil)
                  .id(entry.id)
              }
            }
            .padding()
          }
          .onChange(of: session.entries.count) { _, _ in
            if let last = session.entries.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
          }
        }
        if let approval = session.approval {
          Group {
            if let plan = approval.plan {
              PlanApprovalView(plan: plan, wings: approval.wings) { allow in Task { await session.approve(allow) } }
            } else {
              ApprovalView(approval: approval) { allow in Task { await session.approve(allow) } }
            }
          }
          .disabled(!linked)
        }
        composer
      }
      .navigationTitle(pcName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("연결 끊기", action: leave)
        }
      }
      .safeAreaInset(edge: .top, spacing: 0) {
        VStack(spacing: 0) {
          connectionBand
          if let job = session.job {
            JobBar(job: job)
          } else if let status = session.status {
            StatusView(status: status)
          }
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background:
        wasInBackground = true
      case .active where wasInBackground:
        wasInBackground = false
        Task { await session.reconnect() }
      default:
        break
      }
    }
    .onChange(of: session.phase) { old, new in
      // 붙어 있다가 끊긴 순간만 다시 붙는다. 다시 연결 실패(pairing → lost)에도 부르면 PC가 꺼져 있을 때 재시도가 끝없이 돈다
      if case .paired = old, case .lost = new, scenePhase == .active {
        Task { await session.reconnect() }
      }
    }
  }

  @ViewBuilder
  private var connectionBand: some View {
    switch session.phase {
    case .paired:
      EmptyView()
    case .pairing:
      band { Text("다시 연결하는 중") }
    case .lost, .disconnected:
      band {
        Text("PC와 연결이 끊어졌어요.")
        Button("다시 연결") { Task { await session.reconnect() } }
          .buttonStyle(.bordered)
          .controlSize(.small)
      }
    case .wrongCode:
      band { Text("PC의 페어링 코드가 바뀌었어요. 연결 끊기 후 다시 연결해 주세요.") }
    }
  }

  private func band(@ViewBuilder _ content: () -> some View) -> some View {
    HStack(spacing: 8) { content() }
      .font(.footnote)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
      .padding(.horizontal)
      .background(.orange.opacity(0.15))
  }

  private var composer: some View {
    HStack(spacing: 8) {
      TextField("할 일을 말해 주세요", text: $draft, axis: .vertical)
        .lineLimit(1...4)
        .textFieldStyle(.roundedBorder)
        .focused($typing)
        .disabled(session.busy || !linked)
      if session.busy {
        Button("중단", role: .destructive) { Task { await session.cancel() } }
          .buttonStyle(.bordered)
          .disabled(!linked)
      } else {
        Button("보내기") {
          let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { return }
          draft = ""
          Task { await session.ask(text) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(!linked || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding()
    .background(.bar)
  }
}

private struct StatusView: View {
  let status: Status

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(status.connector == .connected ? .green : .orange)
        .frame(width: 8, height: 8)
      Text(connectorText)
      Text("날개 \(status.wings)")
        .foregroundStyle(.secondary)
    }
    .font(.caption)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 6)
    .background(.bar)
  }

  private var connectorText: String {
    switch status.connector {
    case .connected: "게임 연결됨"
    case .disconnected: "게임 꺼짐"
    case .notInGame: "게임 밖"
    }
  }
}

private struct ApprovalView: View {
  let approval: PendingApproval
  let answer: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("날개 \(approval.wings)개를 써요", systemImage: "exclamationmark.triangle")
        .font(.headline)
      Text("\(approval.tool)  \(describe(approval.input))")
        .font(.footnote.monospaced())
        .foregroundStyle(.secondary)
      HStack {
        Button("거절", role: .destructive) { answer(false) }
          .buttonStyle(.bordered)
        Button("허용") { answer(true) }
          .buttonStyle(.borderedProminent)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.yellow.opacity(0.15))
  }
}

private let wingInk = Color(red: 0.54, green: 0.32, blue: 0)

private struct PlanApprovalView: View {
  let plan: Plan
  let wings: Int
  let answer: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline) {
        Text("이렇게 만들어요").font(.headline)
        Spacer()
        Text(PlanText.about(plan.totalSeconds)).font(.footnote).foregroundStyle(.secondary)
      }
      HStack(alignment: .top, spacing: 4) {
        ForEach(plan.links, id: \.item) { link in
          VStack(spacing: 6) {
            VStack(spacing: 2) {
              Text(link.item).font(.footnote).foregroundStyle(.secondary)
              Text("\(link.count)").font(.title3.bold())
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(link.item == plan.item ? Color.accentColor.opacity(0.12) : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            Text(PlanText.how(link)).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if link.wings > 0 {
              Text("날개 \(link.wings)").font(.caption.weight(.semibold)).foregroundStyle(wingInk)
            }
          }
          .frame(maxWidth: .infinity)
        }
      }
      HStack {
        Text("날개를 써요")
        Spacer()
        Text("\(wings)").bold()
      }
      .foregroundStyle(wingInk)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
      HStack(spacing: 8) {
        Button(role: .destructive) { answer(false) } label: {
          Text("거절").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        Button { answer(true) } label: {
          Text("맡기기").bold().frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
      }
      .controlSize(.large)
    }
    .padding()
    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
    .padding(12)
    .background(Color(.secondarySystemBackground))
  }
}

private struct JobBar: View {
  let job: Job

  // 가공 시설은 7칸이다(recordings/queue-full/)
  private let facilitySlots = 7

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text("\(job.plan.item) \(job.plan.count)개").bold()
        Spacer()
        Text(PlanText.progress(job)).font(.footnote).foregroundStyle(.secondary)
      }
      ProgressView(value: Double(job.done), total: Double(job.plan.steps.count))
      HStack(spacing: 4) {
        ForEach(job.plan.links, id: \.item) { link in
          let state = job.state(of: link)
          VStack(spacing: 2) {
            Text(link.item).font(.caption).foregroundStyle(.secondary)
            Text(PlanText.state(link, in: job)).font(.subheadline.bold()).foregroundStyle(ink(state))
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .background(fill(state), in: RoundedRectangle(cornerRadius: 10))
        }
      }
      if let use = job.facilityInUse {
        VStack(alignment: .leading, spacing: 4) {
          Text(use.facility).font(.caption).foregroundStyle(.secondary)
          HStack(spacing: 4) {
            ForEach(0..<facilitySlots, id: \.self) { slot in
              RoundedRectangle(cornerRadius: 2)
                .fill(slot < use.works ? Color.accentColor : Color(.systemGray5))
                .frame(height: 8)
            }
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(use.facility) \(facilitySlots)칸 중 \(use.works)칸 사용")
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 12)
    .background(.bar)
  }

  private func ink(_ state: ChainLink.State) -> Color {
    switch state {
    case .finished: .green
    case .active: .accentColor
    case .pending: .primary
    }
  }

  private func fill(_ state: ChainLink.State) -> Color {
    switch state {
    case .finished: .green.opacity(0.12)
    case .active: .accentColor.opacity(0.12)
    case .pending: Color(.secondarySystemBackground)
    }
  }
}

private struct EntryView: View {
  let entry: Entry
  let previous: Entry?

  var body: some View {
    switch entry.body {
    case .request(let text):
      bubble(text, mine: true)
    case .agent(.text(let text)):
      bubble(text, mine: false)
    case .agent(.done(let text, let turns, let costUsd)):
      if previous?.body != .agent(.text(text)) { bubble(text, mine: false) }
      caption("끝 · \(turns)턴 · $\(String(format: "%.3f", costUsd))")
    case .agent(.started(let model)):
      caption("생각하는 중 · \(model)")
    case .agent(.tool(let name, let input)):
      caption("\(name) \(describe(input))")
    case .agent(.toolResult(let text)):
      caption(text, lines: 3)
    case .agent(.progress(let activity, let elapsedSeconds)):
      caption("\(activity) 진행 중 · \(elapsedSeconds / 60)분 \(elapsedSeconds % 60)초")
    case .plan(let plan, let done):
      if done == 0 {
        Text("날개 \(plan.totalWings)개 쓰기로 했어요")
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
      } else if done <= plan.steps.count {
        Text(PlanText.finished(plan.steps[done - 1])).font(.subheadline)
      }
    case .agent(.planStep):
      EmptyView()
    case .agent(.failed(let reason)):
      caption(failureText(reason)).foregroundStyle(.red)
    }
  }

  private func bubble(_ text: String, mine: Bool) -> some View {
    HStack {
      if mine { Spacer(minLength: 40) }
      Text(text)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(mine ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .foregroundStyle(mine ? .white : .primary)
      if !mine { Spacer(minLength: 40) }
    }
  }

  private func caption(_ text: String, lines: Int = 2) -> some View {
    Text(text)
      .font(.caption.monospaced())
      .foregroundStyle(.secondary)
      .lineLimit(lines)
  }

  private func failureText(_ reason: String) -> String {
    switch reason {
    case "cancelled": "중단했어요"
    case "busy": "PC가 아직 앞의 일을 하고 있어요"
    default: "실패: \(reason)"
    }
  }
}

private func describe(_ input: ToolInput) -> String {
  input.keys.sorted().map { "\($0)=\(describe(input[$0]!))" }.joined(separator: " ")
}

private func describe(_ value: JSONValue) -> String {
  switch value {
  case .null: "null"
  case .bool(let bool): String(bool)
  case .number(let number): number == number.rounded() ? String(Int(number)) : String(number)
  case .string(let string): string
  case .array(let items): "[" + items.map(describe).joined(separator: ", ") + "]"
  case .object(let object): "{" + describe(object) + "}"
  }
}
