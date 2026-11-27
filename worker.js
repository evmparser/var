import { normalizeKey, request } from "./api.js";

const alarm = "grid";
const active = new Set(["open", "queued", "untriggered"]);
const backgroundModes = new Set(["running", "stopping", "closing"]);
const accountPaths = { account: "/v1/account", positions: "/v1/positions", orders: "/v1/orders", fills: "/v1/fills" };
let queue = Promise.resolve();

function serialize(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function save(grid) {
  await chrome.storage.local.set({ grid });
}

async function credentials() {
  const { key } = await chrome.storage.session.get("key");
  if (!key) throw Error("Подключите тестовый API-ключ.");
  return key;
}

async function updateAlarm(grid) {
  if (backgroundModes.has(grid.mode)) {
    if (!(await chrome.alarms.get(alarm))) await chrome.alarms.create(alarm, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(alarm);
  }
}

function config(input) {
  const strategy = input.strategy === "stress" ? "stress" : "grid";
  const symbol = input.symbol.trim().toUpperCase();
  const [lower, upper, levels, notional, target, slippage] =
    ["lower", "upper", "levels", "notional", "target", "slippage"].map((field) => Number(input[field]));
  if (!/^[A-Z0-9._-]{1,40}$/.test(symbol) ||
      ![notional, target, slippage].every(Number.isFinite) ||
      (strategy === "grid" && (![lower, upper].every(Number.isFinite) ||
      lower <= 0 || upper <= lower || !Number.isInteger(levels) || levels < 2 || levels > 50)) ||
      notional <= 0 || target < 100000 || target > 500000 ||
      notional > target / 2 || slippage <= 0 || slippage > 5) {
    throw Error("Проверьте границы, число уровней, номинал и проскальзывание.");
  }
  const continueStress = strategy === "stress" && input.continueStress === "on";
  return { strategy, continueStress, symbol, lower: lower || 0, upper: upper || 0, levels: levels || 0, notional, target, slippage };
}

function sizeFor(notional, price, rawStep) {
  const step = String(rawStep);
  if (!/^\d+(\.\d{1,12})?$/.test(step) || Number(step) <= 0) throw Error("API вернул неизвестный шаг количества.");
  const digits = step.split(".")[1]?.length ?? 0;
  const count = Math.floor(notional / price / Number(step));
  if (!Number.isSafeInteger(count) || count < 1) throw Error("Номинал меньше шага количества.");
  const units = (BigInt(step.replace(".", "")) * BigInt(count)).toString().padStart(digits + 1, "0");
  return digits ? units.slice(0, -digits) + "." + units.slice(-digits) : units;
}

function lookupPath(id) {
  return "/v1/orders?client_order_id=" + encodeURIComponent(id);
}

async function tick(grid) {
  if (!backgroundModes.has(grid.mode) || Date.now() < (grid.retryAt || 0)) return;
  try {
    const key = await credentials();
    if (key.publicKey !== grid.publicKey) throw Error("Подключите тот же ключ, которым запущена сетка.");
    const api = (method, path, body) => request(key, method, path, body);
    if (grid.pending) {
      const { pending } = grid;
      const path = lookupPath(pending.id);
      const { results } = await api("GET", path);
      const order = results[0];
      if (!order) {
        if (Date.now() - pending.since < 90000) return;
        throw Error("Исход заявки неизвестен. Сверьте её ID в Omni.");
      }
      if (active.has(order.status)) {
        if (grid.mode === "stopping" && order.status !== "queued") {
          try {
            await api("DELETE", path);
          } catch (error) {
            if (!["order_filled", "order_rejected", "order_queued"].includes(error.code)) throw error;
          }
        }
        return;
      }
      if (order.status === "filled") {
        const value = Number(order.size) * Number(order.fill_price);
        if (!(value > 0 && Number.isFinite(value))) throw Error("API вернул неизвестную цену или количество исполнения.");
        grid.volume += value;
        grid.fills += 1;
        if (pending.body.side === "buy") grid.position = { size: order.size, exit: pending.exit };
        else grid.position = null;
      } else if (!["canceled", "rejected"].includes(order.status)) {
        throw Error("Неизвестный статус " + order.status);
      }
      grid.pending = null;
      grid.note = order.status + (order.reason ? " · " + order.reason : "");
      if (grid.mode === "closing" || (order.status !== "filled" && grid.mode === "running")) {
        grid.mode = "paused";
        return;
      }
      await save(grid);
    }
    if (grid.mode === "stopping" || grid.mode === "paused") {
      grid.mode = "paused";
      grid.note = grid.position ? "Пауза. Позиция открыта." : "Пауза. Активной заявки бота нет.";
      return;
    }
    const { settings } = grid;
    if (!grid.position && !settings.continueStress && grid.volume >= settings.target) {
      grid.mode = "complete";
      grid.note = "Цель по исполненному обороту достигнута.";
      return;
    }

    const symbol = encodeURIComponent(settings.symbol);
    const id = "grid-" + crypto.randomUUID().replaceAll("-", "").slice(0, 28);
    const market = settings.strategy === "stress" || grid.mode === "closing";
    const body = {
      type: market ? "market" : "limit", symbol: settings.symbol,
      ...(!market && { trigger_by: "quote" }),
      max_slippage: String(settings.slippage / 100), client_order_id: id
    };
    let exit;
    if (grid.position) {
      Object.assign(body, { side: "sell", ...(!market && { price: grid.position.exit }), size: grid.position.size, reduce_only: true });
    } else {
      const tickData = await api("GET", "/v1/tickers/" + symbol);
      const mark = Number((tickData.result ?? tickData.ticker ?? tickData).mark_price);
      if (!(mark > 0 && Number.isFinite(mark))) throw Error("API не вернул mark price.");
      if (!market && (mark <= settings.lower || mark > settings.upper)) {
        grid.note = "Цена вне сетки. Ожидаю возврата в диапазон.";
        return;
      }
      let price = mark;
      if (!market) {
        const width = (settings.upper - settings.lower) / settings.levels;
        const step = Math.min(settings.levels - 1, Math.ceil((mark - settings.lower) / width) - 1);
        body.price = (settings.lower + width * step).toFixed(grid.precision);
        exit = (settings.lower + width * (step + 1)).toFixed(grid.precision);
        price = Number(body.price);
        if (!(price > 0 && Number(exit) > price && price < mark)) {
          throw Error("Уровни сетки слишком близки для доступной точности цены.");
        }
      }
      const size = sizeFor(settings.notional, price, grid.sizeStep);
      if (Number(size) * price < grid.minNotional) throw Error("Номинал меньше минимума инструмента.");
      Object.assign(body, { side: "buy", size });
    }

    grid.pending = { id, since: Date.now(), body, exit };
    grid.note = (body.side === "buy" ? "Покупка" : "Закрытие") + (market ? " по рынку" : " по " + body.price);
    await save(grid);
    try {
      await api("POST", "/v1/orders", body);
    } catch (error) {
      if (error.status >= 400 && error.status < 500 &&
          !["duplicate_client_order_id", "outcome_unknown", "request_timeout"].includes(error.code)) {
        grid.pending = null;
      }
      throw error;
    }
  } catch (error) {
    grid.note = error.message;
    if (error.status === 429 || error.status === 503 || (grid.pending && !error.status && /fetch|timeout|aborted/i.test(error.message))) {
      grid.retryAt = Date.now() + Math.max(30000, error.retry || 0);
    } else {
      grid.mode = "paused";
    }
  } finally {
    await save(grid);
    await updateAlarm(grid);
  }
}

async function command(message) {
  const { grid } = await chrome.storage.local.get("grid");
  if (message.action === "connect") {
    const key = {publicKey: normalizeKey(message.publicKey), seed: normalizeKey(message.seed)};
    if (grid?.pending || grid?.position || backgroundModes.has(grid?.mode)) {
      if (key.publicKey !== grid.publicKey) throw Error("В текущей сессии есть активная сетка или позиция. Нужен её ключ.");
    }
    const account = await request(key, "GET", "/v1/account");
    await chrome.storage.session.set({ key });
    return account;
  }
  if (Object.hasOwn(accountPaths, message.action)) return request(await credentials(), "GET", accountPaths[message.action]);
  if (message.action === "start") {
    if (grid?.pending || grid?.position || backgroundModes.has(grid?.mode)) {
      throw Error("Завершите текущую сетку или возобновите её.");
    }
    const key = await credentials();
    const settings = config(message.config);
    const symbol = encodeURIComponent(settings.symbol);
    const positions = await request(key, "GET", "/v1/positions");
    const openPositions = positions.results ?? positions.positions ?? positions;
    if (!Array.isArray(openPositions)) throw Error("Не удалось проверить открытые позиции по API.");
    if (openPositions.some((position) => position.symbol === settings.symbol)) {
      throw Error("На инструменте уже есть позиция. Выберите свободный рынок.");
    }
    const orders = await request(key, "GET", "/v1/orders?symbol=" + symbol);
    if (!Array.isArray(orders.results) || orders.results.length) {
      throw Error("На инструменте есть активные заявки или API не подтвердил их отсутствие.");
    }
    const data = await request(key, "GET", "/v1/instruments/" + symbol);
    const instrument = data.result ?? data.instrument ?? data;
    const precision = Number(instrument.price_precision);
    if (instrument.price_precision == null || !Number.isInteger(precision) || precision < 0 || precision > 12) {
      throw Error("API вернул неизвестную точность цены.");
    }
    if (settings.strategy === "grid") sizeFor(settings.notional, settings.upper, instrument.size_step);
    const next = {
      mode: "running", publicKey: key.publicKey, settings, precision,
      sizeStep: instrument.size_step, minNotional: Number(instrument.min_notional) || 0,
      volume: 0, fills: 0, note: "Сетка запущена."
    };
    await save(next);
    await updateAlarm(next);
    await tick(next);
    return;
  }
  if (!grid) throw Error("Сетка ещё не создана.");
  if (message.action === "stop") {
    grid.mode = grid.pending ? "stopping" : "paused";
    grid.note = grid.pending ? "Проверяю и отменяю заявку бота." : "Пауза.";
  } else if (message.action === "close") {
    if (grid.mode !== "paused" || grid.pending || !grid.position) throw Error("Сначала остановите сетку и подтвердите отмену заявки.");
    grid.mode = "closing";
    grid.note = "Закрываю позицию бота.";
  } else if (message.action === "resume") {
    if (grid.mode !== "paused") throw Error("Возобновление доступно после паузы.");
    if ((await credentials()).publicKey !== grid.publicKey) throw Error("Подключите ключ этой сетки.");
    grid.mode = "running";
    grid.note = "Сетка возобновлена.";
  } else if (message.action === "reset") {
    if (grid.mode !== "paused") throw Error("Сначала остановите сетку.");
    await chrome.storage.local.remove("grid");
    await chrome.alarms.clear(alarm);
    return;
  } else {
    throw Error("Неизвестная команда.");
  }
  await save(grid);
  await updateAlarm(grid);
  await tick(grid);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  serialize(() => command(message)).then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.message })
  );
  return true;
});

chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === alarm) serialize(async () => {
    const { grid } = await chrome.storage.local.get("grid");
    if (grid) await tick(grid);
    else await chrome.alarms.clear(alarm);
  }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  serialize(async () => {
    const { grid } = await chrome.storage.local.get("grid");
    if (grid && backgroundModes.has(grid.mode)) {
      grid.mode = "paused";
      grid.note = "Браузер перезапущен. Подключите ключ и проверьте заявку или позицию.";
      await save(grid);
    }
    await chrome.alarms.clear(alarm);
  }).catch(console.error);
});
