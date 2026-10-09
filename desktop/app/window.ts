interface Row {
  label: string;
  value: string;
}

interface Chip extends Row {
  tone: "good" | "caution" | "bad" | "neutral";
}

type Card =
  | { kind: "idle" }
  | { kind: "request"; title: string; status: string }
  | {
      kind: "plan";
      title: string;
      status: string;
      running: boolean;
      fraction: number;
      facts: Row[];
      steps: { label: string; note: string; state: "done" | "now" | "next" }[];
    };

interface Screen {
  chips: Chip[];
  rows: Row[];
  action: { kind: "login" | "logout"; label: string } | undefined;
  card: Card;
  asking: boolean;
  log: { at: string; text: string }[];
}

interface Bridge {
  onScreen(listener: (screen: Screen) => void): void;
  recheck(): void;
  login(): void;
  logout(): void;
  stop(): void;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`window.html에 #${id}가 없다`);
  return found;
}

function make(tag: string, className: string, text?: string): HTMLElement {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

const bridge = (window as unknown as { mabiseo: Bridge }).mabiseo;
const chipList = element("chips");
const detailsButton = element("details-toggle");
const details = element("details");
const rowsList = element("rows");
const loginButton = element("login");
const logoutButton = element("logout");
const cardSection = element("card");
const title = element("title");
const bar = element("bar");
const fill = element("fill");
const facts = element("facts");
const status = element("status");
const steps = element("steps");
const logList = element("log");
const stopButton = element("stop") as HTMLButtonElement;

bridge.onScreen((screen) => {
  chipList.replaceChildren(
    ...screen.chips.map((chip) => {
      const item = make("li", `chip ${chip.tone}`);
      item.append(make("span", "dot"), make("span", "muted", chip.label), make("span", "", chip.value));
      return item;
    }),
  );
  rowsList.replaceChildren(...screen.rows.flatMap((row) => [make("dt", "", row.label), make("dd", "", row.value)]));
  loginButton.hidden = screen.action?.kind !== "login";
  loginButton.textContent = screen.action?.label ?? "";
  logoutButton.hidden = screen.action?.kind !== "logout";
  logoutButton.textContent = screen.action?.label ?? "";
  showCard(screen.card);
  stopButton.disabled = !screen.asking;
  showLog(screen.log);
});

function showCard(card: Card): void {
  const plan = card.kind === "plan" ? card : undefined;
  title.textContent = card.kind === "idle" ? "맡긴 일 없음" : card.title;
  status.textContent = card.kind === "idle" ? "폰에서 할 일을 보내면 여기에 진행이 보여요" : card.status;
  status.classList.toggle("now", plan?.running ?? false);
  bar.hidden = !plan;
  fill.style.width = `${Math.round((plan?.fraction ?? 0) * 100)}%`;
  facts.replaceChildren(
    ...(plan?.facts ?? []).map((fact) => {
      const item = make("span", "");
      item.append(make("span", "muted", fact.label), " ", make("strong", "", fact.value));
      return item;
    }),
  );
  steps.hidden = !plan;
  cardSection.classList.toggle("alone", !plan);
  steps.replaceChildren(
    ...(plan?.steps ?? []).map((step) => {
      const item = make("li", step.state);
      item.append(make("span", "", step.label), make("span", "note", step.note));
      return item;
    }),
  );
  steps.querySelector(".now")?.scrollIntoView({ block: "nearest" });
}

function showLog(log: Screen["log"]): void {
  const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 8;
  logList.replaceChildren(
    ...log.map((line) => {
      const item = make("li", "");
      item.append(make("time", "", line.at), make("span", "", line.text));
      return item;
    }),
  );
  if (atBottom) logList.scrollTop = logList.scrollHeight;
}

detailsButton.addEventListener("click", () => {
  details.hidden = !details.hidden;
  detailsButton.setAttribute("aria-expanded", String(!details.hidden));
});
element("recheck").addEventListener("click", () => bridge.recheck());
loginButton.addEventListener("click", () => bridge.login());
logoutButton.addEventListener("click", () => bridge.logout());
stopButton.addEventListener("click", () => bridge.stop());
