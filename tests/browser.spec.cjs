"use strict";
const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const KEY = "quiet-mahjong.v1";
const state = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
const tile = (page, id) => page.locator(`[data-tile="${id}"]`);
async function start(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator("#game-view")).toBeVisible();
}
async function clickPair(page, pair) {
  await tile(page, pair[0]).click();
  await tile(page, pair[1]).click();
  await expect(tile(page, pair[0])).toHaveCount(0);
  await expect(tile(page, pair[1])).toHaveCount(0);
}
async function fixture(page, modify) {
  const saved = await state(page);
  const replacement = await modify(saved);
  await injectSave(page, JSON.stringify(replacement || saved));
  await page.reload();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
}
async function injectSave(page, text) {
  // Install after unload persistence, before the next document reads its save.
  const marker = "fixture-" + Date.now() + "-" + Math.random();
  await page.addInitScript(({ key, text, marker }) => {
    if (!sessionStorage.getItem(marker)) {
      localStorage.setItem(key, text);
      sessionStorage.setItem(marker, "applied");
    }
  }, { key: KEY, text, marker });
}

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on("pageerror", error => page.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") page.errors.push(message.text()); });
});
test.afterEach(async ({ page }) => expect(page.errors).toEqual([]));

test("offline file opens without network, all menu controls work and settings persist", async ({ page, context, browserName }) => {
  const requests = [];
  page.on("request", request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  // WebKit's Windows offline emulation also rejects file:// itself. Block
  // network protocols instead, keeping local-file access available.
  if (browserName === "webkit") await context.route(/^https?:\/\//, route => route.abort());
  else await context.setOffline(true);
  await page.goto(pathToFileURL(path.resolve("index.html")).href);
  await expect(page.locator("#menu-title")).toHaveText("Маджонг");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Главное меню", exact: true }).click();
  await page.getByRole("button", { name: "Достижения", exact: true }).click();
  await expect(page.locator(".achievement")).toHaveCount(15);
  await expect(page.locator(".achievement.locked")).toHaveCount(15);
  await page.getByRole("button", { name: "Как играть", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Всё понятно" }).click();
  expect(requests).toEqual([]);
});

test("selection, hints, match, complete undo history, shuffle and reload", async ({ page }) => {
  await start(page);
  const initial = await state(page);
  const [a, b] = initial.game.solution[0];
  await tile(page, a).click();
  await expect(tile(page, a)).toHaveAttribute("aria-pressed", "true");
  await tile(page, a).click();
  await expect(tile(page, a)).toHaveAttribute("aria-pressed", "false");
  await page.locator("#hint-button").click();
  await expect(page.locator(".hinted")).toHaveCount(2);
  expect((await state(page)).game.hintsUsed).toBe(1);
  await clickPair(page, [a, b]);
  expect((await state(page)).game.score).toBe(100);
  await page.locator("#undo-button").click();
  await expect(page.locator("#board .tile")).toHaveCount(48);
  expect((await state(page)).game.score).toBe(0);
  await clickPair(page, [a, b]);
  expect((await state(page)).stats.totalPairs).toBe(1);
  const beforeShuffle = (await state(page)).game.tiles;
  await page.locator("#shuffle-button").click();
  expect((await state(page)).game.shufflesUsed).toBe(1);
  expect(await page.evaluate(key => {
    const g = JSON.parse(localStorage.getItem(key)).game;
    return Mahjong.verifySolution(g.tiles, g.solution);
  }, KEY)).toBe(true);
  await page.locator("#undo-button").click();
  expect((await state(page)).game.tiles).toEqual(beforeShuffle);
  await page.reload();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  expect((await state(page)).game.tiles).toEqual(beforeShuffle);
  expect((await state(page)).game.hintsUsed).toBe(1);
  expect((await state(page)).game.shufflesUsed).toBe(1);
  await page.locator("#undo-button").click();
  await expect(page.locator("#board .tile")).toHaveCount(48);
});

test("full victory awards bonuses once, persists records and advances the level", async ({ page }) => {
  await start(page);
  const initial = await state(page);
  for (const pair of initial.game.solution) await clickPair(page, pair);
  await expect(page.getByRole("button", { name: "Следующий уровень" })).toBeVisible();
  const won = await state(page);
  expect(won.game.status).toBe("won");
  expect(won.game.bonus).toBe(1000);
  expect(won.stats.wins).toBe(1);
  expect(won.stats.totalPairs).toBe(24);
  expect(won.records["1"].score).toBe(won.game.score);
  for (const id of ["first", "no-hints", "no-undo", "no-shuffle", "sprinter", "lightning", "combo5", "combo10"]) {
    expect(won.achievements[id]).toBeTruthy();
  }
  await page.reload();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  expect((await state(page)).stats.wins).toBe(1);
  await page.getByRole("button", { name: "Следующий уровень" }).click();
  await expect(page.locator("#board .tile")).toHaveCount(72);
  expect((await state(page)).level).toBe("2");
});

test("standard 144 tile board completes in certificate order", async ({ page, browserName }) => {
  test.setTimeout(browserName === "webkit" ? 300000 : 90000);
  await start(page);
  await fixture(page, async saved => {
    const deal = await page.evaluate(() => Mahjong.generate("4", 12345));
    saved.level = saved.game.level = "4";
    saved.game.tiles = deal.tiles;
    saved.game.solution = deal.solution;
  });
  await expect(page.locator("#board .tile")).toHaveCount(144);
  const saved = await state(page);
  for (const pair of saved.game.solution) await clickPair(page, pair);
  expect((await state(page)).game.status).toBe("won");
});

test("deadlock offers a certified shuffle and exhausted tools offer recovery", async ({ page }) => {
  await start(page);
  await fixture(page, saved => {
    saved.game.tiles = [
      { id: 0, x: 0, y: 0, z: 0, face: "d1", removed: false },
      { id: 1, x: 0, y: 0, z: 1, face: "d1", removed: false }
    ];
    saved.game.solution = [[0, 1]];
  });
  await expect(page.getByRole("heading", { name: "Нужен новый ход" })).toBeVisible();
  await page.getByRole("button", { name: "Перемешать · осталось 2" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(key => {
    const g = JSON.parse(localStorage.getItem(key)).game;
    return Mahjong.verifySolution(g.tiles, g.solution);
  }, KEY)).toBe(true);
  await page.locator("#undo-button").click();
  await expect(page.getByRole("heading", { name: "Нужен новый ход" })).toBeVisible();
  await page.getByRole("button", { name: "Перемешать · осталось 1" }).click();
  await page.locator("#undo-button").click();
  await expect(page.getByText("Перемешивания закончились.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Начать уровень заново", exact: true }).click();
  await page.getByRole("button", { name: "Перезапустить уровень", exact: true }).click();
  await expect(page.locator("#board .tile")).toHaveCount(48);
});

test("tool limits, restart confirmation and progress-reset confirmation are enforced", async ({ page }) => {
  await start(page);
  for (let i = 0; i < 3; i++) await page.locator("#hint-button").click();
  await expect(page.locator("#hint-button")).toBeDisabled();
  for (let i = 0; i < 2; i++) await page.locator("#shuffle-button").click();
  await expect(page.locator("#shuffle-button")).toBeDisabled();
  await page.getByRole("button", { name: "Заново", exact: true }).click();
  await page.getByRole("button", { name: "Продолжить партию", exact: true }).click();
  expect((await state(page)).game.shufflesUsed).toBe(2);
  await page.getByRole("button", { name: "Заново", exact: true }).click();
  await page.getByRole("button", { name: "Перезапустить уровень", exact: true }).click();
  expect((await state(page)).game.shufflesUsed).toBe(0);
  expect((await state(page)).game.hintsUsed).toBe(0);
  await page.getByRole("button", { name: "Меню", exact: true }).click();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await page.getByRole("button", { name: "Оставить прогресс", exact: true }).click();
  expect((await state(page)).game).not.toBeNull();
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await page.getByRole("button", { name: "Да, удалить весь прогресс", exact: true }).click();
  expect((await state(page)).game).toBeNull();
  expect((await state(page)).level).toBe("1");
});

test("bamboo seven and eight are visually distinct and still obey matching rules", async ({ page }) => {
  await start(page);
  await fixture(page, saved => {
    saved.game.tiles = ["b7", "b7", "b8", "b8"].map((face, id) => ({
      id, x: id * 2, y: 0, z: 0, face, removed: false
    }));
    saved.game.solution = [[0, 1], [2, 3]];
  });
  const stalks = id => tile(page, id).locator("svg path").evaluateAll(paths => paths.map(p => p.getAttribute("d")));
  expect(new Set(await stalks(0)).size).toBe(7);
  expect(new Set(await stalks(2)).size).toBe(8);
  await tile(page, 0).click();
  await tile(page, 2).click();
  await expect(page.locator("#board .tile")).toHaveCount(4);
  await expect(tile(page, 2)).toHaveAttribute("aria-pressed", "true");
  await tile(page, 3).click();
  await expect(page.locator("#board .tile")).toHaveCount(2);
});

test("suspended tabs and back-forward cache time never count as active play", async ({ page }) => {
  await page.addInitScript(() => {
    window.testClock = { now: 0, hidden: false };
    Object.defineProperty(performance, "now", { value: () => window.testClock.now });
    Object.defineProperty(document, "hidden", { get: () => window.testClock.hidden });
    // Suspending intervals models a background tab frozen by the browser.
    window.setInterval = callback => { window.testTick = callback; return 1; };
  });
  await start(page);
  const elapsed = await page.evaluate(key => {
    const read = () => {
      window.dispatchEvent(new Event("beforeunload"));
      return JSON.parse(localStorage.getItem(key)).game.elapsed;
    };
    const result = [];
    testClock.now = 1000; testTick(); result.push(read());
    testClock.now = 1250; testClock.hidden = true;
    document.dispatchEvent(new Event("visibilitychange")); result.push(read());
    testClock.now = 61250; testClock.hidden = false;
    document.dispatchEvent(new Event("visibilitychange")); result.push(read());
    testClock.now = 62250; testTick(); result.push(read());
    testClock.now = 62500;
    window.dispatchEvent(new Event("pagehide")); result.push(read());
    testClock.now = 122500;
    window.dispatchEvent(new Event("pageshow")); result.push(read());
    testClock.now = 123000; testTick(); result.push(read());
    return result;
  }, KEY);
  expect(elapsed).toEqual([1000, 1250, 1250, 2250, 2500, 2500, 3000]);
});

test("legacy saved games restart with their original layout and tile identities", async ({ page }) => {
  await start(page);
  let original;
  await fixture(page, async saved => {
    original = await page.evaluate(() => Mahjong.generate("100", 12345, 1));
    saved.level = saved.game.level = "100";
    saved.game.seed = 12345;
    saved.game.tiles = original.tiles;
    saved.game.solution = original.solution;
    delete saved.game.generatorVersion;
  });
  await clickPair(page, original.solution[0]);
  await page.getByRole("button", { name: "Заново", exact: true }).click();
  await page.getByRole("button", { name: "Перезапустить уровень", exact: true }).click();
  const saved = await state(page);
  expect(saved.game.tiles).toEqual(original.tiles);
  expect(saved.game.solution).toEqual(original.solution);
  expect(saved.game.generatorVersion).toBe(1);
});

test("new late-game layouts fit, save and remain solvable after restarting", async ({ page }) => {
  await start(page);
  for (const level of ["50", "100", "1000"]) {
    let original;
    await fixture(page, async saved => {
      original = await page.evaluate(level => Mahjong.generate(level, 42), level);
      saved.level = saved.game.level = level;
      saved.game.seed = 42;
      saved.game.generatorVersion = 2;
      saved.game.tiles = original.tiles;
      saved.game.solution = original.solution;
    });
    await expect.poll(() => page.evaluate(() => {
      const viewport = document.getElementById("board-viewport").getBoundingClientRect();
      return [...document.querySelectorAll("#board .tile")].every(el => {
        const tile = el.getBoundingClientRect();
        return tile.left >= viewport.left && tile.right <= viewport.right && tile.top >= viewport.top && tile.bottom <= viewport.bottom;
      });
    })).toBe(true);
    await page.getByRole("button", { name: "Заново", exact: true }).click();
    await page.getByRole("button", { name: "Перезапустить уровень", exact: true }).click();
    expect((await state(page)).game.tiles).toEqual(original.tiles);
    await page.reload();
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    expect((await state(page)).game.tiles).toEqual(original.tiles);
  }
});

test("clock pauses in menus and dialogs; keyboard controls remain usable", async ({ page }) => {
  await start(page);
  await page.waitForTimeout(1100);
  await page.keyboard.press("Escape");
  const paused = (await state(page)).game.elapsed;
  expect(paused).toBeGreaterThan(900);
  await page.waitForTimeout(1100);
  expect((await state(page)).game.elapsed).toBe(paused);
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#board .free:focus")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator(".selected")).toHaveCount(1);
  await page.keyboard.press("KeyH");
  expect((await state(page)).game.hintsUsed).toBe(1);
  await page.getByRole("button", { name: "Как играть", exact: true }).click();
  const timerText = await page.locator("#timer").textContent();
  await page.waitForTimeout(1100);
  expect(await page.locator("#timer").textContent()).toBe(timerText);
});

test("achievement thresholds and legend are persistent, including the hidden achievement", async ({ page }) => {
  await start(page);
  await fixture(page, saved => {
    saved.level = saved.game.level = "50";
    saved.stats.wins = saved.stats.streak = 4;
    saved.stats.totalPairs = 999;
    const ids = ["first", "no-hints", "no-undo", "no-shuffle", "sprinter", "lightning", "combo5", "combo10", "level10", "level25"];
    for (const id of ids) saved.achievements[id] = "2026-01-01T00:00:00.000Z";
    saved.game.tiles = [
      { id: 0, x: 0, y: 0, z: 0, face: "f1", removed: true },
      { id: 1, x: 1, y: 0, z: 0, face: "f2", removed: true },
      { id: 2, x: 2, y: 0, z: 0, face: "f3", removed: false },
      { id: 3, x: 3, y: 0, z: 0, face: "f4", removed: false }
    ];
    saved.game.solution = [[2, 3]];
    saved.game.peakPairs = 1;
  });
  await clickPair(page, [2, 3]);
  const saved = await state(page);
  expect(saved.stats.totalPairs).toBe(1000);
  expect(Object.keys(saved.achievements)).toHaveLength(15);
  for (const id of ["streak", "level50", "pairs1000", "garden", "legend"]) expect(saved.achievements[id]).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Достижения", exact: true }).click();
  await expect(page.locator(".achievement time")).toHaveCount(15);
});

test("invalid saves and blocked localStorage are reported rather than crashing", async ({ page }) => {
  await page.goto("/");
  await injectSave(page, "{broken");
  await page.reload();
  await expect(page.locator("#storage-warning")).toContainText("повреждено");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator("#board .tile")).toHaveCount(48);
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Blocked", "SecurityError"); };
    Storage.prototype.setItem = () => { throw new DOMException("Blocked", "SecurityError"); };
  });
  await page.reload();
  await expect(page.locator("#storage-warning")).toContainText("запретил");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.locator("#board .tile")).toHaveCount(48);
  await expect(page.locator("#storage-warning")).toContainText("Не удалось сохранить");
});

test("menu and board fit the viewport; mobile zoom and touch work", async ({ page }, testInfo) => {
  await page.goto("/");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(await overflow()).toBe(false);
  const takeScreenshot = async name => {
    if (!process.env.MAHJONG_ARTIFACTS || !["chromium", "mobile"].includes(testInfo.project.name)) return;
    fs.mkdirSync(process.env.MAHJONG_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.MAHJONG_ARTIFACTS, `${testInfo.project.name}-${name}.jpg`), type: "jpeg", quality: 65 });
  };
  await takeScreenshot("menu");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await fixture(page, async saved => {
    const deal = await page.evaluate(() => Mahjong.generate("16", 42));
    saved.level = saved.game.level = "16";
    saved.game.tiles = deal.tiles;
    saved.game.solution = deal.solution;
  });

  expect(await overflow()).toBe(false);
  await expect.poll(() => page.evaluate(() => {
    const viewport = document.getElementById("board-viewport").getBoundingClientRect();
    return [...document.querySelectorAll("#board .tile")].every(el => {
      const tile = el.getBoundingClientRect();
      return tile.left >= viewport.left && tile.right <= viewport.right && tile.top >= viewport.top && tile.bottom <= viewport.bottom;
    });
  })).toBe(true);
  const metrics = await page.evaluate(() => {
    const viewport = document.getElementById("board-viewport").getBoundingClientRect();
    const tiles = [...document.querySelectorAll("#board .tile")].map(el => el.getBoundingClientRect());
    return { viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom }, tiles: tiles.map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width })) };
  });
  for (const tile of metrics.tiles) {
    expect(tile.left).toBeGreaterThanOrEqual(metrics.viewport.left);
    expect(tile.right).toBeLessThanOrEqual(metrics.viewport.right);
    expect(tile.top).toBeGreaterThanOrEqual(metrics.viewport.top);
    expect(tile.bottom).toBeLessThanOrEqual(metrics.viewport.bottom);
    expect(tile.width).toBeGreaterThan(23);
  }
  await takeScreenshot("board");
  await page.locator("#zoom-button").click();
  await expect(page.locator("#zoom-button")).toHaveAttribute("aria-pressed", "true");
  expect(await overflow()).toBe(false);
  await page.locator("#zoom-button").click();
  if (testInfo.project.name === "mobile") {
    const pair = (await state(page)).game.solution[0];
    await tile(page, pair[0]).tap();
    await tile(page, pair[1]).tap();
    await expect(page.locator("#board .tile")).toHaveCount(142);
  }
});

test("board dimensions and scrollbar state settle at every size, in both zoom modes", async ({ page }) => {
  await start(page);
  await fixture(page, async saved => {
    const deal = await page.evaluate(() => Mahjong.generate("16", 42));
    saved.level = saved.game.level = "16";
    saved.game.tiles = deal.tiles;
    saved.game.solution = deal.solution;
  });
  for (const width of [375, 414, 768, 1000, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const zoomed of [false, true]) {
      if (zoomed) await page.locator("#zoom-button").click();
      const samples = await page.evaluate(async () => {
        const samples = [];
        const viewport = document.getElementById("board-viewport");
        const board = document.getElementById("board");
        for (let i = 0; i < 30; i++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const rect = board.getBoundingClientRect();
          samples.push({
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            clientWidth: viewport.clientWidth, clientHeight: viewport.clientHeight,
            scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight
          });
        }
        return samples;
      });
      expect(new Set(samples.slice(5).map(s => JSON.stringify(s))).size).toBe(1);
      if (!zoomed) {
        const last = samples.at(-1);
        expect(last.scrollWidth).toBe(last.clientWidth);
        expect(last.scrollHeight).toBe(last.clientHeight);
      }
    }
    await page.locator("#zoom-button").click();
  }
});

test("normal-motion removal saves atomically and victory starts confetti", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await start(page);
  await fixture(page, saved => {
    saved.game.tiles = [
      { id: 0, x: 0, y: 0, z: 0, face: "d1", removed: false },
      { id: 1, x: 1, y: 0, z: 0, face: "d1", removed: false }
    ];
    saved.game.solution = [[0, 1]];
  });
  await tile(page, 0).click();
  await tile(page, 1).click();
  expect((await state(page)).game.status).toBe("won");
  await expect(page.locator("#confetti")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Следующий уровень" })).toBeVisible();
  expect((await state(page)).stats.wins).toBe(1);
});

test("malformed structured saves are rejected before resuming gameplay", async ({ page }) => {
  await start(page);
  for (const value of [true, [], { "1": { score: "bad", time: 0 } }]) {
    const saved = await state(page);
    saved.records = value;
    await injectSave(page, JSON.stringify(saved));
    await page.reload();
    await expect(page.locator("#storage-warning")).toContainText("повреждено");
    await page.getByRole("button", { name: "Продолжить", exact: true }).click();
    await expect(page.locator("#board .tile")).toHaveCount(48);
  }
});
