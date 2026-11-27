const byId = (id) => document.getElementById(id);
const format = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const names = { running: "В работе", stopping: "Остановка", paused: "На паузе", complete: "Завершено", closing: "Закрытие позиции" };
let busy = false;
let current;

function render(grid) {
  current = grid;
  const mode = grid?.mode;
  byId("status").textContent = grid ? names[mode] + " · " + grid.settings.symbol : "Сетка не запущена";
  byId("volume").textContent = format.format(grid?.volume ?? 0) + " USDC";
  byId("progress").max = grid?.settings.target ?? 100000;
  byId("progress").value = grid?.volume ?? 0;
  byId("detail").textContent = grid ? [
    "Цель " + format.format(grid.settings.target) + " USDC", "Исполнений " + grid.fills, grid.note,
    grid.settings.continueStress && grid.volume >= grid.settings.target && "Стресс-тест продолжается после цели",
    grid.pending && "ID заявки " + grid.pending.id,
    grid.position && "Позиция " + grid.position.size
  ].filter(Boolean).join(" · ") : "";
  byId("stop").disabled = busy || !grid || (!["running", "closing"].includes(mode) && !(mode === "paused" && grid.pending));
  byId("resume").disabled = busy || mode !== "paused";
  byId("close").disabled = busy || mode !== "paused" || !grid.position || Boolean(grid.pending);
  byId("reset").disabled = busy || mode !== "paused";
  byId("start").querySelector("button").disabled = busy || Boolean(grid?.position || grid?.pending || ["running", "stopping", "closing"].includes(mode));
}

async function send(action, payload = {}) {
  if (busy) return false;
  busy = true;
  render(current);
  byId("error").hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({ action, ...payload });
    if (!result.ok) throw Error(result.error);
    if (result.data !== undefined) {
      byId("result").hidden = false;
      byId("result").textContent = JSON.stringify(result.data, null, 2);
    }
    return true;
  } catch (error) {
    byId("error").textContent = error.message;
    byId("error").hidden = false;
    return false;
  } finally {
    busy = false;
    render((await chrome.storage.local.get("grid")).grid);
  }
}

byId("connect").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  event.target.elements.seed.value = "";
  await send("connect", data);
});

const setup = byId("start");
setup.elements.strategy.addEventListener("change", () => {
  const stress = setup.elements.strategy.value === "stress";
  byId("continue-stress").hidden = !stress;
  setup.elements.continueStress.disabled = !stress;
  byId("range").hidden = stress;
  byId("range").querySelectorAll("input").forEach((input) => { input.disabled = stress; });
  byId("hint").textContent = stress
    ? "Бот поочерёдно открывает и закрывает позицию рыночными заявками. Спред и движение цены влияют на результат."
    : "Сетка выставляет один вход за раз и закрывает его на следующем уровне.";
});
setup.addEventListener("submit", (event) => {
  event.preventDefault();
  send("start", { config: Object.fromEntries(new FormData(setup)) });
});

for (const action of ["stop", "resume", "account", "positions", "orders", "fills"]) {
  byId(action).addEventListener("click", () => send(action));
}
byId("close").addEventListener("click", () => {
  if (confirm("Отправить рыночную reduce-only заявку в тестнете?")) send("close");
});
byId("reset").addEventListener("click", () => {
  if (confirm("Удалить локальный журнал? Перед сбросом проверьте заявки и позиции в Omni.")) send("reset");
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.grid) render(changes.grid.newValue);
});
chrome.storage.local.get("grid").then(({ grid }) => render(grid));
chrome.storage.session.get("key").then(({ key }) => { byId("connection").open = !key; });
