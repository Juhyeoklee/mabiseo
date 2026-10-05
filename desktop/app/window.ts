interface Screen {
  rows: { label: string; value: string }[];
  log: string[];
}

interface Bridge {
  onScreen(listener: (screen: Screen) => void): void;
  recheck(): void;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`window.html에 #${id}가 없다`);
  return found;
}

const bridge = (window as unknown as { mabiseo: Bridge }).mabiseo;
const rowsList = element("rows");
const logList = element("log");

bridge.onScreen((screen) => {
  rowsList.replaceChildren(
    ...screen.rows.flatMap((row) => {
      const label = document.createElement("dt");
      label.textContent = row.label;
      const value = document.createElement("dd");
      value.textContent = row.value;
      return [label, value];
    }),
  );
  const atBottom = logList.scrollHeight - logList.scrollTop - logList.clientHeight < 8;
  logList.textContent = screen.log.join("\n");
  if (atBottom) logList.scrollTop = logList.scrollHeight;
});

element("recheck").addEventListener("click", () => bridge.recheck());
