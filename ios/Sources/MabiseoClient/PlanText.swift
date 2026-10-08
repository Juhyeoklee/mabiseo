import Foundation
import MabiseoProtocol

public enum PlanText {
  public static func duration(_ seconds: Int) -> String {
    if seconds < 60 { return "\(seconds)초" }
    let minutes = seconds / 60
    let rest = seconds % 60
    return rest == 0 ? "\(minutes)분" : "\(minutes)분 \(rest)초"
  }

  public static func about(_ seconds: Int) -> String {
    seconds < 60 ? "\(seconds)초" : "약 \((seconds + 59) / 60)분"
  }

  public static func progress(_ job: Job) -> String {
    if job.finished { return "다 됐어요" }
    if job.ended { return "멈췄어요 · \(job.done)/\(job.plan.steps.count)" }
    return "\(job.done)/\(job.plan.steps.count) · \(about(job.remainingSeconds)) 남음"
  }

  public static func how(_ link: ChainLink) -> String {
    switch link.source {
    case .gathered: "채집 \(link.times)번"
    case .made: "가공 \(link.times)번 · \(duration(link.seconds))"
    }
  }

  public static func state(_ link: ChainLink, in job: Job) -> String {
    switch job.state(of: link) {
    case .pending: "\(link.count)"
    case .finished: link.source == .gathered ? "\(link.count) 모음" : "\(link.count) 받음"
    case .active(.gather): "채집 중"
    case .active(.register): "등록 중"
    case .active(.wait): "가공 중"
    case .active(.collect): "받는 중"
    }
  }

  public static func finished(_ step: PlanStep) -> String {
    switch step.kind {
    case .gather: "\(step.item) \(step.count)개를 모았어요"
    case .register: "\(step.item) 가공 \(step.count)번을 등록했어요"
    case .wait: "\(step.item) 가공이 끝났어요"
    case .collect: "\(step.item) \(step.count)개를 받았어요"
    }
  }
}
