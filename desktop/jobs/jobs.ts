import type { Json } from "../connector/connector.js";
import { isActive } from "./activity.js";

export interface Activity {
  name: string;
  startedAt: number;
}

export interface Progress {
  activity: string;
  elapsedSeconds: number;
}

export type Listener = (progress: Progress) => void;

export interface JobsOptions {
  poll: () => Promise<Json>;
  started: (response: Json) => boolean;
  intervalMs: number;
}

export class Jobs {
  readonly #options: JobsOptions;
  readonly #listeners = new Set<Listener>();
  #current: Activity | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #held = false;

  constructor(options: JobsOptions) {
    this.#options = options;
  }

  get current(): Activity | undefined {
    return this.#current;
  }

  watch(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // 활동을 겹쳐 부르면 게임이 앞 활동을 조용히 취소한다. 이 검사를 빼면 그 경로가 열린다.
  async run(name: string, execute: () => Promise<Json>): Promise<Json> {
    if (this.#current) throw new Error(`이미 붙든 활동이 있다: ${this.#current.name}`);
    const activity: Activity = { name, startedAt: Date.now() };
    this.#current = activity;
    this.#timer = setInterval(() => void this.#tick(activity), this.#options.intervalMs);

    let response: Json;
    try {
      response = await execute();
    } catch (error) {
      this.#release(activity);
      throw error;
    }
    if (!this.#options.started(response)) {
      this.#release(activity);
      return response;
    }
    if (await this.#stillActive()) this.#held = true;
    else this.#release(activity);
    return response;
  }

  async recheck(): Promise<void> {
    const activity = this.#current;
    if (!activity || !this.#held) return;
    await this.#check(activity);
  }

  async #tick(activity: Activity): Promise<void> {
    const progress: Progress = {
      activity: activity.name,
      elapsedSeconds: Math.round((Date.now() - activity.startedAt) / 1000),
    };
    for (const listener of [...this.#listeners]) listener(progress);
    if (this.#held) await this.#check(activity);
  }

  async #check(activity: Activity): Promise<void> {
    if (!(await this.#stillActive())) this.#release(activity);
  }

  // 조회가 던져도 게임은 활동 중일 수 있다. 여기서 풀면 다음 맡기기가 앞 활동을 조용히 취소한다
  async #stillActive(): Promise<boolean> {
    try {
      return isActive(await this.#options.poll());
    } catch {
      return true;
    }
  }

  #release(activity: Activity): void {
    if (this.#current !== activity) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#current = undefined;
    this.#held = false;
  }
}
