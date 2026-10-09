import MabiseoProtocol
import Testing
@testable import MabiseoClient

private let metal = "금속 가공 시설"

private let steel = Plan(item: "강철괴", count: 9, steps: [
  PlanStep(kind: .gather, item: "철 광석", count: 100, seconds: 138, wings: 5),
  PlanStep(kind: .register, item: "철괴", count: 3, seconds: 7, wings: 15, facility: metal),
  PlanStep(kind: .wait, item: "철괴", count: 9, seconds: 90, wings: 0, facility: metal),
  PlanStep(kind: .collect, item: "철괴", count: 9, seconds: 6, wings: 0, facility: metal),
  PlanStep(kind: .register, item: "강철괴", count: 3, seconds: 7, wings: 15, facility: metal),
  PlanStep(kind: .wait, item: "강철괴", count: 9, seconds: 900, wings: 0, facility: metal),
  PlanStep(kind: .collect, item: "강철괴", count: 9, seconds: 6, wings: 0, facility: metal),
])

@Test("계획의 사슬은 품목이 처음 나온 순서로, 채집은 모은 수와 횟수, 가공은 받는 수 · 등록 수 · 가공 시간을 센다")
func linksFollowMaterials() {
  #expect(steel.links.map { [$0.item, "\($0.count)", "\($0.times)", "\($0.seconds)", "\($0.wings)"] } == [
    ["철 광석", "100", "1", "138", "5"],
    ["철괴", "9", "3", "90", "15"],
    ["강철괴", "9", "3", "900", "15"],
  ])
  #expect(steel.links.map(\.source) == [.gathered, .made, .made])
  #expect(steel.totalWings == 35)
  #expect(steel.totalSeconds == 1154)
}

@Test("승인 카드는 사슬마다 채집 횟수나 가공 횟수와 시간을 말한다")
func approvalWording() {
  #expect(steel.links.map(PlanText.how) == ["채집 1번", "가공 3번 · 1분 30초", "가공 3번 · 15분"])
  #expect(PlanText.about(steel.totalSeconds) == "약 20분")
}

@Test("진행 중에는 마친 사슬은 모음 · 받음, 지금 사슬은 지금 단계, 남은 사슬은 수를 말하고 지금 시설의 묶음 수를 센다")
func progressWording() {
  let job = Job(plan: steel, done: 4, remainingSeconds: 920)
  #expect(steel.links.map { PlanText.state($0, in: job) } == ["100 모음", "9 받음", "등록 중"])
  #expect(job.facilityInUse?.facility == metal)
  #expect(job.facilityInUse?.works == 3)
  #expect(PlanText.progress(job) == "4/7 · 약 16분 남음")

  let waiting = Job(plan: steel, done: 5, remainingSeconds: 400)
  #expect(PlanText.state(steel.links[2], in: waiting) == "가공 중")
  #expect(waiting.facilityInUse?.works == 3)

  let gathering = Job(plan: steel, done: 0, remainingSeconds: 1154)
  #expect(steel.links.map { PlanText.state($0, in: gathering) } == ["채집 중", "9", "9"])
  #expect(gathering.facilityInUse == nil)
}

@Test("다 마치면 다 됐어요, 중간에 끝나면 멈춘 단계를 말한다")
func endWording() {
  #expect(PlanText.progress(Job(plan: steel, done: 7, remainingSeconds: 0, ended: true)) == "다 됐어요")
  #expect(PlanText.progress(Job(plan: steel, done: 2, remainingSeconds: 900, ended: true)) == "멈췄어요 · 2/7")
}

@Test("계획이 멈추거나 바뀌면 그 까닭을 한 줄로 말하고, 다 마친 것은 단계 줄이 이미 말하므로 따로 말하지 않는다")
func endedWording() {
  #expect(PlanText.ended(.stopped) == "가공 대기가 끝나지 않아 계획을 멈췄어요")
  #expect(PlanText.ended(.replaced) == "계획이 새 계획으로 바뀌었어요")
  #expect(PlanText.ended(.done) == nil)
}

@Test("마친 단계는 지난 일로 말한다")
func finishedStepWording() {
  #expect(steel.steps.map(PlanText.finished) == [
    "철 광석 100개를 모았어요",
    "철괴 가공 3번을 등록했어요",
    "철괴 가공이 끝났어요",
    "철괴 9개를 받았어요",
    "강철괴 가공 3번을 등록했어요",
    "강철괴 가공이 끝났어요",
    "강철괴 9개를 받았어요",
  ])
}

@Test("시간은 1분 아래는 초로, 그 위는 분과 남는 초로 쓰고, 어림은 분을 올림한다")
func durationWording() {
  #expect(PlanText.duration(7) == "7초")
  #expect(PlanText.duration(90) == "1분 30초")
  #expect(PlanText.duration(900) == "15분")
  #expect(PlanText.about(45) == "45초")
  #expect(PlanText.about(61) == "약 2분")
}
