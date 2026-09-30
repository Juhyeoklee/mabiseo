import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "../connector/connector.js";
import { readJson } from "../connector/recordings.js";
import { Jobs, type Progress } from "./jobs.js";

const dir = fileURLToPath(new URL("../../recordings/", import.meta.url));

const active: Json = { Mode: { MainButtonState: "Fishing" }, Performance: { IsPlaying: false } };

function started(response: Json): boolean {
  return !(
    typeof response === "object" &&
    response !== null &&
    !Array.isArray(response) &&
    typeof response.error === "string"
  );
}

function setup(queue: Array<Json | Error>) {
  const poll = vi.fn(async (): Promise<Json> => {
    const next = queue.shift();
    if (next === undefined) throw new Error("poll 큐가 비었다");
    if (next instanceof Error) throw next;
    return next;
  });
  const jobs = new Jobs({ poll, started, intervalMs: 1000 });
  const progress: Progress[] = [];
  jobs.watch((p) => progress.push(p));
  return { jobs, poll, progress };
}

function pending() {
  let resolve!: (value: Json) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Json>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { execute: () => promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("작업 관리", () => {
  it("맡기기가 도는 동안 주기마다 진행이 흐르고 경과 시간이 는다", async () => {
    const { jobs, poll, progress } = setup([]);
    const execute = pending();
    void jobs.run("execute_gathering", execute.execute);
    await vi.advanceTimersByTimeAsync(2000);
    expect(progress).toEqual([
      { activity: "execute_gathering", elapsedSeconds: 1 },
      { activity: "execute_gathering", elapsedSeconds: 2 },
    ]);
    expect(jobs.current).toBeDefined();
    expect(poll).not.toHaveBeenCalled();
  });

  it("맡기기가 돌아오고 get_activity가 idle이면 활동이 풀리고 진행이 멈춘다", async () => {
    const { jobs, progress } = setup([await readJson(dir, "get_activity.json")]);
    const response = { result: "completed", gained: 3 };
    await expect(jobs.run("execute_gathering", async () => response)).resolves.toEqual(response);
    expect(jobs.current).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(progress).toEqual([]);
  });

  it("거부로 돌아온 맡기기는 활동을 시작하지 않았으니 get_activity를 묻지 않고 바로 풀린다", async () => {
    const { jobs, poll } = setup([]);
    const rejection = { error: "not_found", message: "" };
    await expect(jobs.run("execute_gathering", async () => rejection)).resolves.toEqual(rejection);
    expect(jobs.current).toBeUndefined();
    expect(poll).toHaveBeenCalledTimes(0);
  });

  it("started로 돌아온 낚시는 get_activity가 활동 중인 동안 붙들고 idle이 되면 푼다", async () => {
    const { jobs, poll, progress } = setup([active, active, await readJson(dir, "get_activity.json")]);
    await expect(jobs.run("fishing", async () => ({ result: "started" }))).resolves.toEqual({ result: "started" });
    expect(jobs.current).toBeDefined();
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(jobs.current).toBeDefined();
    expect(progress).toEqual([{ activity: "fishing", elapsedSeconds: 1 }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(3);
    expect(jobs.current).toBeUndefined();
  });

  it("붙든 활동이 있으면 run은 던진다", async () => {
    const { jobs } = setup([active]);
    await jobs.run("fishing", async () => ({ result: "started" }));
    await expect(jobs.run("execute_gathering", async () => ({ result: "completed" }))).rejects.toThrow(Error);
    expect(jobs.current?.name).toBe("fishing");
  });

  it("recheck는 붙든 활동이 idle이면 다음 주기를 기다리지 않고 푼다", async () => {
    const { jobs } = setup([active, await readJson(dir, "get_activity.json")]);
    await jobs.run("fishing", async () => ({ result: "started" }));
    expect(jobs.current).toBeDefined();
    await jobs.recheck();
    expect(jobs.current).toBeUndefined();
  });

  it("recheck는 맡기기가 아직 돌아오지 않았으면 get_activity를 묻지 않는다", async () => {
    const { jobs, poll } = setup([]);
    const execute = pending();
    void jobs.run("execute_gathering", execute.execute);
    await jobs.recheck();
    expect(poll).toHaveBeenCalledTimes(0);
    expect(jobs.current).toBeDefined();
  });

  it("watch를 푼 뒤에는 진행이 오지 않는다", async () => {
    const jobs = new Jobs({ poll: async () => null, started, intervalMs: 1000 });
    const progress: Progress[] = [];
    const unwatch = jobs.watch((p) => progress.push(p));
    const execute = pending();
    void jobs.run("execute_gathering", execute.execute);
    await vi.advanceTimersByTimeAsync(1000);
    expect(progress).toHaveLength(1);
    unwatch();
    await vi.advanceTimersByTimeAsync(3000);
    expect(progress).toHaveLength(1);
  });

  it("맡기기가 던지면 활동을 풀고 그대로 던진다", async () => {
    const { jobs, progress } = setup([]);
    const execute = pending();
    const failure = new Error("CLI 프로세스 없음");
    const running = jobs.run("execute_gathering", execute.execute);
    execute.reject(failure);
    await expect(running).rejects.toBe(failure);
    expect(jobs.current).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(progress).toEqual([]);
  });

  it("get_activity가 던지면 활동을 풀지 않고 다음 주기에 다시 본다", async () => {
    const { jobs, poll } = setup([new Error("CLI 프로세스 없음"), new Error("CLI 프로세스 없음"), await readJson(dir, "get_activity.json")]);
    const response = { result: "started" };
    await expect(jobs.run("fishing", async () => response)).resolves.toEqual(response);
    expect(jobs.current).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(jobs.current).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(jobs.current).toBeUndefined();
    expect(poll).toHaveBeenCalledTimes(3);
  });
});
